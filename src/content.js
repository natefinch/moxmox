// MoxMox content script — runs in the ISOLATED world.
//
// Handles UI injection, WebSocket connection, game start flow, and
// ongoing zone sync for the "Play Together" feature.

import {
  generateRoomId,
  generateTraditionalRoomCode,
  isTraditionalRoomCode,
  buildShareUrl,
  extractRoomId,
  stripRoomParam,
  isGoldfishPage,
} from './shared/room.js';

const WS_URL = 'wss://moxmox-relay.nate-finch.workers.dev';
const HTTP_URL = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const SESSION_KEY = 'moxmox_room';
const SESSION_ROLE_KEY = 'moxmox_role';
const SESSION_PLAYER_KEY = 'moxmox_player_key';
const SESSION_GAME_TYPE_KEY = 'moxmox_game_type';
const SESSION_SHARE_BF_KEY = 'moxmox_share_battlefield';
const SESSION_SHARE_GY_KEY = 'moxmox_share_gy_exile';
const MSG_TAG = 'moxmox';
const SHARED_ZONES = new Set(['library', 'graveyard', 'exile']);
const GAME_TYPE_SHARED = 'shared';
const GAME_TYPE_TRADITIONAL = 'traditional';
const WS_HEARTBEAT_MS = 25000;
const WS_RECONNECT_MS = 2000;
const URL_CHECK_MS = 500;
const GIFT_RETURN_ZONES = new Set(['hand', 'graveyard', 'exile', 'library']);

// ── State ───────────────────────────────────────────────────────────

let ws = null;
let currentRoomId = null;
let localDot = null;
let remoteDot = null;
let localNameEl = null;
let playerGridEl = null;
let remotePlayerRow = null;
let remoteNameEl = null;
let localLifeEl = null;
let localHandCountEl = null;
let remoteLifeEl = null;
let localHandCount = null;
let showLifeDisplay = true;
let cardViewerZoom = 1.0;
let menuEl = null;
let popupBackdrop = null;
let role = null;         // 'host' or 'guest'
let gameType = null;     // 'shared' or 'traditional'
let maxPlayers = null;
let shareBattlefield = true;   // shared deck: mirror cards on opponent's battlefield
let shareGraveyardExile = true; // shared deck: sync graveyard and exile zones
let localPlayerId = null;
let localStatus = 'disconnected';
let remoteStatus = 'disconnected';
let remoteUsername = null;
let remotePlayers = new Map();
let gameStarted = false;   // true only after Start button is clicked (sync active)
let gameSetupDone = false; // true once the game-start handshake completes
let gameModal = null;
let playerKey = null;      // unique secret for this tab's player slot
let traditionalLifeInitialized = false;
let pendingSharedInvite = null; // { shareUrl } — set during shared deck creation
let heartbeatTimer = null;
let reconnectTimer = null;
let intentionalDisconnect = false;
let initialized = false;
let lastSeenUrl = window.location.href;
const messageLog = [];

/** Generate a unique playerKey for this tab. */
function getOrCreatePlayerKey() {
  if (playerKey) return playerKey;
  // Check sessionStorage — survives refresh of the same tab.
  const stored = sessionStorage.getItem(SESSION_PLAYER_KEY);
  if (stored) {
    playerKey = stored;
    return playerKey;
  }
  // Generate fresh. Use crypto for uniqueness.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  playerKey = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
  sessionStorage.setItem(SESSION_PLAYER_KEY, playerKey);
  return playerKey;
}

function ensureUsername(onComplete) {
  chrome.storage.local.get('moxmox_username', (result) => {
    const username = result.moxmox_username?.trim();
    if (!username) {
      showUsernamePrompt(() => {
        refreshLocalUsername();
        onComplete();
      });
      return;
    }
    onComplete();
  });
}

function resetRoomState(nextGameType) {
  intentionalDisconnect = true;
  stopHeartbeat();
  clearReconnectTimer();
  clearSendThrottle();
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  playerKey = null;
  localPlayerId = null;
  maxPlayers = null;
  shareBattlefield = true;
  shareGraveyardExile = true;
  localHandCount = null;
  remotePlayers = new Map();
  traditionalLifeInitialized = false;
  gameStarted = false;
  gameSetupDone = false;
  setRemotePlayersDisplay([]);
  syncGiftStateToMain();
  sessionStorage.removeItem(SESSION_PLAYER_KEY);
  sessionStorage.removeItem(SESSION_SHARE_BF_KEY);
  sessionStorage.removeItem(SESSION_SHARE_GY_KEY);
  gameType = nextGameType;
}

// ── Entry point ─────────────────────────────────────────────────────

watchForPlaytestNavigation();
ensurePlaytestInitialized();

function init() {
  if (initialized) {
    ensureWidgetInjected();
    return;
  }
  initialized = true;

  let roomToJoin = extractRoomId(window.location.href);
  let initialRole = null;
  let initialGameType = null;
  if (roomToJoin) {
    initialRole = 'guest';
    initialGameType = isTraditionalRoomCode(roomToJoin)
      ? GAME_TYPE_TRADITIONAL
      : GAME_TYPE_SHARED;
    // Fresh key for the new guest tab.
    playerKey = null;
    sessionStorage.removeItem(SESSION_PLAYER_KEY);
    history.replaceState(null, '', stripRoomParam(window.location.href));
  } else {
    roomToJoin = sessionStorage.getItem(SESSION_KEY) || null;
    initialRole = sessionStorage.getItem(SESSION_ROLE_KEY) || null;
    initialGameType = sessionStorage.getItem(SESSION_GAME_TYPE_KEY) || null;
    // Restore shared deck settings for reconnection.
    const savedBF = sessionStorage.getItem(SESSION_SHARE_BF_KEY);
    if (savedBF !== null) shareBattlefield = savedBF !== 'false';
    const savedGY = sessionStorage.getItem(SESSION_SHARE_GY_KEY);
    if (savedGY !== null) shareGraveyardExile = savedGY !== 'false';
  }

  chrome.runtime.onMessage.addListener(handlePopupMessage);

  // Listen for postMessage from MAIN world.
  window.addEventListener('message', handleMainMessage);

  waitForNavbar((navbar) => {
    injectButton(navbar);
    if (roomToJoin) {
      const savedRoomToJoin = roomToJoin;
      const savedRole = initialRole;
      const savedGameType = initialGameType || GAME_TYPE_SHARED;
      // Check username before connecting (guest or reconnect).
      chrome.storage.local.get('moxmox_username', (result) => {
        const username = result.moxmox_username?.trim();
        if (!username) {
          showUsernamePrompt(() => {
            refreshLocalUsername();
            role = savedRole;
            gameType = savedGameType;
            connectToRoom(savedRoomToJoin);
          });
          return;
        }
        role = savedRole;
        gameType = savedGameType;
        connectToRoom(savedRoomToJoin);
      });
    }
  });
}

function watchForPlaytestNavigation() {
  window.addEventListener('popstate', () => setTimeout(handlePlaytestRouteChange, 0));
  window.addEventListener('hashchange', () => setTimeout(handlePlaytestRouteChange, 0));
  setInterval(() => {
    handlePlaytestRouteChange();
  }, URL_CHECK_MS);
}

function handlePlaytestRouteChange() {
  const nextUrl = window.location.href;
  if (nextUrl === lastSeenUrl) return;

  const wasPlaytest = isGoldfishPage(lastSeenUrl);
  const isPlaytest = isGoldfishPage(nextUrl);
  lastSeenUrl = nextUrl;

  if (wasPlaytest && !isPlaytest) {
    handlePlaytestClosed();
    return;
  }
  if (isPlaytest) {
    init();
  }
}

function ensurePlaytestInitialized() {
  if (!isGoldfishPage(window.location.href)) return;
  init();
}

function handlePlaytestClosed() {
  if (currentRoomId) {
    leaveCurrentGame();
  }
  removeWidget();
}

function ensureWidgetInjected() {
  waitForNavbar((navbar) => injectButton(navbar));
}

// ── postMessage bridge (ISOLATED → MAIN) ────────────────────────────

let cmdCounter = 0;
const pendingCmds = new Map();

function sendCmd(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++cmdCounter);
    const timeout = setTimeout(() => {
      pendingCmds.delete(id);
      reject(new Error(`Command ${action} timed out`));
    }, 10000);
    pendingCmds.set(id, { resolve, timeout });
    window.postMessage({
      moxmox: MSG_TAG, from: 'isolated', type: 'cmd', id, action, params,
    }, '*');
  });
}

function handleMainMessage(e) {
  if (e.data?.moxmox !== MSG_TAG || e.data?.from !== 'main') return;

  switch (e.data.type) {
    case 'result': {
      const pending = pendingCmds.get(e.data.id);
      if (pending) {
        pendingCmds.delete(e.data.id);
        clearTimeout(pending.timeout);
        pending.resolve(e.data.data);
      }
      break;
    }
    case 'game-event':
      if (gameStarted) handleLocalGameEvent(e.data.event);
      break;
    case 'gift-card':
      sendGiftCard(e.data.targetId, e.data.gift);
      break;
    case 'gift-return-battlefield':
      sendGiftReturnToBattlefield(e.data.targetId, e.data.gift);
      break;
    case 'ready':
      console.log('[MoxMox] MAIN-world bridge ready');
      syncGiftStateToMain();
      break;
  }
}

// ── Navbar detection ────────────────────────────────────────────────

function waitForNavbar(callback, retries = 30, delay = 500) {
  const zoomText = findZoomElement();
  if (zoomText) {
    callback(zoomText);
    return;
  }
  if (retries > 0) {
    setTimeout(() => waitForNavbar(callback, retries - 1, delay), delay);
  } else {
    console.warn('[MoxMox] Could not find playtest navbar');
  }
}

function findZoomElement() {
  const listItems = document.querySelectorAll('nav li');
  for (const li of listItems) {
    if (/^\d+%$/.test(li.textContent.trim())) return li;
  }
  return null;
}

// ── Button injection ────────────────────────────────────────────────

