// MoxMox relay server — Cloudflare Worker + Durable Object.
//
// Routes WebSocket connections and room metadata requests to per-room Durable
// Objects. Shared Deck rooms are two-player rooms; Traditional rooms are
// explicitly created with a maximum of 2-4 reserved player seats.

const GAME_TYPE_SHARED = 'shared';
const GAME_TYPE_TRADITIONAL = 'traditional';
const VALID_GAME_TYPES = new Set([GAME_TYPE_SHARED, GAME_TYPE_TRADITIONAL]);
const TRADITIONAL_ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_MESSAGE_BYTES = 65536;

// ── Security limits ─────────────────────────────────────────────────
const MAX_CONNECTIONS_PER_ROOM = 10;
const RATE_LIMIT_MAX_TOKENS = 5;
const RATE_LIMIT_REFILL_PER_SEC = 5;
const MIN_PLAYER_KEY_LENGTH = 16;
const MAX_USERNAME_LENGTH = 32;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Allowed relay fields per message type (prevents arbitrary field injection).
const RELAY_FIELDS = {
  'zone-sync': new Set(['action', 'zone', 'cardId', 'syncId', 'pctX', 'pctY',
    'fromZone', 'toZone', 'updates', 'syncIds', 'cards', 'targetId', 'gift']),
  'life-sync': new Set(['life']),
  'hand-count-sync': new Set(['handCount']),
  'game-init': new Set(['library']),
  'game-ready': new Set(['drawnCount']),
  'game-start': new Set([]),
  'drawCard': new Set([]),
  'discard': new Set([]),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check.
    if (url.pathname === '/') {
      return new Response('MoxMox Relay Server OK', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Route: /room/:roomId and /room/:roomId/info.
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})(?:\/info)?$/);
    if (!match) {
      return json({ error: 'Not found. Use /room/<roomId>' }, 404);
    }

    const roomId = match[1];
    const id = env.ROOM.idFromName(roomId);
    const room = env.ROOM.get(id);
    return room.fetch(request);
  },
};

