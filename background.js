importScripts('firestore.js');

// ── Auth state ──
let authState = { uid: null, accessToken: null, refreshToken: null, expirationTime: 0 };
let ntsApiToken = null;

// Load saved state on startup
chrome.storage.local.get(['firebaseAuth', 'ntsApiToken']).then(data => {
  if (data.firebaseAuth) authState = data.firebaseAuth;
  if (data.ntsApiToken) ntsApiToken = data.ntsApiToken;
});

async function ensureAuth() {
  if (!authState.refreshToken) return false;
  if (Date.now() >= authState.expirationTime - 300000) {
    try {
      const tokens = await refreshAccessToken(authState.refreshToken);
      authState.accessToken = tokens.accessToken;
      authState.refreshToken = tokens.refreshToken;
      authState.expirationTime = Date.now() + tokens.expiresIn;
      chrome.storage.local.set({ firebaseAuth: authState });
    } catch (e) {
      console.error('Token refresh failed:', e);
      return false;
    }
  }
  return true;
}

// ── Player state ──
let playerState = {
  playing: false,
  url: null,
  title: '',
  subtitle: '',
  artwork: '',
  volume: 0.8,
  type: null
};

// Restore player state from storage (survives service worker restarts)
chrome.storage.local.get('playerState').then(data => {
  if (data.playerState) {
    playerState = { ...playerState, ...data.playerState };
  }
});

function savePlayerState() {
  chrome.storage.local.set({ playerState });
}

let offscreenReady = false;

async function ensureOffscreen() {
  // Always re-check — offscreenReady resets when service worker restarts
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) { offscreenReady = true; return; }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing NTS Radio audio streams'
  });
  offscreenReady = true;
}

// ── Side panel ──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Message router ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;

  switch (msg.action) {
    // Player
    case 'play': handlePlay(msg); break;
    case 'pause': handlePause(); break;
    case 'resume': handleResume(); break;
    case 'stop': handleStop(); break;
    case 'setVolume': handleVolume(msg.volume); break;
    case 'seek': handleSeek(msg.time); break;
    case 'getTime':
      handleGetTime().then(sendResponse);
      return true;
    case 'getState':
      // Check if offscreen doc is still alive — if not, audio stopped
      chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(contexts => {
        if (contexts.length === 0 && playerState.playing) {
          playerState.playing = false;
          savePlayerState();
        }
        sendResponse({ ...playerState });
      });
      return true;
    case 'stateUpdate':
      playerState.playing = msg.state.playing;
      broadcastState();
      break;
    case 'timeUpdate':
      // Forward ephemeral time data to sidepanel (don't persist)
      chrome.runtime.sendMessage({
        action: 'timeUpdate',
        currentTime: msg.currentTime,
        duration: msg.duration
      }).catch(() => {});
      break;

    // Auth
    case 'firebaseAuth':
      authState = {
        uid: msg.uid,
        accessToken: msg.accessToken,
        refreshToken: msg.refreshToken,
        expirationTime: msg.expirationTime
      };
      chrome.storage.local.set({ firebaseAuth: authState });
      chrome.runtime.sendMessage({ action: 'authUpdated', loggedIn: true }).catch(() => {});
      break;
    case 'getAuthStatus':
      sendResponse({ loggedIn: !!authState.uid, uid: authState.uid });
      return true;
    case 'ntsApiToken':
      ntsApiToken = msg.token;
      chrome.storage.local.set({ ntsApiToken });
      break;
    case 'getNtsApiToken':
      sendResponse({ token: ntsApiToken });
      return true;

    // Firestore reads
    case 'getFollows':
      handleGetFollows().then(sendResponse);
      return true;
    case 'getHistory':
      handleGetHistory(msg.limit).then(sendResponse);
      return true;

    // Firestore writes
    case 'addFollow':
      handleAddFollow(msg.showAlias).then(sendResponse);
      return true;
    case 'removeFollow':
      handleRemoveFollow(msg.docId).then(sendResponse);
      return true;
    case 'addFavEpisode':
      handleAddFavEpisode(msg.showAlias, msg.episodeAlias).then(sendResponse);
      return true;
    case 'removeFavEpisode':
      handleRemoveFavEpisode(msg.docId).then(sendResponse);
      return true;
    case 'recordListen':
      handleRecordListen(msg).then(sendResponse);
      return true;
  }
});