function injectButton(zoomElement) {
  if (document.querySelector('.moxmox-widget')) return;

  const widget = document.createElement('div');
  widget.className = 'moxmox-widget';

  // ── Info column (3 lines) ──
  const info = document.createElement('div');
  info.className = 'moxmox-widget-info';

  // Line 1: Title row with hamburger menu
  const title = document.createElement('div');
  title.className = 'moxmox-widget-title';

  const titleText = document.createElement('span');
  titleText.textContent = 'MoxMox — Play Together';

  const menuWrapper = document.createElement('span');
  menuWrapper.style.position = 'relative';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'moxmox-menu-btn';
  menuBtn.textContent = '☰';
  menuBtn.title = 'Menu';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(menuWrapper);
  });

  menuWrapper.appendChild(menuBtn);
  title.appendChild(titleText);
  title.appendChild(menuWrapper);

  // Line 2: Local player
  const localRow = document.createElement('div');
  localRow.className = 'moxmox-widget-player';

  localDot = document.createElement('span');
  localDot.className = 'moxmox-status-dot';
  localDot.title = 'You: Disconnected';

  localNameEl = document.createElement('span');
  localNameEl.className = 'moxmox-player-name';

  localLifeEl = document.createElement('span');
  localLifeEl.className = 'moxmox-life';
  localLifeEl.textContent = '';

  localHandCountEl = document.createElement('span');
  localHandCountEl.className = 'moxmox-hand-count';
  localHandCountEl.textContent = '';

  localRow.appendChild(localDot);
  localRow.appendChild(localNameEl);
  localRow.appendChild(localLifeEl);
  localRow.appendChild(localHandCountEl);

  // Load and display username (or show "Set Username" button).
  refreshLocalUsername();

  playerGridEl = document.createElement('div');
  playerGridEl.className = 'moxmox-player-grid';
  playerGridEl.appendChild(localRow);

  // Remote players (hidden until connected)
  remotePlayerRow = document.createElement('div');
  remotePlayerRow.className = 'moxmox-remote-players';
  remotePlayerRow.style.display = 'none';
  playerGridEl.appendChild(remotePlayerRow);

  info.appendChild(title);
  info.appendChild(playerGridEl);

  widget.appendChild(info);

  // Close menu on outside click.
  document.addEventListener('click', () => {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  });

  const li = document.createElement('li');
  li.appendChild(widget);
  const parentList = zoomElement.parentElement;
  if (parentList) {
    // Ensure the zoom controls stay vertically centered despite our taller widget.
    parentList.style.alignItems = 'center';
    parentList.insertBefore(li, zoomElement);
  }
}

function removeWidget() {
  const widget = document.querySelector('.moxmox-widget');
  const item = widget?.closest('li');
  if (item) item.remove();
  else if (widget) widget.remove();

  localDot = null;
  remoteDot = null;
  localNameEl = null;
  playerGridEl = null;
  remotePlayerRow = null;
  remoteNameEl = null;
  localLifeEl = null;
  localHandCountEl = null;
  remoteLifeEl = null;
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  if (remoteMenuEl) {
    remoteMenuEl.remove();
    remoteMenuEl = null;
  }
}

function refreshLocalUsername() {
  if (!localNameEl) return;
  chrome.storage.local.get('moxmox_username', (result) => {
    const name = result.moxmox_username?.trim();
    localNameEl.replaceChildren();
    if (name) {
      localNameEl.textContent = name;
    } else {
      const setBtn = document.createElement('button');
      setBtn.className = 'moxmox-set-username-btn';
      setBtn.textContent = 'Set Username';
      setBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showUsernamePrompt(() => refreshLocalUsername());
      });
      localNameEl.appendChild(setBtn);
    }
  });
}

function setRemotePlayerDisplay(name, id = 'opponent') {
  remoteUsername = name || null;
  if (!name) {
    remotePlayers.delete(id);
  } else {
    const existing = remotePlayers.get(id) || {};
    remotePlayers.set(id, { ...existing, id, username: name, connected: true });
  }
  setRemotePlayersDisplay([...remotePlayers.values()]);
}

function updateRemotePlayersFromList(players = []) {
  const next = new Map();
  for (const player of players) {
    if (!player?.id || player.id === localPlayerId) continue;
    const existing = remotePlayers.get(player.id) || {};
    next.set(player.id, {
      ...existing,
      id: player.id,
      username: player.username || existing.username || 'Anonymous',
      connected: player.connected !== false,
    });
  }
  remotePlayers = next;
  setRemotePlayersDisplay([...remotePlayers.values()]);
}

function setRemotePlayersDisplay(players) {
  if (!remotePlayerRow) return;
  remotePlayerRow.replaceChildren();
  remotePlayerRow.style.display = players.length > 0 ? 'contents' : 'none';
  if (playerGridEl) {
    playerGridEl.classList.toggle('multi', players.length + 1 > 2);
  }

  for (const player of players) {
    const row = document.createElement('div');
    row.className = 'moxmox-widget-player';

    const dot = document.createElement('span');
    dot.className = 'moxmox-status-dot';
    if (player.connected !== false) dot.classList.add('connected');
    dot.title = `${player.username || 'Opponent'}: ${player.connected === false ? 'Disconnected' : 'Connected'}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'moxmox-player-name';

    const nameBtn = document.createElement('button');
    nameBtn.className = 'moxmox-remote-name-btn';
    nameBtn.textContent = player.username || 'Anonymous';
    nameBtn.title = 'View player options';
    nameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRemoteMenu(nameEl, player.id);
    });
    nameEl.appendChild(nameBtn);

    const lifeEl = document.createElement('span');
    lifeEl.className = 'moxmox-life';
    setMetricDisplay(lifeEl, '❤️', player.life, 'moxmox-life-value');

    const handCountEl = document.createElement('span');
    handCountEl.className = 'moxmox-hand-count';
    setMetricDisplay(handCountEl, '🃏', player.handCount, 'moxmox-hand-count-value');

    row.appendChild(dot);
    row.appendChild(nameEl);
    row.appendChild(lifeEl);
    row.appendChild(handCountEl);
    remotePlayerRow.appendChild(row);
  }
  syncGiftStateToMain();
  applyLifeDisplayVisibility();
}

async function syncGiftStateToMain() {
  const enabled = !!currentRoomId && gameType === GAME_TYPE_TRADITIONAL;
  const opponents = enabled
    ? [...remotePlayers.values()]
      .filter(player => player.id && player.connected !== false)
      .map(player => ({ id: player.id, username: player.username || 'Opponent' }))
    : [];
  window.postMessage({
    moxmox: MSG_TAG,
    from: 'isolated',
    type: 'gift-state',
    enabled,
    localPlayerId,
    localUsername: await getLocalUsername(),
    opponents,
  }, '*');
}

let remoteMenuEl = null;

function toggleRemoteMenu(anchor, targetId = null) {
  if (remoteMenuEl) {
    remoteMenuEl.remove();
    remoteMenuEl = null;
    return;
  }

  remoteMenuEl = document.createElement('div');
  remoteMenuEl.className = 'moxmox-menu moxmox-remote-menu';
  remoteMenuEl.style.position = 'fixed';

  const showHandItem = document.createElement('button');
  showHandItem.className = 'moxmox-menu-item';
  showHandItem.textContent = 'Show Hand';
  showHandItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    remoteMenuEl.remove();
    remoteMenuEl = null;
    await revealHandToOpponent(targetId);
  });

  remoteMenuEl.appendChild(showHandItem);

  if (gameType === GAME_TYPE_TRADITIONAL && targetId) {
    const graveyardItem = document.createElement('button');
    graveyardItem.className = 'moxmox-menu-item';
    graveyardItem.textContent = 'View Graveyard';
    graveyardItem.addEventListener('click', (e) => {
      e.stopPropagation();
      remoteMenuEl.remove();
      remoteMenuEl = null;
      requestOpponentZone(targetId, 'graveyard');
    });

    const exileItem = document.createElement('button');
    exileItem.className = 'moxmox-menu-item';
    exileItem.textContent = 'View Exile';
    exileItem.addEventListener('click', (e) => {
      e.stopPropagation();
      remoteMenuEl.remove();
      remoteMenuEl = null;
      requestOpponentZone(targetId, 'exile');
    });

    remoteMenuEl.appendChild(graveyardItem);
    remoteMenuEl.appendChild(exileItem);
  }

  // Position below the anchor element.
  const rect = anchor.getBoundingClientRect();
  remoteMenuEl.style.top = `${rect.bottom + 4}px`;
  remoteMenuEl.style.left = `${rect.left}px`;

  document.body.appendChild(remoteMenuEl);

  // Close on next click anywhere (delayed so the current click doesn't close it).
  requestAnimationFrame(() => {
    const closeHandler = (e) => {
      if (remoteMenuEl && !remoteMenuEl.contains(e.target)) {
        remoteMenuEl.remove();
        remoteMenuEl = null;
      }
      document.removeEventListener('click', closeHandler, true);
    };
    document.addEventListener('click', closeHandler, true);
  });
}

/** Send our hand contents to the opponent for viewing. */
async function revealHandToOpponent(targetId = null) {
  const result = await sendCmd('get-hand-cards');
  const cards = result?.cards || [];
  sendWs({
    type: 'zone-sync', action: 'reveal-hand',
    targetId: gameType === GAME_TYPE_TRADITIONAL ? targetId : undefined,
    cards: cards.map(c => ({
      name: c.name,
      set: c.set,
      cn: c.cn,
      layout: c.layout,
      card_faces: c.card_faces,
    })),
    username: await getLocalUsername(),
  });
  const target = targetId ? ` to ${remotePlayers.get(targetId)?.username || targetId}` : '';
  addLog('out', `SEND: revealed hand${target} (${cards.length} cards)`);
}

function requestOpponentZone(targetId, zone) {
  const player = remotePlayers.get(targetId);
  sendWs({
    type: 'zone-sync',
    action: 'request-zone-view',
    targetId,
    zone,
  });
  addLog('out', `SEND: requested ${player?.username || targetId}'s ${zone}`);
}

function sendGiftCard(targetId, gift) {
  if (gameType !== GAME_TYPE_TRADITIONAL || !targetId || !gift) return;
  const player = remotePlayers.get(targetId);
  sendWs({
    type: 'zone-sync',
    action: 'gift-card',
    targetId,
    gift,
  });
  if (gift.fromZone === 'hand') {
    broadcastCurrentHandCount();
  }
  addLog('out', `SEND: gifted ${gift.card?.name || 'card'} to ${player?.username || targetId}`);
}

function sendGiftReturnToBattlefield(targetId, gift) {
  if (gameType !== GAME_TYPE_TRADITIONAL || !targetId || !gift) return;
  const player = remotePlayers.get(targetId);
  sendWs({
    type: 'zone-sync',
    action: 'gift-return-battlefield',
    targetId,
    gift,
  });
  addLog('out', `SEND: returned ${gift.card?.name || 'gifted card'} to ${player?.username || targetId}'s battlefield`);
}

async function getLocalUsername() {
  return new Promise((resolve) => {
    chrome.storage.local.get('moxmox_username', (result) => {
      resolve(result.moxmox_username || 'Anonymous');
    });
  });
}

/** Show the opponent's revealed hand as an overlay at the bottom. */
async function showRevealedHand(cards, username) {
  await showCardOverlay({
    title: `${username}'s Hand (${cards.length})`,
    cards,
    mode: 'hand',
  });
}

async function showZoneViewer(cards, username, zone) {
  const label = zone === 'graveyard' ? 'Graveyard' : 'Exile';
  await showCardOverlay({
    title: `${username}'s ${label} (${cards.length})`,
    cards,
    mode: 'zone',
  });
}

async function showCardOverlay({ title, cards, mode }) {
  // Remove existing reveal overlay.
  const existing = document.getElementById('moxmox-hand-reveal');
  if (existing) existing.remove();

  // Get card dimensions from Moxfield to match sizing.
  const size = await sendCmd('get-battlefield-size');
  const cardHeight = size.cardH || 180;

  const overlay = document.createElement('div');
  overlay.id = 'moxmox-hand-reveal';
  overlay.className = mode === 'zone'
    ? 'moxmox-hand-reveal moxmox-zone-viewer'
    : 'moxmox-hand-reveal';

  const header = document.createElement('div');
  header.className = 'moxmox-hand-reveal-header';

  const titleEl = document.createElement('span');
  titleEl.textContent = title;

  const headerControls = document.createElement('span');
  headerControls.className = 'moxmox-card-viewer-controls';

  const minusBtn = document.createElement('button');
  minusBtn.className = 'moxmox-card-zoom-btn';
  minusBtn.textContent = '−';
  minusBtn.title = 'Smaller cards';

  const plusBtn = document.createElement('button');
  plusBtn.className = 'moxmox-card-zoom-btn';
  plusBtn.textContent = '+';
  plusBtn.title = 'Larger cards';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-hand-reveal-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());

  headerControls.appendChild(minusBtn);
  headerControls.appendChild(plusBtn);
  headerControls.appendChild(closeBtn);

  header.appendChild(titleEl);
  header.appendChild(headerControls);
  overlay.appendChild(header);
  if (mode === 'zone') {
    makeZoneOverlayDraggable(overlay, header);
  }

  const cardList = document.createElement('div');
  cardList.className = mode === 'zone'
    ? 'moxmox-zone-viewer-cards'
    : 'moxmox-hand-reveal-cards';

  const applyZoom = () => {
    const h = Math.round(cardHeight * cardViewerZoom);
    for (const img of cardList.querySelectorAll('img')) {
      img.style.height = `${h}px`;
    }
    if (mode === 'zone') {
      for (const el of cardList.querySelectorAll('.moxmox-zone-viewer-card')) {
        el.style.setProperty('--moxmox-card-height', `${h}px`);
        el.style.setProperty('--moxmox-card-peek', `${Math.max(24, Math.round(h * 0.2))}px`);
      }
      // Expand overlay width so cards don't need a horizontal scrollbar.
      const cardW = Math.round(h * (488 / 680)); // standard MTG card aspect ratio
      const needed = cardW + 24 + 24; // card + padding on each side
      const maxW = window.innerWidth * 0.8;
      overlay.style.width = `${Math.min(needed, maxW)}px`;
    }
  };

  minusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cardViewerZoom = Math.max(0.4, cardViewerZoom - 0.2);
    applyZoom();
  });

  plusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cardViewerZoom = Math.min(3.0, cardViewerZoom + 0.2);
    applyZoom();
  });

  for (const card of cards) {
    const cardEl = document.createElement('div');
    cardEl.className = mode === 'zone'
      ? 'moxmox-zone-viewer-card'
      : 'moxmox-hand-reveal-card';

    const img = createCardImage(card);
    cardEl.appendChild(img);
    cardList.appendChild(cardEl);
  }

  overlay.appendChild(cardList);
  document.body.appendChild(overlay);

  applyZoom();
}