// Valid message types that will be relayed.
const VALID_TYPES = new Set([
  'drawCard', 'discard', 'join', 'ping', 'leave',
  'game-init', 'game-ready', 'game-start',
  'zone-sync', 'life-sync', 'hand-count-sync',
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function normalizeGameType(value) {
  return VALID_GAME_TYPES.has(value) ? value : GAME_TYPE_SHARED;
}

function validateMaxPlayers(value) {
  return Number.isInteger(value) && value >= 2 && value <= 4;
}

function playerIdForIndex(index) {
  return `p${index + 1}`;
}

/** Build a relay-safe copy of a parsed message, keeping only whitelisted fields. */
function sanitizeRelayMessage(parsed) {
  const allowed = RELAY_FIELDS[parsed.type];
  if (!allowed) return null;
  const clean = { type: parsed.type };
  for (const key of allowed) {
    if (key in parsed) clean[key] = parsed[key];
  }
  return clean;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.metadata = null;
    this.playerRecords = null;
  }

  async loadMetadata() {
    if (this.metadata === null) {
      this.metadata = (await this.state.storage.get('metadata')) || null;
    }
    return this.metadata;
  }

  async saveMetadata(metadata) {
    this.metadata = metadata;
    await this.state.storage.put('metadata', metadata);
  }

  async loadPlayerRecords() {
    if (this.playerRecords !== null) return this.playerRecords;

    const records = await this.state.storage.get('playerRecords');
    if (records) {
      this.playerRecords = records;
      return this.playerRecords;
    }

    // Backward compatibility with existing rooms that only stored keys.
    const legacyKeys = (await this.state.storage.get('playerKeys')) || [];
    this.playerRecords = legacyKeys.map((playerKey, index) => ({
      playerKey,
      playerId: playerIdForIndex(index),
      username: 'Anonymous',
    }));
    if (legacyKeys.length > 0) {
      await this.savePlayerRecords();
    }
    return this.playerRecords;
  }

  async savePlayerRecords() {
    await this.state.storage.put('playerRecords', this.playerRecords);
    await this.state.storage.put('playerKeys', this.playerRecords.map(p => p.playerKey));
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return json({ ok: true });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.acceptWebSocket();
    }

    if (request.method === 'POST') {
      return this.createTraditionalRoom(request);
    }

    if (request.method === 'GET') {
      return this.getRoomInfoResponse();
    }

    return json({ error: 'Method not allowed' }, 405);
  }

  async createTraditionalRoom(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Expected JSON body' }, 400);
    }

    if (body?.gameType !== GAME_TYPE_TRADITIONAL) {
      return json({ error: 'Only Traditional rooms can be explicitly created' }, 400);
    }
    if (!validateMaxPlayers(body.maxPlayers)) {
      return json({ error: 'maxPlayers must be 2, 3, or 4' }, 400);
    }

    const roomId = new URL(request.url).pathname.split('/')[2] || '';
    if (!TRADITIONAL_ROOM_RE.test(roomId)) {
      return json({ error: 'Traditional room code must be 6 uppercase non-ambiguous characters' }, 400);
    }

    const existing = await this.loadMetadata();
    if (existing) {
      return json({ error: 'Room already exists' }, 409);
    }

    const metadata = {
      gameType: GAME_TYPE_TRADITIONAL,
      maxPlayers: body.maxPlayers,
      createdAt: Date.now(),
    };
    await this.saveMetadata(metadata);
    await this.touchActivity();
    return json(await this.buildRoomInfo(metadata), 201);
  }

  async getRoomInfoResponse() {
    let metadata = await this.loadMetadata();
    const records = await this.loadPlayerRecords();

    if (!metadata && records.length === 0) {
      return json({ error: 'Room not found' }, 404);
    }

    if (!metadata) {
      metadata = {
        gameType: GAME_TYPE_SHARED,
        maxPlayers: 2,
        createdAt: Date.now(),
      };
      await this.saveMetadata(metadata);
    }

    return json(await this.buildRoomInfo(metadata));
  }

  async acceptWebSocket() {
    // Per-room connection cap.
    const allSockets = this.state.getWebSockets();
    if (allSockets.length >= MAX_CONNECTIONS_PER_ROOM) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      try {
        server.send(JSON.stringify({
          type: 'system',
          text: 'Room connection limit reached.',
          rejected: true,
        }));
      } catch (_) {}
      server.close(4005, 'Connection limit');
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with the Hibernation API so idle rooms don't burn CPU.
    this.state.acceptWebSocket(server);

    // The socket is not yet authenticated — it must send a 'join' with
    // a playerKey. We store a temporary attachment to mark it as pending.
    server.serializeAttachment({ playerKey: null, authenticated: false });

    const authedCount = this.getAuthenticatedSockets().length;
    try {
      server.send(JSON.stringify({
        type: 'system',
        text: 'Connected to room. Send join with playerKey to authenticate.',
        peerCount: authedCount,
      }));
    } catch (_) {}

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Get only authenticated sockets. */
  getAuthenticatedSockets() {
    return this.state.getWebSockets().filter(ws => {
      try {
        const att = ws.deserializeAttachment();
        return att?.authenticated === true;
      } catch {
        return false;
      }
    });
  }

  getAuthenticatedAttachments() {
    const attachments = [];
    for (const ws of this.getAuthenticatedSockets()) {
      try {
        attachments.push({ ws, att: ws.deserializeAttachment() });
      } catch (_) {}
    }
    return attachments;
  }

  async buildRoomInfo(metadata = null, excludeWs = null) {
    metadata ||= await this.loadMetadata();
    const records = await this.loadPlayerRecords();
    const activeIds = new Set(
      this.getAuthenticatedAttachments()
        .filter(({ ws }) => ws !== excludeWs)
        .map(({ att }) => att.playerId),
    );

    const players = records.map(record => ({
      id: record.playerId,
      username: record.username || 'Anonymous',
      connected: activeIds.has(record.playerId),
    }));

    return {
      exists: true,
      gameType: metadata?.gameType || GAME_TYPE_SHARED,
      maxPlayers: metadata?.maxPlayers || 2,
      shareBattlefield: metadata?.shareBattlefield !== false,
      shareGraveyardExile: metadata?.shareGraveyardExile !== false,
      playerCount: players.filter(p => p.connected).length,
      seatCount: players.length,
      full: players.length >= (metadata?.maxPlayers || 2),
      players,
    };
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message.length > MAX_MESSAGE_BYTES) return;

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (_) {
      return;
    }

    if (!parsed.type || !VALID_TYPES.has(parsed.type)) return;

    // Handle join with authentication.
    if (parsed.type === 'join') {
      await this.handleJoin(ws, parsed);
      return;
    }

    if (parsed.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', t: parsed.t || Date.now() })); } catch (_) {}
      return;
    }

    if (parsed.type === 'leave') {
      await this.handleLeave(ws);
      return;
    }

    // Only relay from authenticated sockets.
    const att = ws.deserializeAttachment();
    if (!att?.authenticated) return;

    // Rate limiting (token bucket).
    if (!this.checkRateLimit(ws, att)) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'rate_limited', text: 'Too many messages. Please slow down.' }));
      } catch (_) {}
      return;
    }

    // Sanitize: only relay whitelisted fields per message type.
    const sanitized = sanitizeRelayMessage(parsed);
    if (!sanitized) return;

    const outbound = {
      ...sanitized,
      senderId: att.playerId,
      username: att.username || 'Anonymous',
    };

    if (sanitized.type === 'zone-sync' && sanitized.targetId) {
      this.sendToTarget(ws, sanitized.targetId, outbound);
      return;
    }

    this.broadcastExcept(ws, outbound);
  }

  /** Token bucket rate limiter. Returns true if the message is allowed. */
  checkRateLimit(ws, att) {
    const now = Date.now();
    let tokens = att.rlTokens ?? RATE_LIMIT_MAX_TOKENS;
    const lastRefill = att.rlLastRefill ?? now;

    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(RATE_LIMIT_MAX_TOKENS, tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);

    if (tokens < 1) {
      att.rlTokens = tokens;
      att.rlLastRefill = now;
      ws.serializeAttachment(att);
      return false;
    }

    att.rlTokens = tokens - 1;
    att.rlLastRefill = now;
    ws.serializeAttachment(att);
    return true;
  }

  async handleJoin(ws, parsed) {
    const playerKey = parsed.playerKey;

    if (!playerKey || typeof playerKey !== 'string' || playerKey.length < MIN_PLAYER_KEY_LENGTH) {
      this.rejectJoin(ws, 'Join rejected: invalid playerKey.', 4001, 'Invalid playerKey');
      return;
    }

    const requestedType = normalizeGameType(parsed.gameType);
    let metadata = await this.loadMetadata();
    const records = await this.loadPlayerRecords();

    if (!metadata) {
      if (requestedType === GAME_TYPE_TRADITIONAL) {
        this.rejectJoin(ws, 'Join rejected: Traditional room does not exist.', 4004, 'Room not found');
        return;
      }
      metadata = {
        gameType: GAME_TYPE_SHARED,
        maxPlayers: 2,
        shareBattlefield: parsed.shareBattlefield !== false,
        shareGraveyardExile: parsed.shareGraveyardExile !== false,
        createdAt: Date.now(),
      };
      await this.saveMetadata(metadata);
    }

    // Populate shared deck settings from the host if missing (backward compat).
    if (metadata.gameType === GAME_TYPE_SHARED && !('shareBattlefield' in metadata)) {
      metadata.shareBattlefield = parsed.shareBattlefield !== false;
      metadata.shareGraveyardExile = parsed.shareGraveyardExile !== false;
      await this.saveMetadata(metadata);
    }

    if (metadata.gameType !== requestedType) {
      this.rejectJoin(ws, 'Join rejected: room type mismatch.', 4003, 'Room type mismatch');
      return;
    }

    const recordIndex = records.findIndex(p => p.playerKey === playerKey);
    let record = recordIndex >= 0 ? records[recordIndex] : null;

    if (!record && records.length >= metadata.maxPlayers) {
      this.rejectJoin(
        ws,
        `Room is full. Only ${metadata.maxPlayers} players allowed.`,
        4002,
        'Room full',
      );
      return;
    }

    const username = (parsed.username || 'Anonymous').slice(0, MAX_USERNAME_LENGTH);
    if (!record) {
      record = {
        playerKey,
        playerId: playerIdForIndex(records.length),
        username,
      };
      records.push(record);
    } else {
      record.username = username;
    }
    this.playerRecords = records;
    await this.savePlayerRecords();

    // Reset room TTL on join.
    await this.touchActivity();

    ws.serializeAttachment({
      playerKey,
      authenticated: true,
      username,
      playerId: record.playerId,
      gameType: metadata.gameType,
    });

    const info = await this.buildRoomInfo(metadata);

    // Notify the joining player.
    ws.send(JSON.stringify({
      type: 'system',
      text: `Joined room. ${info.playerCount} player(s) here.`,
      peerCount: info.playerCount,
      seatCount: info.seatCount,
      maxPlayers: info.maxPlayers,
      gameType: info.gameType,
      shareBattlefield: info.shareBattlefield,
      shareGraveyardExile: info.shareGraveyardExile,
      playerId: record.playerId,
      players: info.players,
    }));

    // Keep backward compatibility by sending existing players as join messages.
    for (const { ws: s, att } of this.getAuthenticatedAttachments()) {
      if (s !== ws) {
        try {
          ws.send(JSON.stringify({
            type: 'join',
            senderId: att.playerId,
            username: att.username || 'Anonymous',
            players: info.players,
          }));
        } catch (_) {}
      }
    }

    // Notify existing players about the new arrival and full player list.
    const systemMsg = {
      type: 'system',
      text: `Player joined. ${info.playerCount} player(s) in room.`,
      peerCount: info.playerCount,
      seatCount: info.seatCount,
      maxPlayers: info.maxPlayers,
      gameType: info.gameType,
      shareBattlefield: info.shareBattlefield,
      shareGraveyardExile: info.shareGraveyardExile,
      players: info.players,
    };
    this.broadcastExcept(ws, systemMsg);

    const relayMsg = {
      type: 'join',
      senderId: record.playerId,
      username,
      players: info.players,
    };
    this.broadcastExcept(ws, relayMsg);
  }

  rejectJoin(ws, text, code, reason) {
    try {
      ws.send(JSON.stringify({
        type: 'system',
        text,
        rejected: true,
      }));
    } catch (_) {}
    ws.close(code, reason);
  }

  async handleLeave(ws) {
    const att = (() => {
      try { return ws.deserializeAttachment(); } catch { return null; }
    })();
    if (!att?.authenticated) {
      ws.close(1000, 'Not authenticated');
      return;
    }

    // Remove the player record to free the seat.
    const records = await this.loadPlayerRecords();
    const index = records.findIndex(p => p.playerKey === att.playerKey);
    if (index >= 0) {
      records.splice(index, 1);
      this.playerRecords = records;
      await this.savePlayerRecords();
    }

    // Mark as intentionally left so webSocketClose skips its broadcast.
    ws.serializeAttachment({ ...att, left: true });

    const metadata = await this.loadMetadata();
    const info = metadata ? await this.buildRoomInfo(metadata, ws) : null;

    const leaveMsg = {
      type: 'system',
      text: `Player left the game. ${info?.playerCount || 0} player(s) in room.`,
      peerCount: info?.playerCount || 0,
      seatCount: info?.seatCount || 0,
      maxPlayers: info?.maxPlayers,
      gameType: info?.gameType,
      leftPlayerId: att.playerId,
      left: true,
      players: info?.players,
    };
    this.broadcastExcept(ws, leaveMsg);

    ws.close(1000, 'Left game');
  }

  broadcastExcept(sender, msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.getAuthenticatedSockets()) {
      if (s !== sender) {
        try { s.send(raw); } catch (_) {}
      }
    }
  }

  sendToTarget(sender, targetId, msg) {
    const raw = JSON.stringify(msg);
    for (const { ws, att } of this.getAuthenticatedAttachments()) {
      if (ws !== sender && att.playerId === targetId) {
        try { ws.send(raw); } catch (_) {}
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = (() => {
      try { return ws.deserializeAttachment(); } catch { return null; }
    })();

    // Skip broadcast if the player already sent a leave message.
    if (att?.left) {
      ws.close(code, reason);
      return;
    }

    const metadata = await this.loadMetadata();
    const info = metadata ? await this.buildRoomInfo(metadata, ws) : null;
    const remaining = this.getAuthenticatedSockets().filter(s => s !== ws);

    const leaveMsg = JSON.stringify({
      type: 'system',
      text: `Player disconnected. ${Math.max(0, remaining.length)} player(s) in room.`,
      peerCount: Math.max(0, remaining.length),
      seatCount: info?.seatCount,
      maxPlayers: info?.maxPlayers,
      gameType: info?.gameType,
      leftPlayerId: att?.playerId,
      players: info?.players,
    });

    for (const s of remaining) {
      try { s.send(leaveMsg); } catch (_) {}
    }

    ws.close(code, reason);
  }

  // ── Room TTL ─────────────────────────────────────────────────────────

  async touchActivity() {
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    // If anyone is still connected, reschedule.
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0) {
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    // No connections — clean up the room.
    await this.state.storage.deleteAll();
    this.metadata = null;
    this.playerRecords = null;
  }

  async webSocketError(ws, error) {
    ws.close(1011, 'WebSocket error');
  }
}