// ── Player handlers ──

async function handlePlay(msg) {
  await ensureOffscreen();
  playerState.url = msg.url;
  playerState.title = msg.title || '';
  playerState.subtitle = msg.subtitle || '';
  playerState.artwork = msg.artwork || '';
  playerState.type = msg.type || 'live';
  playerState.playing = true;
  chrome.runtime.sendMessage({
    target: 'offscreen', action: 'play', url: msg.url, volume: playerState.volume
  }).catch(() => {});
  broadcastState();
}

async function handlePause() {
  playerState.playing = false;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' }).catch(() => {});
  broadcastState();
}

async function handleResume() {
  playerState.playing = true;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' }).catch(() => {});
  broadcastState();
}

async function handleStop() {
  playerState.playing = false;
  playerState.url = null;
  playerState.title = '';
  playerState.subtitle = '';
  playerState.artwork = '';
  playerState.type = null;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
  broadcastState();
}

async function handleVolume(volume) {
  playerState.volume = volume;
  savePlayerState();
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'setVolume', volume }).catch(() => {});
}

async function handleSeek(time) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'seek', time }).catch(() => {});
}

async function handleGetTime() {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', action: 'getTime' });
  } catch (e) {
    return { currentTime: 0, duration: 0 };
  }
}

function broadcastState() {
  savePlayerState();
  chrome.runtime.sendMessage({ action: 'playerState', state: { ...playerState } }).catch(() => {});
}

// ── Firestore handlers ──

async function handleGetFollows() {
  if (!await ensureAuth()) return { follows: [], favEpisodes: [] };
  try {
    const all = await firestoreQuery('favourites', authState.uid, authState.accessToken);
    return {
      follows: all.filter(f => !f.episode_alias),
      favEpisodes: all.filter(f => f.episode_alias)
    };
  } catch (e) {
    console.error('getFollows failed:', e);
    return { follows: [], favEpisodes: [], error: e.message };
  }
}

async function handleGetHistory(limit = 50) {
  if (!await ensureAuth()) return { history: [] };
  try {
    const history = await firestoreQuery('archive_plays', authState.uid, authState.accessToken, {
      orderBy: 'played_at', limit: limit || 50
    });
    return { history };
  } catch (e) {
    console.error('getHistory failed:', e);
    return { history: [], error: e.message };
  }
}

async function handleAddFollow(showAlias) {
  if (!await ensureAuth()) return { error: 'Not authenticated' };
  try {
    await firestoreCreate('favourites', {
      device_id: authState.uid,
      show_alias: showAlias,
      episode_alias: '',
      created_at: new Date().toISOString(),
      client: 'nts-extension',
      version: '1.0.0'
    }, authState.accessToken);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleRemoveFollow(docId) {
  if (!await ensureAuth()) return { error: 'Not authenticated' };
  try {
    await firestoreDelete('favourites', docId, authState.accessToken);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleAddFavEpisode(showAlias, episodeAlias) {
  if (!await ensureAuth()) return { error: 'Not authenticated' };
  try {
    await firestoreCreate('favourites', {
      device_id: authState.uid,
      show_alias: showAlias,
      episode_alias: episodeAlias,
      created_at: new Date().toISOString(),
      client: 'nts-extension',
      version: '1.0.0'
    }, authState.accessToken);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleRemoveFavEpisode(docId) {
  if (!await ensureAuth()) return { error: 'Not authenticated' };
  try {
    await firestoreDelete('favourites', docId, authState.accessToken);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleRecordListen(msg) {
  if (!await ensureAuth()) return { error: 'Not authenticated' };
  try {
    await firestoreCreate('archive_plays', {
      device_id: authState.uid,
      show_alias: msg.showAlias || '',
      episode_alias: msg.episodeAlias || '',
      played_at: new Date().toISOString(),
      duration_s: msg.duration || 0,
      client: 'nts-extension',
      version: '1.0.0'
    }, authState.accessToken);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}