function makeZoneOverlayDraggable(overlay, handle) {
  handle.classList.add('moxmox-zone-viewer-drag-handle');

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();

    const rect = overlay.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;

    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    const move = (moveEvent) => {
      const nextLeft = Math.max(0, Math.min(
        window.innerWidth - overlay.offsetWidth,
        startLeft + moveEvent.clientX - startX,
      ));
      const nextTop = Math.max(0, Math.min(
        window.innerHeight - overlay.offsetHeight,
        startTop + moveEvent.clientY - startY,
      ));
      overlay.style.left = `${nextLeft}px`;
      overlay.style.top = `${nextTop}px`;
    };

    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
  });
}

function createCardImage(card) {
  const img = document.createElement('img');
  const face = card.card_faces?.[0];
  if (card.layout === 'transform' || card.layout === 'modal_dfc') {
    img.src = face?.image_uris?.normal ||
      `https://api.scryfall.com/cards/${card.set}/${card.cn}?format=image&face=front`;
  } else {
    img.src = `https://api.scryfall.com/cards/${card.set}/${card.cn}?format=image`;
  }
  img.alt = card.name;
  img.loading = 'lazy';
  return img;
}

function updateLocalLife(life) {
  if (localLifeEl) {
    setMetricDisplay(localLifeEl, '❤️', life, 'moxmox-life-value');
    applyLifeDisplayVisibility();
  }
}

function updateLocalHandCount(count) {
  localHandCount = count;
  if (localHandCountEl) {
    setMetricDisplay(localHandCountEl, '🃏', count, 'moxmox-hand-count-value');
  }
}

function setMetricDisplay(container, icon, value, valueClass) {
  container.replaceChildren();
  if (value == null) return;
  const valueEl = document.createElement('span');
  valueEl.className = valueClass;
  valueEl.textContent = String(value);
  container.append(icon, valueEl);
}

function applyLifeDisplayVisibility() {
  const widget = document.querySelector('.moxmox-widget');
  if (!widget) return;
  widget.classList.toggle('moxmox-life-hidden', !showLifeDisplay);
  for (const el of widget.querySelectorAll('.moxmox-life')) {
    el.style.display = showLifeDisplay ? '' : 'none';
  }
}

function updateRemoteLife(life, senderId = null, username = null) {
  const id = senderId || 'opponent';
  const existing = remotePlayers.get(id) || { id, username: username || remoteUsername || 'Opponent' };
  remotePlayers.set(id, {
    ...existing,
    username: username || existing.username,
    connected: true,
    life,
  });
  setRemotePlayersDisplay([...remotePlayers.values()]);
}

function updateRemoteHandCount(count, senderId = null, username = null) {
  const id = senderId || 'opponent';
  const existing = remotePlayers.get(id) || { id, username: username || remoteUsername || 'Opponent' };
  remotePlayers.set(id, {
    ...existing,
    username: username || existing.username,
    connected: true,
    handCount: count,
  });
  setRemotePlayersDisplay([...remotePlayers.values()]);
}

function toggleMenu(wrapper) {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
    return;
  }

  menuEl = document.createElement('div');
  menuEl.className = 'moxmox-menu';

  const inviteItem = document.createElement('button');
  inviteItem.className = 'moxmox-menu-item';
  inviteItem.textContent = currentRoomId ? 'Invite...' : 'Create...';
  inviteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menuEl.remove();
    menuEl = null;
    handleInviteButtonClick();
  });

  menuEl.appendChild(inviteItem);

  if (!currentRoomId) {
    const joinItem = document.createElement('button');
    joinItem.className = 'moxmox-menu-item';
    joinItem.textContent = 'Join...';
    joinItem.addEventListener('click', (e) => {
      e.stopPropagation();
      menuEl.remove();
      menuEl = null;
      showTraditionalJoinPopup();
    });
    menuEl.appendChild(joinItem);
  }

  if (currentRoomId) {
    const leaveItem = document.createElement('button');
    leaveItem.className = 'moxmox-menu-item';
    leaveItem.textContent = 'Leave Game';
    leaveItem.addEventListener('click', (e) => {
      e.stopPropagation();
      menuEl.remove();
      menuEl = null;
      showLeaveGamePrompt();
    });
    menuEl.appendChild(leaveItem);
  }

  // Hide/Show Life Totals toggle
  const lifeToggle = document.createElement('button');
  lifeToggle.className = 'moxmox-menu-item';
  lifeToggle.textContent = showLifeDisplay ? 'Hide Life Totals' : 'Show Life Totals';
  lifeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    showLifeDisplay = !showLifeDisplay;
    applyLifeDisplayVisibility();
    lifeToggle.textContent = showLifeDisplay ? 'Hide Life Totals' : 'Show Life Totals';
  });
  menuEl.appendChild(lifeToggle);

  wrapper.appendChild(menuEl);
}

// ── Button click handler ────────────────────────────────────────────

async function handleInviteButtonClick() {
  if (currentRoomId && gameType === GAME_TYPE_TRADITIONAL) {
    if (await isCurrentRoomFull()) {
      showRoomFullInvitePopup();
      return;
    }
    showCurrentTraditionalRoomCodePopup();
    return;
  }
  if (currentRoomId && gameType === GAME_TYPE_SHARED) {
    if (await isCurrentRoomFull()) {
      showRoomFullInvitePopup();
      return;
    }
    showCurrentSharedInvitePopup();
    return;
  }
  ensureUsername(() => showInvitePopup());
}

async function isCurrentRoomFull() {
  if (!currentRoomId) return false;
  try {
    const info = await fetchRoomInfo(currentRoomId);
    return !!info.full;
  } catch (err) {
    addLog('in', `⚠️ Could not check room capacity: ${err.message}`);
    const roomMaxPlayers = maxPlayers || 2;
    return 1 + remotePlayers.size >= roomMaxPlayers;
  }
}

// ── WebSocket connection ────────────────────────────────────────────

function connectToRoom(roomId, options = {}) {
  clearReconnectTimer();
  stopHeartbeat();
  intentionalDisconnect = false;
  if (options.gameType) gameType = options.gameType;
  if (!gameType) gameType = GAME_TYPE_SHARED;
  if (options.maxPlayers) maxPlayers = options.maxPlayers;
  if ('shareBattlefield' in options) shareBattlefield = options.shareBattlefield;
  if ('shareGraveyardExile' in options) shareGraveyardExile = options.shareGraveyardExile;

  // Apply the per-game-type "Show Life Totals" preference.
  const storageKey = gameType === GAME_TYPE_TRADITIONAL
    ? 'moxmox_show_life_traditional'
    : 'moxmox_show_life_shared';
  chrome.storage.local.get(storageKey, (result) => {
    showLifeDisplay = result[storageKey] !== false; // default true
    applyLifeDisplayVisibility();
  });

  currentRoomId = roomId;
  sessionStorage.setItem(SESSION_KEY, roomId);
  sessionStorage.setItem(SESSION_ROLE_KEY, role);
  sessionStorage.setItem(SESSION_GAME_TYPE_KEY, gameType);
  sessionStorage.setItem(SESSION_SHARE_BF_KEY, String(shareBattlefield));
  sessionStorage.setItem(SESSION_SHARE_GY_KEY, String(shareGraveyardExile));
  setLocalStatus('connecting');
  setRemoteStatus('disconnected');
  addLog('out', `Connecting to ${gameType} room ${roomId}…`);

  const url = `${WS_URL}/room/${encodeURIComponent(roomId)}`;
  if (ws) {
    try { ws.close(); } catch (_) {}
  }
  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener('open', () => {
    setLocalStatus('connected');
    addLog('in', 'WebSocket connected');
    startHeartbeat();
    // Include username in join message so the other player can see it.
    chrome.storage.local.get('moxmox_username', (result) => {
      sendWs({
        type: 'join',
        playerKey: getOrCreatePlayerKey(),
        username: result.moxmox_username || 'Anonymous',
        gameType,
        maxPlayers,
        shareBattlefield,
        shareGraveyardExile,
      });
    });
  });

  socket.addEventListener('message', (event) => {
    handleServerMessage(event.data);
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    stopHeartbeat();
    setLocalStatus('disconnected');
    setRemoteStatus('disconnected');
    addLog('in', 'WebSocket disconnected');
    ws = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    setLocalStatus('disconnected');
    addLog('in', '⚠️ WebSocket error');
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }
  }, WS_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalDisconnect || reconnectTimer || !currentRoomId || !role || !gameType) return;
  addLog('in', `Reconnecting in ${WS_RECONNECT_MS / 1000}s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (intentionalDisconnect || !currentRoomId || ws) return;
    connectToRoom(currentRoomId, { gameType, maxPlayers });
  }, WS_RECONNECT_MS);
}

let wsThrottled = false;
let wsPendingQueue = [];
let wsThrottleTimer = null;

function sendWs(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (wsThrottled) {
    // Dedup position updates — keep only the latest per syncId.
    if (msg.type === 'zone-sync' && msg.action === 'update-state' && msg.syncId) {
      const idx = wsPendingQueue.findIndex(m =>
        m.type === 'zone-sync' && m.action === 'update-state' && m.syncId === msg.syncId,
      );
      if (idx >= 0) { wsPendingQueue[idx] = msg; return; }
    }
    if (wsPendingQueue.length < 50) wsPendingQueue.push(msg);
    return;
  }

  ws.send(JSON.stringify(msg));
  addLog('out', `SEND: ${msg.type}`);
}

function activateSendThrottle() {
  if (wsThrottled) return;
  wsThrottled = true;
  addLog('in', '⚠️ Rate limited — throttling sends');
  wsThrottleTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || wsPendingQueue.length === 0) {
      clearSendThrottle();
      return;
    }
    const next = wsPendingQueue.shift();
    ws.send(JSON.stringify(next));
    addLog('out', `SEND: ${next.type}`);
  }, 250);
}

function clearSendThrottle() {
  wsThrottled = false;
  wsPendingQueue = [];
  if (wsThrottleTimer) { clearInterval(wsThrottleTimer); wsThrottleTimer = null; }
}

function handleServerMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'system': {
      if (msg.rejected) {
        intentionalDisconnect = true;
        stopHeartbeat();
        clearReconnectTimer();
        addLog('in', `⛔ REJECTED: ${msg.text}`);
        setLocalStatus('disconnected');
        setRemoteStatus('disconnected');
        currentRoomId = null;
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_ROLE_KEY);
        sessionStorage.removeItem(SESSION_GAME_TYPE_KEY);
        sessionStorage.removeItem(SESSION_PLAYER_KEY);
        showRoomRejectedModal(msg.text || 'Unable to join this room.');
        break;
      }
      if (msg.gameType) {
        gameType = msg.gameType;
        sessionStorage.setItem(SESSION_GAME_TYPE_KEY, gameType);
      }
      if (msg.maxPlayers) maxPlayers = msg.maxPlayers;
      // Read shared deck settings from the server.
      if ('shareBattlefield' in msg) {
        shareBattlefield = msg.shareBattlefield !== false;
        sessionStorage.setItem(SESSION_SHARE_BF_KEY, String(shareBattlefield));
      }
      if ('shareGraveyardExile' in msg) {
        shareGraveyardExile = msg.shareGraveyardExile !== false;
        sessionStorage.setItem(SESSION_SHARE_GY_KEY, String(shareGraveyardExile));
      }
      if (msg.playerId) localPlayerId = msg.playerId;
      if (Array.isArray(msg.players)) updateRemotePlayersFromList(msg.players);
      // Handle intentional leave — remove the player's name and divider.
      if (msg.left && msg.leftPlayerId) {
        remotePlayers.delete(msg.leftPlayerId);
        setRemotePlayersDisplay([...remotePlayers.values()]);
        document.querySelector('.moxmox-divider')?.remove();
      }
      // Show the pending shared invite URL after join is acknowledged.
      if (msg.playerId && pendingSharedInvite) {
        const shareUrl = pendingSharedInvite.shareUrl;
        pendingSharedInvite = null;
        // Close the create game popup.
        if (popupBackdrop) {
          popupBackdrop.remove();
          popupBackdrop = null;
        }
        showInviteResultPopup({
          title: 'Game Created',
          subtitle: 'Send this url to a friend with MoxMox installed to have them join the game.',
          value: shareUrl,
          copiedText: 'Link copied to clipboard',
        });
      }
      let peerCount = msg.peerCount;
      if (typeof peerCount !== 'number') {
        const m = msg.text?.match(/(\d+)\s+player\(s\)/);
        if (m) peerCount = parseInt(m[1], 10);
      }
      if (typeof peerCount === 'number') {
        setRemoteStatus(peerCount >= 2 ? 'connected' : 'disconnected');
      }
      if (gameType === GAME_TYPE_TRADITIONAL && msg.playerId) {
        activateTraditionalGame();
      }
      addLog('in', `SYSTEM: ${msg.text}`);
      break;
    }
    case 'join':
      setRemoteStatus('connected');
      if (Array.isArray(msg.players)) updateRemotePlayersFromList(msg.players);
      if (msg.username) {
        setRemotePlayerDisplay(msg.username, msg.senderId || 'opponent');
      }
      if (gameType === GAME_TYPE_TRADITIONAL || gameStarted) {
        broadcastCurrentLife();
        broadcastCurrentHandCount();
      }
      addLog('in', `RECV: join (${msg.username || 'Anonymous'})`);
      break;
    case 'game-init':
      if (gameType !== GAME_TYPE_SHARED) break;
      addLog('in', `RECV: game-init (${msg.library?.length} cards)`);
      runGuestGameStart(msg.library);
      break;
    case 'game-ready':
      if (gameType !== GAME_TYPE_SHARED) break;
      addLog('in', `RECV: game-ready (${msg.drawnCount} cards drawn)`);
      finishHostGameStart(msg.drawnCount);
      break;
    case 'game-start':
      if (gameType !== GAME_TYPE_SHARED) break;
      addLog('in', 'RECV: game-start');
      enableStartButton();
      break;
    case 'zone-sync':
      addLog('in', `RECV: zone-sync ${msg.action} ${msg.zone || ''}`);
      handleRemoteSync(msg);
      break;
    case 'life-sync':
      updateRemoteLife(msg.life, msg.senderId, msg.username);
      break;
    case 'hand-count-sync':
      updateRemoteHandCount(msg.handCount, msg.senderId, msg.username);
      break;
    case 'pong':
      break;
    case 'error':
      if (msg.code === 'rate_limited') {
        activateSendThrottle();
      }
      addLog('in', `⚠️ ERROR: ${msg.text || msg.code}`);
      break;
    default:
      addLog('in', `RECV: ${msg.type}`);
  }
}

// ── Status indicators ───────────────────────────────────────────────

function setLocalStatus(state) {
  localStatus = state;
  applyDotState(localDot, state, 'You');
}

function setRemoteStatus(state) {
  const wasConnected = remoteStatus === 'connected';
  remoteStatus = state;
  applyDotState(remoteDot, state, 'Opponent');

  // Hide remote player row on disconnect.
  if (state === 'disconnected' && remotePlayerRow && gameType !== GAME_TYPE_TRADITIONAL) {
    setRemotePlayerDisplay(null);
  }

  // Trigger game start when both players are connected for the first time.
  if (
    gameType === GAME_TYPE_SHARED &&
    !wasConnected &&
    state === 'connected' &&
    localStatus === 'connected' &&
    !gameStarted &&
    !gameSetupDone
  ) {
    startGameFlow();
  }
}

function applyDotState(dot, state, label) {
  if (!dot) return;
  dot.classList.remove('connected', 'connecting');
  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      dot.title = `${label}: Connected`;
      break;
    case 'connecting':
      dot.classList.add('connecting');
      dot.title = `${label}: Connecting…`;
      break;
    default:
      dot.title = `${label}: Disconnected`;
  }
}

// ── Game start flow ─────────────────────────────────────────────────

function startGameFlow() {
  if (gameType !== GAME_TYPE_SHARED) return;
  gameSetupDone = false;
  showGameModal();
  if (role === 'host') {
    runHostGameStart();
  }
  // Guest waits for game-init message.
}

function activateTraditionalGame() {
  if (traditionalLifeInitialized) return;
  traditionalLifeInitialized = true;
  gameStarted = true;
  gameSetupDone = true;
  broadcastCurrentLife();
  broadcastCurrentHandCount();
}

function broadcastCurrentLife() {
  sendCmd('get-life').then(result => {
    if (result?.life != null) {
      updateLocalLife(result.life);
      sendWs({ type: 'life-sync', life: result.life });
    }
  }).catch(() => {});
}

function broadcastCurrentHandCount(count = null) {
  if (count != null) {
    updateLocalHandCount(count);
    sendWs({ type: 'hand-count-sync', handCount: count });
    return;
  }

  sendCmd('get-hand-count').then(result => {
    if (result?.handCount != null) {
      updateLocalHandCount(result.handCount);
      sendWs({ type: 'hand-count-sync', handCount: result.handCount });
    }
  }).catch(() => {});
}

async function runHostGameStart() {
  try {
    // Dismiss Moxfield's "Save State Found" dialog if present.
    await sendCmd('discard-save-state');

    updateGameModalStatus('Resetting…');
    const resetResult = await sendCmd('reset-to-library');
    addLog('out', `DEBUG: reset-to-library → ${JSON.stringify(resetResult)}`);

    updateGameModalStatus('Shuffling…');
    const shuffleResult = await sendCmd('shuffle-library');
    addLog('out', `DEBUG: shuffle-library → ${JSON.stringify(shuffleResult)}`);

    updateGameModalStatus('Drawing 7 cards…');
    const drawResult = await sendCmd('draw', { count: 7 });
    addLog('out', `DEBUG: draw → ${JSON.stringify(drawResult)}`);

    updateGameModalStatus('Sending library to opponent…');
    const libResult = await sendCmd('get-library');
    addLog('out', `DEBUG: get-library → ${libResult?.cards?.length} cards, first: ${JSON.stringify(libResult?.cards?.[0])}`);
    const msg = { type: 'game-init', library: libResult.cards };
    addLog('out', `DEBUG: game-init message size: ${JSON.stringify(msg).length} bytes`);
    sendWs(msg);

    updateGameModalStatus('Waiting for opponent to draw…');
  } catch (err) {
    addLog('out', `DEBUG: host error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

async function finishHostGameStart(drawnCount) {
  try {
    addLog('in', `DEBUG: finishHostGameStart drawnCount=${drawnCount}`);
    updateGameModalStatus('Finalizing…');
    const removeResult = await sendCmd('remove-top-from-library', { count: drawnCount });
    addLog('out', `DEBUG: remove-top → ${JSON.stringify(removeResult)}`);
    sendWs({ type: 'game-start' });
    enableStartButton();
  } catch (err) {
    addLog('out', `DEBUG: finishHost error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

async function runGuestGameStart(libraryCards) {
  try {
    addLog('in', `DEBUG: game-init received ${libraryCards?.length} cards, first: ${JSON.stringify(libraryCards?.[0])}`);

    // Dismiss Moxfield's "Save State Found" dialog if present.
    await sendCmd('discard-save-state');

    updateGameModalStatus('Resetting…');
    const resetResult = await sendCmd('reset-to-library');
    addLog('out', `DEBUG: reset-to-library → ${JSON.stringify(resetResult)}`);

    updateGameModalStatus('Syncing library…');
    const syncResult = await sendCmd('set-library-from-sync', { cards: libraryCards });
    addLog('out', `DEBUG: set-library-from-sync → ${JSON.stringify(syncResult)}`);

    updateGameModalStatus('Drawing 7 cards…');
    const drawResult = await sendCmd('draw', { count: 7 });
    addLog('out', `DEBUG: draw → ${JSON.stringify(drawResult)}`);

    sendWs({ type: 'game-ready', drawnCount: drawResult.count });
    updateGameModalStatus('Waiting for host…');
  } catch (err) {
    addLog('out', `DEBUG: guest error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

// ── Game modal UI ───────────────────────────────────────────────────

function showGameModal() {
  if (gameModal) return;

  gameModal = document.createElement('div');
  gameModal.className = 'moxmox-popup-backdrop';
  // No backdrop click to close — this is modal during setup.

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Both Players Connected!';

  const status = document.createElement('p');
  status.id = 'moxmox-game-status';
  status.textContent = 'Starting Game…';

  const startBtn = document.createElement('button');
  startBtn.className = 'moxmox-popup-copy-btn';
  startBtn.id = 'moxmox-start-btn';
  startBtn.textContent = 'Start!';
  startBtn.disabled = true;
  startBtn.style.marginTop = '16px';
  startBtn.style.padding = '10px 32px';
  startBtn.style.fontSize = '15px';
  startBtn.addEventListener('click', () => {
    gameStarted = true; // Enable ongoing sync now that setup is complete.
    gameModal.remove();
    gameModal = null;
    // Initialize life display.
    sendCmd('get-life').then(result => {
      if (result?.life != null) {
        updateLocalLife(result.life);
        // Send initial life to opponent.
        sendWs({ type: 'life-sync', life: result.life });
      }
    }).catch(() => {});
    broadcastCurrentHandCount();
  });

  popup.appendChild(heading);
  popup.appendChild(status);
  popup.appendChild(startBtn);
  gameModal.appendChild(popup);
  document.body.appendChild(gameModal);
}

function updateGameModalStatus(text) {
  const el = document.getElementById('moxmox-game-status');
  if (el) el.textContent = text;
}

function enableStartButton() {
  gameSetupDone = true;
  updateGameModalStatus('Ready to play!');
  const btn = document.getElementById('moxmox-start-btn');
  if (btn) btn.disabled = false;
  if (gameType === GAME_TYPE_SHARED) {
    sendCmd('inject-divider').catch(() => {});
  }
}

function showRoomRejectedModal(text = 'This game already has two players connected.') {
  // Replace whatever modal is showing with a "Room is Full" message.
  if (gameModal) {
    gameModal.remove();
    gameModal = null;
  }

  gameModal = document.createElement('div');
  gameModal.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Unable to Join Room';

  const msg = document.createElement('p');
  msg.textContent = text;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-copy-btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.marginTop = '16px';
  closeBtn.style.padding = '10px 32px';
  closeBtn.style.fontSize = '15px';
  closeBtn.addEventListener('click', () => {
    gameModal.remove();
    gameModal = null;
  });

  popup.appendChild(heading);
  popup.appendChild(msg);
  popup.appendChild(closeBtn);
  gameModal.appendChild(popup);
  document.body.appendChild(gameModal);
}

// ── Username prompt ─────────────────────────────────────────────────

function showUsernamePrompt(onComplete) {
  if (gameModal) {
    gameModal.remove();
    gameModal = null;
  }

  gameModal = document.createElement('div');
  gameModal.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Set Your Username';

  const subtitle = document.createElement('p');
  subtitle.textContent = 'Enter a username before starting a game.';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Your name';
  input.maxLength = 30;
  input.style.cssText = 'width: 100%; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; background: #111; color: #e0e0e0; font-size: 14px; margin-bottom: 8px;';

  const error = document.createElement('div');
  error.style.cssText = 'color: #e53935; font-size: 12px; min-height: 18px; margin-bottom: 8px;';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'moxmox-popup-copy-btn';
  confirmBtn.textContent = 'Continue';
  confirmBtn.style.cssText = 'padding: 10px 32px; font-size: 15px;';

  function submit() {
    const name = input.value.trim();
    if (!name) {
      error.textContent = 'Please enter a username.';
      input.focus();
      return;
    }
    chrome.storage.local.set({ moxmox_username: name }, () => {
      gameModal.remove();
      gameModal = null;
      onComplete();
    });
  }

  confirmBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  popup.appendChild(heading);
  popup.appendChild(subtitle);
  popup.appendChild(input);
  popup.appendChild(error);
  popup.appendChild(confirmBtn);
  gameModal.appendChild(popup);
  document.body.appendChild(gameModal);

  // Focus the input after a short delay (DOM needs to be rendered).
  setTimeout(() => input.focus(), 50);
}

// ── Ongoing sync: local events → remote ─────────────────────────────

async function handleLocalGameEvent(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const { type, card, fromZone, toZone } = event;
  if (
    gameType === GAME_TYPE_TRADITIONAL &&
    type === 'card:zone-changed' &&
    card?.moxmoxGift?.ownerId &&
    card.moxmoxGift.ownerId !== localPlayerId &&
    GIFT_RETURN_ZONES.has(toZone)
  ) {
    sendWs({
      type: 'zone-sync',
      action: 'gift-return',
      targetId: card.moxmoxGift.ownerId,
      zone: toZone,
      gift: card.gift,
    });
    await sendCmd('gift-remove', { giftId: card.moxmoxGift.giftId });
    if (toZone === 'hand') {
      broadcastCurrentHandCount();
    }
    addLog('out', `SEND: returned ${card.name || 'gifted card'} to ${toZone}`);
    return;
  }
  const handChanged =
    (type === 'card:zone-changed' && (fromZone === 'hand' || toZone === 'hand')) ||
    (type === 'card:removed' && event.fromZone === 'hand');
  if (handChanged) {
    broadcastCurrentHandCount(event.handCount);
  }

  if (gameType === GAME_TYPE_TRADITIONAL) {
    if (type === 'life:changed') {
      updateLocalLife(event.to);
      sendWs({ type: 'life-sync', life: event.to });
    }
    return;
  }

  if (type === 'card:zone-changed') {
    const fromShared = isSharedZone(fromZone);
    const toShared = isSharedZone(toZone);
    const fromBF = fromZone === 'battlefield';
    const toBF = toZone === 'battlefield';

    if (toBF) {
      if (shareBattlefield) {
        // Send card center as percentage of battlefield dimensions.
        const size = await sendCmd('get-battlefield-size');
        const centerX = (card.left ?? 0) + size.cardW / 2;
        const centerY = (card.top ?? 0) + size.cardH / 2;
        const pctX = size.usableWidth > 0 ? centerX / size.usableWidth : 0.5;
        const pctY = size.height > 0 ? centerY / size.height : 0.5;
        sendWs({
          type: 'zone-sync', action: 'add-battlefield',
          cardId: card.id, syncId: card.syncId,
          pctX, pctY,
          fromZone: fromShared ? fromZone : undefined,
        });
      }
      // Always remove from the shared source zone on the other side,
      // even if battlefield mirroring is off.
      if (fromShared) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: fromZone, syncId: card.syncId });
      }
    } else if (fromBF && toZone === 'hand') {
      // Battlefield → hand: remove from opponent's battlefield (if mirrored).
      if (shareBattlefield) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield', syncId: card.syncId });
      }
    } else if (fromBF && toShared) {
      // Battlefield → shared zone: remove from opponent's BF, add to shared zone.
      if (shareBattlefield) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield', syncId: card.syncId });
      }
      sendWs({ type: 'zone-sync', action: 'add', zone: toZone, cardId: card.id, syncId: card.syncId });
    } else if (fromBF && !toShared && toZone !== 'hand') {
      // Battlefield → non-shared zone (GY/exile when not shared): just remove from opponent's BF.
      if (shareBattlefield) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield', syncId: card.syncId });
      }
    } else if (!fromShared && toShared) {
      // Private (hand) → shared: opponent adds to their shared zone.
      sendWs({ type: 'zone-sync', action: 'add', zone: toZone,
        cardId: card.id, syncId: card.syncId });
    } else if (fromShared && !toShared) {
      // Shared → private (hand): opponent removes from shared zone.
      sendWs({ type: 'zone-sync', action: 'remove', zone: fromZone,
        syncId: card.syncId });
    } else if (fromShared && toShared) {
      // Shared → shared: opponent moves between zones.
      sendWs({ type: 'zone-sync', action: 'move', fromZone, toZone,
        syncId: card.syncId });
    }
  } else if (type === 'card:state-changed' && card) {
    // Battlefield state changes: only sync if battlefield mirroring is enabled.
    if (!shareBattlefield) return;

    const syncUpdates = {};
    const changes = event.changes || {};

    // Non-positional state.
    for (const prop of ['tapped', 'flipped', 'rotated', 'doesntUntap',
                         'counters', 'adjustedPower', 'adjustedToughness', 'adjustedLoyalty']) {
      if (changes[prop]) syncUpdates[prop] = changes[prop].to;
    }

    // Position — send each axis independently as a percentage.
    // Uses top-left coordinates normalized against usable bounds.
    if (changes.left || changes.top) {
      const size = await sendCmd('get-battlefield-size');

      if (changes.left) {
        const centerX = (card.left ?? 0) + size.cardW / 2;
        syncUpdates.pctX = size.usableWidth > 0 ? centerX / size.usableWidth : 0.5;
      }
      if (changes.top) {
        const centerY = (card.top ?? 0) + size.cardH / 2;
        syncUpdates.pctY = size.height > 0 ? centerY / size.height : 0.5;
      }
    }

    if (Object.keys(syncUpdates).length > 0) {
      sendWs({ type: 'zone-sync', action: 'update-state',
        syncId: card.syncId, updates: syncUpdates });
    }
  } else if (type === 'card:removed' && event.fromZone) {
    if (event.fromZone === 'battlefield') {
      if (shareBattlefield) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield',
          syncId: card.syncId });
      }
    } else if (isSharedZone(event.fromZone)) {
      sendWs({ type: 'zone-sync', action: 'remove', zone: event.fromZone,
        syncId: card.syncId });
    }
  } else if (type === 'zone:reordered' && isSharedZone(event.zone)) {
    sendWs({ type: 'zone-sync', action: 'reorder', zone: event.zone,
      syncIds: event.syncIds });
  } else if (type === 'selection-changed') {
    sendWs({ type: 'zone-sync', action: 'highlight',
      syncIds: event.syncIds || [] });
  } else if (type === 'life:changed') {
    updateLocalLife(event.to);
    sendWs({ type: 'life-sync', life: event.to });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Check if a zone is shared in the current game settings. Library is always shared. */
function isSharedZone(zone) {
  if (zone === 'library') return true;
  if (zone === 'graveyard' || zone === 'exile') return shareGraveyardExile;
  return false;
}

// ── Ongoing sync: remote → local ────────────────────────────────────

async function handleRemoteSync(msg) {
  try {
    const traditionalActions = new Set([
      'reveal-hand', 'request-zone-view', 'zone-view',
      'gift-card', 'gift-return', 'gift-return-battlefield',
    ]);
    if (gameType === GAME_TYPE_TRADITIONAL && !traditionalActions.has(msg.action)) {
      return;
    }
    switch (msg.action) {
      case 'add':
        if (!isSharedZone(msg.zone)) break;
        await sendCmd('sync-add', { zone: msg.zone, cardId: msg.cardId, syncId: msg.syncId });
        break;
      case 'remove':
        if (msg.zone === 'battlefield') {
          if (!shareBattlefield) break;
        } else if (!isSharedZone(msg.zone)) {
          break;
        }
        await sendCmd('sync-remove', { zone: msg.zone, syncId: msg.syncId });
        break;
      case 'move':
        if (!isSharedZone(msg.fromZone) || !isSharedZone(msg.toZone)) break;
        await sendCmd('sync-move', { fromZone: msg.fromZone, toZone: msg.toZone, syncId: msg.syncId });
        break;
      case 'add-battlefield': {
        if (!shareBattlefield) {
          // Still remove from the shared source zone if applicable.
          if (msg.fromZone && isSharedZone(msg.fromZone)) {
            await sendCmd('sync-remove', { zone: msg.fromZone, syncId: msg.syncId });
          }
          break;
        }
        // Mirror card center, then convert back to top-left.
        const size = await sendCmd('get-battlefield-size');
        const mirroredCX = (1 - msg.pctX) * size.usableWidth;
        const mirroredCY = (1 - msg.pctY) * size.height;
        const localLeft = clamp(Math.round(mirroredCX - size.cardW / 2), 0, size.usableWidth - size.cardW);
        const localTop = clamp(Math.round(mirroredCY - size.cardH / 2), 0, size.height - size.cardH);
        await sendCmd('sync-add-battlefield', {
          cardId: msg.cardId, syncId: msg.syncId,
          top: localTop, left: localLeft, rotated: true,
        });
        // If the card came from a shared zone, remove it there too.
        if (msg.fromZone && isSharedZone(msg.fromZone)) {
          await sendCmd('sync-remove', { zone: msg.fromZone, syncId: msg.syncId });
        }
        break;
      }
      case 'update-state': {
        if (!shareBattlefield) break;
        const updates = { ...msg.updates };
        // Translate each axis independently — don't invent the missing axis.
        if ('pctX' in updates || 'pctY' in updates) {
          const size = await sendCmd('get-battlefield-size');

          if ('pctX' in updates) {
            const mirroredCX = (1 - updates.pctX) * size.usableWidth;
            updates.left = clamp(Math.round(mirroredCX - size.cardW / 2), 0, size.usableWidth - size.cardW);
            delete updates.pctX;
          }
          if ('pctY' in updates) {
            const mirroredCY = (1 - updates.pctY) * size.height;
            updates.top = clamp(Math.round(mirroredCY - size.cardH / 2), 0, size.height - size.cardH);
            delete updates.pctY;
          }
        }
        await sendCmd('sync-update-state', { syncId: msg.syncId, updates });
        break;
      }
      case 'highlight':
        await sendCmd('apply-remote-highlight', { syncIds: msg.syncIds || [] });
        break;
      case 'reveal-hand':
        await showRevealedHand(msg.cards || [], msg.username || 'Opponent');
        addLog('in', `RECV: opponent revealed hand (${msg.cards?.length || 0} cards)`);
        break;
      case 'request-zone-view': {
        if (gameType !== GAME_TYPE_TRADITIONAL) break;
        if (!['graveyard', 'exile'].includes(msg.zone) || !msg.senderId) break;
        const result = await sendCmd('get-zone-cards', { zone: msg.zone });
        const cards = result?.cards || [];
        sendWs({
          type: 'zone-sync',
          action: 'zone-view',
          targetId: msg.senderId,
          zone: msg.zone,
          cards,
          username: await getLocalUsername(),
        });
        addLog('out', `SEND: ${msg.zone} contents (${cards.length} cards)`);
        break;
      }
      case 'zone-view':
        if (gameType !== GAME_TYPE_TRADITIONAL) break;
        await showZoneViewer(msg.cards || [], msg.username || 'Opponent', msg.zone);
        addLog('in', `RECV: ${msg.username || 'Opponent'} ${msg.zone} (${msg.cards?.length || 0} cards)`);
        break;
      case 'gift-card':
        if (gameType !== GAME_TYPE_TRADITIONAL || !msg.gift) break;
        await sendCmd('gift-add-battlefield', { gift: msg.gift });
        addLog('in', `RECV: gifted ${msg.gift.card?.name || 'card'}`);
        break;
      case 'gift-return':
        if (gameType !== GAME_TYPE_TRADITIONAL || !msg.gift || !GIFT_RETURN_ZONES.has(msg.zone)) break;
        await sendCmd('gift-add-zone', { zone: msg.zone, gift: msg.gift });
        if (msg.zone === 'hand') {
          broadcastCurrentHandCount();
        }
        addLog('in', `RECV: returned ${msg.gift.card?.name || 'gifted card'} to ${msg.zone}`);
        break;
      case 'gift-return-battlefield':
        if (gameType !== GAME_TYPE_TRADITIONAL || !msg.gift) break;
        await sendCmd('gift-add-battlefield', { gift: msg.gift, preserveGift: false });
        addLog('in', `RECV: returned ${msg.gift.card?.name || 'gifted card'} to battlefield`);
        break;
    }
  } catch (err) {
    console.error('[MoxMox] Sync error:', err);
  }
}

// ── Invite / join popups ─────────────────────────────────────────────

function showCurrentTraditionalRoomCodePopup() {
  showCurrentInviteValuePopup({
    title: 'Traditional Room Code',
    subtitle: 'Share this code with players joining from the MoxMox Join menu.',
    value: currentRoomId,
    copiedText: 'Room code copied to clipboard',
  });
}

function showCurrentSharedInvitePopup() {
  showCurrentInviteValuePopup({
    title: 'Shared Deck Invite',
    subtitle: 'Send this link to your opponent. They need the MoxMox extension installed.',
    value: buildShareUrl(stripRoomParam(window.location.href), currentRoomId),
    copiedText: 'Link copied to clipboard',
  });
}

function showRoomFullInvitePopup() {
  showMessagePopup({
    title: 'Room Full',
    message: "You can't invite anyone else because this room is already full.",
  });
}

function showMessagePopup({ title, message }) {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = title;

  const msg = document.createElement('p');
  msg.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  popup.appendChild(heading);
  popup.appendChild(msg);
  popup.appendChild(closeBtn);
  popupBackdrop.appendChild(popup);

  popupBackdrop.addEventListener('click', (e) => {
    if (e.target === popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }
  });

  document.body.appendChild(popupBackdrop);
}

function showCurrentInviteValuePopup({ title, subtitle, value, copiedText }) {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  copyToClipboard(value);

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';

  const heading = document.createElement('h3');
  heading.textContent = title;

  const subtitleEl = document.createElement('p');
  subtitleEl.textContent = subtitle;

  const body = document.createElement('div');
  renderInviteOutput(body, value, copiedText);

  const copiedMsg = document.createElement('div');
  copiedMsg.className = 'moxmox-popup-copied';
  copiedMsg.id = 'moxmox-copied-msg';
  copiedMsg.textContent = '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  popup.appendChild(heading);
  popup.appendChild(subtitleEl);
  popup.appendChild(body);
  popup.appendChild(copiedMsg);
  popup.appendChild(closeBtn);
  popupBackdrop.appendChild(popup);

  popupBackdrop.addEventListener('click', (e) => {
    if (e.target === popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }
  });

  document.body.appendChild(popupBackdrop);
  showCopiedFeedback(copiedText);
}

function showInvitePopup() {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';

  const heading = document.createElement('h3');
  heading.textContent = 'Create Game';

  const subtitle = document.createElement('p');
  subtitle.textContent = 'Choose a game type to create a room.';

  const sections = document.createElement('div');
  sections.className = 'moxmox-game-type-sections';

  const sharedSection = createInviteSection(
    'Shared Library (e.g. DanDan)',
    'Share a deck, sync library/graveyard/exile, battlefield cards, and life totals.',
  );
  const traditionalSection = createInviteSection(
    'Traditional (e.g. Commander)',
    'Use separate decks. Sync life totals and targeted hand reveal only.',
  );

  sharedSection.button.addEventListener('click', () => {
    activateInviteSection(sharedSection, traditionalSection);
    createSharedInvite(sharedSection.body);
  });

  traditionalSection.button.addEventListener('click', () => {
    activateInviteSection(traditionalSection, sharedSection);
    renderTraditionalCreate(traditionalSection.body);
  });

  sections.appendChild(sharedSection.root);
  sections.appendChild(traditionalSection.root);

  const copiedMsg = document.createElement('div');
  copiedMsg.className = 'moxmox-popup-copied';
  copiedMsg.id = 'moxmox-copied-msg';
  copiedMsg.textContent = '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  popup.appendChild(heading);
  popup.appendChild(subtitle);
  popup.appendChild(sections);
  popup.appendChild(copiedMsg);
  popup.appendChild(closeBtn);
  popupBackdrop.appendChild(popup);

  popupBackdrop.addEventListener('click', (e) => {
    if (e.target === popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }
  });

  document.body.appendChild(popupBackdrop);
}

function createInviteSection(title, description) {
  const root = document.createElement('section');
  root.className = 'moxmox-game-type-section';

  const button = document.createElement('button');
  button.className = 'moxmox-game-type-button';
  button.type = 'button';

  const titleEl = document.createElement('span');
  titleEl.className = 'moxmox-game-type-title';
  titleEl.textContent = title;

  const descEl = document.createElement('span');
  descEl.className = 'moxmox-game-type-description';
  descEl.textContent = description;

  button.appendChild(titleEl);
  button.appendChild(descEl);

  const body = document.createElement('div');
  body.className = 'moxmox-game-type-body';
  body.hidden = true;

  root.appendChild(button);
  root.appendChild(body);
  return { root, button, body };
}

function activateInviteSection(active, inactive) {
  active.root.classList.add('active');
  active.body.hidden = false;
  inactive.root.classList.remove('active');
  inactive.body.hidden = true;
  inactive.body.innerHTML = '';
}

function createToggleButton(label, initiallyOn, locked) {
  let on = initiallyOn;
  const row = document.createElement('div');
  row.className = 'moxmox-toggle-row';
  if (on) row.classList.add('on');
  if (locked) row.classList.add('locked');

  const track = document.createElement('button');
  track.type = 'button';
  track.className = 'moxmox-toggle-track';
  track.disabled = locked;
  track.setAttribute('role', 'switch');
  track.setAttribute('aria-checked', String(on));

  const thumb = document.createElement('span');
  thumb.className = 'moxmox-toggle-thumb';
  track.appendChild(thumb);

  const text = document.createElement('span');
  text.className = 'moxmox-toggle-label';
  text.textContent = label;

  row.appendChild(track);
  row.appendChild(text);

  if (!locked) {
    const toggle = () => {
      on = !on;
      row.classList.toggle('on', on);
      track.setAttribute('aria-checked', String(on));
    };
    track.addEventListener('click', toggle);
    text.addEventListener('click', toggle);
    text.style.cursor = 'pointer';
  }

  return { el: row, isOn: () => on };
}

function createSharedInvite(container) {
  container.innerHTML = '';

  const settings = document.createElement('div');
  settings.className = 'moxmox-shared-settings';

  // Read popup defaults for toggles.
  chrome.storage.local.get(
    ['moxmox_shared_mirror_battlefield', 'moxmox_shared_sync_gy_exile'],
    (stored) => {
      const bfChecked = stored.moxmox_shared_mirror_battlefield !== false;
      const gyChecked = stored.moxmox_shared_sync_gy_exile !== false;

      const libToggle = createToggleButton('Share Library (always enabled)', true, true);
      const bfToggle = createToggleButton('Share Mirrored Battlefield', bfChecked, false);
      const gyToggle = createToggleButton('Share Graveyard and Exile', gyChecked, false);

      settings.appendChild(libToggle.el);
      settings.appendChild(bfToggle.el);
      settings.appendChild(gyToggle.el);

      const startBtn = document.createElement('button');
      startBtn.className = 'moxmox-popup-copy-btn';
      startBtn.textContent = 'Start';

      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        resetRoomState(GAME_TYPE_SHARED);
        role = 'host';
        const roomId = generateRoomId();
        const shareUrl = buildShareUrl(stripRoomParam(window.location.href), roomId);

        // Store the pending invite URL — renderInviteOutput is called
        // after the join is acknowledged by the server.
        pendingSharedInvite = { shareUrl };

        connectToRoom(roomId, {
          gameType: GAME_TYPE_SHARED,
          shareBattlefield: bfToggle.isOn(),
          shareGraveyardExile: gyToggle.isOn(),
        });
      });

      container.appendChild(settings);
      container.appendChild(startBtn);
    },
  );
}

function renderTraditionalCreate(container) {
  container.innerHTML = '';

  const controls = document.createElement('div');
  controls.className = 'moxmox-traditional-controls';

  const label = document.createElement('label');
  label.textContent = 'Max players';

  const select = document.createElement('select');
  for (const count of [2, 3, 4]) {
    const opt = document.createElement('option');
    opt.value = String(count);
    opt.textContent = String(count);
    select.appendChild(opt);
  }

  const createBtn = document.createElement('button');
  createBtn.className = 'moxmox-popup-copy-btn';
  createBtn.textContent = 'Start';

  const error = document.createElement('div');
  error.className = 'moxmox-popup-error';

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    error.textContent = '';
    try {
      resetRoomState(GAME_TYPE_TRADITIONAL);
      role = 'host';
      maxPlayers = parseInt(select.value, 10);
      const roomId = await createUniqueTraditionalRoom(maxPlayers);
      connectToRoom(roomId, { gameType: GAME_TYPE_TRADITIONAL, maxPlayers });
      // Close the create game popup and show the result popup.
      if (popupBackdrop) {
        popupBackdrop.remove();
        popupBackdrop = null;
      }
      showInviteResultPopup({
        title: 'Game Created',
        subtitle: 'Send this room code to a friend, and have them click "Join" in the MoxMox menu from a Moxfield playtest page.',
        value: roomId,
        copiedText: 'Room code copied to clipboard',
      });
    } catch (err) {
      error.textContent = err.message;
      createBtn.disabled = false;
    }
  });

  label.appendChild(select);
  controls.appendChild(label);
  controls.appendChild(createBtn);
  container.appendChild(controls);
  container.appendChild(error);
}

async function createUniqueTraditionalRoom(players) {
  let lastError = null;
  for (let i = 0; i < 5; i++) {
    const roomId = generateTraditionalRoomCode();
    try {
      await createTraditionalRoom(roomId, players);
      return roomId;
    } catch (err) {
      lastError = err;
      if (!/already exists/i.test(err.message)) throw err;
    }
  }
  throw lastError || new Error('Could not create a unique room code');
}

function renderInviteOutput(container, value, copiedText) {
  container.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'moxmox-popup-url-row';

  const box = document.createElement('div');
  box.className = 'moxmox-popup-url';
  box.textContent = value;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'moxmox-popup-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    copyToClipboard(value);
    showCopiedFeedback(copiedText);
  });

  row.appendChild(box);
  row.appendChild(copyBtn);
  container.appendChild(row);
  showCopiedFeedback(copiedText);
}

function showInviteResultPopup({ title, subtitle, value, copiedText }) {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  copyToClipboard(value);

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';

  const heading = document.createElement('h3');
  heading.textContent = title;

  const desc = document.createElement('p');
  desc.textContent = subtitle;

  const row = document.createElement('div');
  row.className = 'moxmox-popup-url-row';

  const box = document.createElement('div');
  box.className = 'moxmox-popup-url';
  box.textContent = value;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'moxmox-popup-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    copyToClipboard(value);
    copiedMsg.textContent = `✓ ${copiedText}`;
  });

  row.appendChild(box);
  row.appendChild(copyBtn);

  const copiedMsg = document.createElement('div');
  copiedMsg.className = 'moxmox-popup-copied';
  copiedMsg.textContent = `✓ ${copiedText}`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  popup.appendChild(heading);
  popup.appendChild(desc);
  popup.appendChild(row);
  popup.appendChild(copiedMsg);
  popup.appendChild(closeBtn);
  popupBackdrop.appendChild(popup);

  popupBackdrop.addEventListener('click', (e) => {
    if (e.target === popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }
  });

  document.body.appendChild(popupBackdrop);
}

async function createTraditionalRoom(roomId, players) {
  const response = await fetch(`${HTTP_URL}/room/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameType: GAME_TYPE_TRADITIONAL, maxPlayers: players }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Could not create room (${response.status})`);
  }
  return data;
}

async function fetchRoomInfo(roomId) {
  const response = await fetch(`${HTTP_URL}/room/${encodeURIComponent(roomId)}/info`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Room not found (${response.status})`);
  }
  return data;
}

function showTraditionalJoinPopup() {
  ensureUsername(() => {
    if (popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }

    popupBackdrop = document.createElement('div');
    popupBackdrop.className = 'moxmox-popup-backdrop';

    const popup = document.createElement('div');
    popup.className = 'moxmox-popup';

    const heading = document.createElement('h3');
    heading.textContent = 'Join Traditional Game';

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Enter the room code from the host.';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 6;
    input.placeholder = 'ABC234';
    input.className = 'moxmox-room-code-input';

    const status = document.createElement('div');
    status.className = 'moxmox-room-info';

    const joinBtn = document.createElement('button');
    joinBtn.className = 'moxmox-popup-copy-btn';
    joinBtn.textContent = 'Join';
    joinBtn.disabled = true;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'moxmox-popup-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => {
      popupBackdrop.remove();
      popupBackdrop = null;
    });

    let selectedInfo = null;
    let timer = null;
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      selectedInfo = null;
      joinBtn.disabled = true;
      clearTimeout(timer);
      const roomId = input.value.trim();
      if (!isTraditionalRoomCode(roomId)) {
        status.textContent = roomId ? 'Enter a valid 6-character room code.' : '';
        return;
      }
      status.textContent = 'Checking room...';
      timer = setTimeout(async () => {
        try {
          const info = await fetchRoomInfo(roomId);
          if (info.gameType !== GAME_TYPE_TRADITIONAL) {
            throw new Error('That room is not a Traditional game.');
          }
          selectedInfo = info;
          renderJoinRoomInfo(status, info);
          const reconnecting =
            sessionStorage.getItem(SESSION_KEY) === roomId &&
            sessionStorage.getItem(SESSION_GAME_TYPE_KEY) === GAME_TYPE_TRADITIONAL &&
            !!sessionStorage.getItem(SESSION_PLAYER_KEY);
          joinBtn.disabled = info.full && !reconnecting;
        } catch (err) {
          status.textContent = err.message;
          joinBtn.disabled = true;
        }
      }, 250);
    });

    joinBtn.addEventListener('click', () => {
      const roomId = input.value.trim();
      if (!selectedInfo || !isTraditionalRoomCode(roomId)) return;
      const reconnecting =
        sessionStorage.getItem(SESSION_KEY) === roomId &&
        sessionStorage.getItem(SESSION_GAME_TYPE_KEY) === GAME_TYPE_TRADITIONAL &&
        !!sessionStorage.getItem(SESSION_PLAYER_KEY);
      if (!reconnecting) {
        resetRoomState(GAME_TYPE_TRADITIONAL);
      } else {
        gameType = GAME_TYPE_TRADITIONAL;
        traditionalLifeInitialized = false;
      }
      role = 'guest';
      maxPlayers = selectedInfo.maxPlayers;
      connectToRoom(roomId, { gameType: GAME_TYPE_TRADITIONAL, maxPlayers });
      popupBackdrop.remove();
      popupBackdrop = null;
    });

    popup.appendChild(heading);
    popup.appendChild(subtitle);
    popup.appendChild(input);
    popup.appendChild(status);
    popup.appendChild(joinBtn);
    popup.appendChild(closeBtn);
    popupBackdrop.appendChild(popup);
    document.body.appendChild(popupBackdrop);
    setTimeout(() => input.focus(), 50);
  });
}

function renderJoinRoomInfo(container, info) {
  const players = info.players || [];
  container.innerHTML = '';

  const summary = document.createElement('div');
  summary.textContent = `${players.length}/${info.maxPlayers} seats reserved`;
  container.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'moxmox-room-player-list';
  for (const player of players) {
    const row = document.createElement('div');
    row.textContent = `${player.username || 'Anonymous'}${player.connected ? '' : ' (offline)'}`;
    list.appendChild(row);
  }
  if (players.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No players have joined yet.';
    list.appendChild(empty);
  }
  container.appendChild(list);

  if (info.full) {
    const full = document.createElement('div');
    full.className = 'moxmox-popup-error';
    full.textContent = 'This room is full.';
    container.appendChild(full);
  }
}

function showLeaveGamePrompt() {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Leave Game';

  const msg = document.createElement('p');
  msg.textContent = 'Are you sure you want to leave this game?';

  const actions = document.createElement('div');
  actions.className = 'moxmox-popup-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'moxmox-popup-close-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'moxmox-popup-copy-btn';
  leaveBtn.textContent = 'Leave Game';
  leaveBtn.addEventListener('click', () => {
    leaveCurrentGame();
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(leaveBtn);
  popup.appendChild(heading);
  popup.appendChild(msg);
  popup.appendChild(actions);
  popupBackdrop.appendChild(popup);
  document.body.appendChild(popupBackdrop);
}

function leaveCurrentGame() {
  intentionalDisconnect = true;
  stopHeartbeat();
  clearReconnectTimer();
  clearSendThrottle();
  if (ws) {
    // Send leave message before closing so the server frees the seat.
    try { ws.send(JSON.stringify({ type: 'leave' })); } catch (_) {}
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  // Remove the battlefield divider.
  document.querySelector('.moxmox-divider')?.remove();

  currentRoomId = null;
  role = null;
  gameType = null;
  maxPlayers = null;
  shareBattlefield = true;
  shareGraveyardExile = true;
  localPlayerId = null;
  localHandCount = null;
  remoteUsername = null;
  remotePlayers = new Map();
  traditionalLifeInitialized = false;
  gameStarted = false;
  gameSetupDone = false;

  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_ROLE_KEY);
  sessionStorage.removeItem(SESSION_GAME_TYPE_KEY);
  sessionStorage.removeItem(SESSION_PLAYER_KEY);
  sessionStorage.removeItem(SESSION_SHARE_BF_KEY);
  sessionStorage.removeItem(SESSION_SHARE_GY_KEY);

  setLocalStatus('disconnected');
  setRemoteStatus('disconnected');
  updateLocalHandCount(null);
  setRemotePlayersDisplay([]);
  syncGiftStateToMain();
  addLog('out', 'Left game');
  notifyPopup();
}

function showCopiedFeedback(text = 'Copied to clipboard') {
  const msg = document.getElementById('moxmox-copied-msg');
  if (msg) {
    msg.textContent = `✓ ${text}`;
    msg.style.opacity = '0';
    requestAnimationFrame(() => {
      msg.style.transition = 'opacity 0.2s';
      msg.style.opacity = '1';
    });
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

// ── Message log ─────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 200;

function addLog(direction, text) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    direction,
    text,
  };
  messageLog.push(entry);
  if (messageLog.length > MAX_LOG_ENTRIES) messageLog.shift();
  notifyPopup();
}

function notifyPopup() {
  chrome.runtime.sendMessage({
    type: 'moxmox:state-update',
    localStatus,
    remoteStatus,
    role,
    gameType,
    maxPlayers,
    roomId: currentRoomId,
    localHandCount,
    players: [...remotePlayers.values()],
    log: messageLog,
    isGoldfish: true,
  }).catch(() => {});
}

// ── Popup message handler ───────────────────────────────────────────

function handlePopupMessage(message, _sender, sendResponse) {
  if (message?.type === 'moxmox:get-state') {
    sendResponse({
      localStatus,
      remoteStatus,
      role,
      gameType,
      maxPlayers,
      roomId: currentRoomId,
      localHandCount,
      players: [...remotePlayers.values()],
      log: messageLog,
      isGoldfish: true,
    });
    return true;
  }
}
