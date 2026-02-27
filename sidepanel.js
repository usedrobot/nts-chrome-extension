const NTS_API = 'https://www.nts.live/api/v2';
const STREAMS = {
  1: 'https://stream-relay-geo.ntslive.net/stream',
  2: 'https://stream-relay-geo.ntslive.net/stream2'
};

// State
let queue = [];
let currentQueueIndex = -1;
let playerState = { playing: false, url: null, title: '', subtitle: '', artwork: '', type: null, volume: 0.8 };
let searchTimeout = null;
let userState = { loggedIn: false, uid: null, follows: [], favEpisodes: [], history: [] };
let followAliases = new Map(); // show_alias -> docId
const showCache = new Map();

let seekDragging = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupTabs();
  setupPlayerControls();
  setupSeekControls();
  setupSearch();
  await loadQueue();
  await syncState();
  fetchLive();
  fetchMixtapes();
  checkAuth();
  requestTimeSync();

  // Refresh live data every 60s
  setInterval(fetchLive, 60000);

  // Listen for state changes and follow syncs from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'playerState') {
      playerState = msg.state;
      updatePlayerBar();
      updatePlayingIndicators();
      // Re-sync time when content changes
      requestTimeSync();
    } else if (msg.action === 'timeUpdate') {
      if (!seekDragging) {
        updateSeekBar(msg.currentTime, msg.duration);
      }
    } else if (msg.action === 'authUpdated') {
      checkAuth();
    }
  });
}

// ── Tabs ──

function setupTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Player Controls ──

function setupPlayerControls() {
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', playPrev);
  $('#btn-next').addEventListener('click', playNext);

  const vol = $('#volume-slider');
  vol.addEventListener('input', () => {
    const v = parseFloat(vol.value);
    playerState.volume = v;
    chrome.runtime.sendMessage({ action: 'setVolume', volume: v });
  });
}

function setupSeekControls() {
  const slider = $('#seek-slider');
  slider.addEventListener('mousedown', () => { seekDragging = true; });
  slider.addEventListener('touchstart', () => { seekDragging = true; });
  slider.addEventListener('change', () => {
    seekDragging = false;
    const time = parseFloat(slider.value);
    chrome.runtime.sendMessage({ action: 'seek', time });
  });
}

function updateSeekBar(currentTime, duration) {
  const slider = $('#seek-slider');
  const curEl = $('#seek-current');
  const durEl = $('#seek-duration');
  slider.max = duration;
  slider.value = currentTime;
  curEl.textContent = fmtDuration(currentTime);
  durEl.textContent = fmtDuration(duration);
}

function requestTimeSync() {
  if (playerState.type !== 'archived') return;
  chrome.runtime.sendMessage({ action: 'getTime' }).then(res => {
    if (res && res.duration) {
      updateSeekBar(res.currentTime, res.duration);
    }
  }).catch(() => {});
}

function fmtDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function togglePlay() {
  if (playerState.playing) {
    chrome.runtime.sendMessage({ action: 'pause' });
  } else if (playerState.url) {
    chrome.runtime.sendMessage({ action: 'resume' });
  } else if (queue.length > 0) {
    // Nothing playing — start the queue
    playQueueItem(currentQueueIndex >= 0 ? currentQueueIndex : 0);
  }
}

function playNext() {
  if (queue.length === 0) return;
  const next = currentQueueIndex + 1;
  playQueueItem(next < queue.length ? next : 0);
}

function playPrev() {
  if (queue.length === 0) return;
  const prev = currentQueueIndex - 1;
  playQueueItem(prev >= 0 ? prev : queue.length - 1);
}

// ── Live ──

async function fetchLive() {
  try {
    const res = await fetch(`${NTS_API}/live`);
    const data = await res.json();
    renderLive(data.results);
  } catch (e) {
    console.error('Failed to fetch live data:', e);
    $('#tab-live').innerHTML = '<div class="error">Failed to load live data</div>';
  }
}

function renderLive(channels) {
  const container = $('#tab-live');
  container.innerHTML = '';

  channels.forEach((ch, i) => {
    const num = i + 1;
    const now = ch.now;
    const details = now?.embeds?.details || {};
    const artwork = details?.media?.background_large || details?.media?.picture_large || '';
    const location = details?.location_long || '';
    const startTime = now?.start_timestamp ? fmtTime(now.start_timestamp) : '';
    const endTime = now?.end_timestamp ? fmtTime(now.end_timestamp) : '';
    const time = startTime && endTime ? `${startTime} – ${endTime}` : '';
    const isPlaying = playerState.url === STREAMS[num] && playerState.playing;

    const card = document.createElement('div');
    card.className = `channel-card${isPlaying ? ' playing' : ''}`;
    card.dataset.channel = num;
    card.innerHTML = `
      <div class="channel-header">
        <span>Channel ${num}</span>
        ${isPlaying ? '<span class="live-dot"></span>' : ''}
      </div>
      <div class="channel-body" style="${artwork ? `background-image:url(${esc(artwork)})` : ''}">
        <div class="channel-overlay">
          <div class="channel-title">${esc(now?.broadcast_title || 'Off Air')}</div>
          ${location ? `<div class="channel-location">${esc(location)}</div>` : ''}
          ${time ? `<div class="channel-time">${time}</div>` : ''}
        </div>
      </div>
      <div class="channel-actions">
        <button class="btn-play-channel" data-channel="${num}">
          ${isPlaying ? 'Pause' : 'Play'}
        </button>
        <button class="btn-queue-channel" data-channel="${num}">+ Queue</button>
      </div>
    `;
    container.appendChild(card);

    // Play button
    card.querySelector('.btn-play-channel').addEventListener('click', () => {
      const playing = playerState.url === STREAMS[num] && playerState.playing;
      if (playing) {
        chrome.runtime.sendMessage({ action: 'pause' });
      } else {
        chrome.runtime.sendMessage({
          action: 'play',
          url: STREAMS[num],
          title: now?.broadcast_title || `Channel ${num}`,
          subtitle: `Channel ${num}`,
          artwork,
          type: 'live'
        });
      }
    });

    // Queue button
    card.querySelector('.btn-queue-channel').addEventListener('click', () => {
      addToQueue({
        id: `live-${num}`,
        title: now?.broadcast_title || `Channel ${num}`,
        subtitle: `Channel ${num} · Live`,
        artwork,
        type: 'live',
        streamUrl: STREAMS[num]
      });
    });

    // Upcoming shows
    const upcoming = [];
    for (let j = 1; j <= 5; j++) {
      const key = j === 1 ? 'next' : `next${j}`;
      if (ch[key]) upcoming.push(ch[key]);
    }
    if (upcoming.length > 0) {
      const upEl = document.createElement('div');
      upEl.className = 'upcoming';
      upEl.innerHTML = '<div class="upcoming-header">Up next</div>' +
        upcoming.map(s => `
          <div class="upcoming-item">
            <span class="upcoming-time">${s.start_timestamp ? fmtTime(s.start_timestamp) : ''}</span>
            <span class="upcoming-title">${esc(s.broadcast_title || '')}</span>
          </div>
        `).join('');
      container.appendChild(upEl);
    }
  });
}

// ── Mixtapes ──

async function fetchMixtapes() {
  try {
    const res = await fetch(`${NTS_API}/mixtapes`);
    const data = await res.json();
    renderMixtapes(data.results);
  } catch (e) {
    console.error('Failed to fetch mixtapes:', e);
    $('#mixtapes-grid').innerHTML = '<div class="error">Failed to load mixtapes</div>';
  }
}

function renderMixtapes(mixtapes) {
  const grid = $('#mixtapes-grid');
  grid.innerHTML = '';

  mixtapes.forEach(mix => {
    const art = mix.media?.picture_large || mix.media?.picture_medium_large || '';
    const url = mix.audio_stream_endpoint;
    const isPlaying = playerState.url === url && playerState.playing;

    const card = document.createElement('div');
    card.className = `mixtape-card${isPlaying ? ' playing' : ''}`;
    card.dataset.streamUrl = url;
    card.innerHTML = `
      <div class="mixtape-art" style="${art ? `background-image:url(${esc(art)})` : ''}">
        <div class="mixtape-play-overlay">${isPlaying ? '\u23F8' : '\u25B6'}</div>
      </div>
      <div class="mixtape-title">${esc(mix.title)}</div>
      <div class="mixtape-subtitle">${esc(mix.subtitle || '')}</div>
    `;

    card.addEventListener('click', () => {
      const nowPlaying = playerState.url === url && playerState.playing;
      if (nowPlaying) {
        chrome.runtime.sendMessage({ action: 'pause' });
      } else {
        chrome.runtime.sendMessage({
          action: 'play',
          url,
          title: mix.title,
          subtitle: 'Infinite Mixtape',
          artwork: art,
          type: 'mixtape'
        });
      }
    });

    // Right-click to queue
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      addToQueue({
        id: `mixtape-${mix.mixtape_alias}`,
        title: mix.title,
        subtitle: 'Infinite Mixtape',
        artwork: art,
        type: 'mixtape',
        streamUrl: url
      });
    });

    grid.appendChild(card);
  });
}

// ── Search ──

function setupSearch() {
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
      $('#search-results').innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(() => searchNTS(q), 350);
  });
}

async function searchNTS(query) {
  const container = $('#search-results');
  container.innerHTML = '<div class="loading">Searching...</div>';

  try {
    const url = `${NTS_API}/search?q=${encodeURIComponent(query)}&version=2&offset=0&limit=24&types[]=episode&types[]=show`;
    const res = await fetch(url);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch (e) {
    console.error('Search failed:', e);
    container.innerHTML = '<div class="error">Search failed</div>';
  }
}

function renderSearchResults(items) {
  const container = $('#search-results');
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">No results</div>';
    return;
  }

  container.innerHTML = '';

  items.forEach(item => {
    const art = item.image?.medium || item.image?.small || '';
    const isEpisode = item.article_type === 'episode';
    const hasAudio = item.audio_sources && item.audio_sources.length > 0;
    const ntsPath = item.article?.path || '';
    const showAlias = (ntsPath.match(/\/shows\/([^/]+)/) || [])[1] || '';
    const isFollowing = followAliases.has(showAlias);

    const el = document.createElement('div');
    el.className = 'search-result';
    el.innerHTML = `
      ${art ? `<img class="result-art" src="${escAttr(art)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="result-info">
        <div class="result-title">${esc(item.title || '')}</div>
        <div class="result-meta">
          <span class="result-type">${isEpisode ? 'Episode' : 'Show'}</span>
          ${item.local_date ? `<span>${esc(item.local_date)}</span>` : ''}
          ${item.location ? `<span>${esc(item.location)}</span>` : ''}
        </div>
        ${item.genres?.length ? `<div class="result-genres">${item.genres.map(g => esc(g.name || g.value || '')).join(' \u00B7 ')}</div>` : ''}
      </div>
      <div class="result-actions">
        ${!isEpisode && userState.loggedIn && showAlias ? `<button class="btn-sm btn-follow${isFollowing ? ' following' : ''}" data-alias="${escAttr(showAlias)}" title="${isFollowing ? 'Unfollow' : 'Follow'}">${isFollowing ? '\u2665' : '\u2661'}</button>` : ''}
        ${!isEpisode && showAlias ? `<button class="btn-sm btn-show-eps" title="Browse episodes">\u25BC</button>` : ''}
        ${isEpisode && hasAudio ? `<button class="btn-sm btn-play-result" title="Play">\u25B6</button>` : ''}
        ${isEpisode && hasAudio ? `<button class="btn-sm btn-add-queue" title="Add to queue">+</button>` : ''}
        ${ntsPath ? `<button class="btn-sm btn-open" title="Open on NTS">\u2197</button>` : ''}
      </div>
    `;

    // Follow/unfollow
    const followBtn = el.querySelector('.btn-follow');
    if (followBtn) {
      followBtn.addEventListener('click', async () => {
        const alias = followBtn.dataset.alias;
        await toggleFollow(alias);
        followBtn.classList.toggle('following', followAliases.has(alias));
        followBtn.textContent = followAliases.has(alias) ? '\u2665' : '\u2661';
        followBtn.title = followAliases.has(alias) ? 'Unfollow' : 'Follow';
      });
    }

    // Browse show episodes
    const showEpsBtn = el.querySelector('.btn-show-eps');
    if (showEpsBtn) {
      showEpsBtn.addEventListener('click', async () => {
        const existing = el.querySelector('.episode-list');
        if (existing) { existing.remove(); showEpsBtn.textContent = '\u25BC'; return; }
        showEpsBtn.textContent = '\u25B2';
        await expandShowEpisodes(el, showAlias, item.title, art);
      });
    }

    // Play episode directly
    const playResultBtn = el.querySelector('.btn-play-result');
    if (playResultBtn) {
      playResultBtn.addEventListener('click', async () => {
        const scSrc = item.audio_sources?.find(s => s.source === 'soundcloud');
        if (!scSrc?.url) { showToast('No playable audio'); return; }
        showToast('Resolving stream...');
        const streamUrl = await resolveStream(scSrc.url);
        if (streamUrl) {
          chrome.runtime.sendMessage({
            action: 'play',
            url: streamUrl,
            title: item.title,
            subtitle: item.local_date || 'Archived',
            artwork: art,
            type: 'archived'
          });
          const epAlias = (ntsPath.match(/\/episodes\/([^/]+)/) || [])[1] || '';
          if (showAlias) recordListen(showAlias, epAlias);
        } else {
          showToast('Could not resolve stream');
        }
      });
    }

    // Add to queue
    const addBtn = el.querySelector('.btn-add-queue');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const scSrc = item.audio_sources?.find(s => s.source === 'soundcloud');
        const mixcloudSrc = item.audio_sources?.find(s => s.source === 'mixcloud');
        addToQueue({
          id: `episode-${ntsPath}`,
          title: item.title,
          subtitle: item.local_date || 'Archived',
          artwork: art,
          type: 'archived',
          soundcloudUrl: scSrc?.url || null,
          mixcloudUrl: mixcloudSrc?.url || null,
          ntsUrl: ntsPath ? `https://www.nts.live${ntsPath}` : null
        });
      });
    }

    // Open on NTS
    const openBtn = el.querySelector('.btn-open');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: `https://www.nts.live${ntsPath}` });
      });
    }

    container.appendChild(el);
  });
}

// ── Auth & Follows ──
// Auth tokens are read from NTS's Firebase IndexedDB by content.js and sent to the background.
// Follows and history are fetched from Firestore via the background service worker.

async function checkAuth() {
  const section = $('#auth-section');
  section.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const authStatus = await chrome.runtime.sendMessage({ action: 'getAuthStatus' });
    if (!authStatus?.loggedIn) {
      userState.loggedIn = false;
      renderAuthSection();
      return;
    }

    userState.loggedIn = true;
    userState.uid = authStatus.uid;

    // Fetch follows and history in parallel
    const [followsData, historyData] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getFollows' }),
      chrome.runtime.sendMessage({ action: 'getHistory', limit: 30 })
    ]);

    userState.follows = followsData?.follows || [];
    userState.favEpisodes = followsData?.favEpisodes || [];
    userState.history = historyData?.history || [];

    // Build lookup map
    followAliases.clear();
    userState.follows.forEach(f => followAliases.set(f.show_alias, f._id));

    renderAuthSection();
    renderFollows();
    renderHistory();
  } catch (e) {
    console.error('Auth check failed:', e);
    userState.loggedIn = false;
    renderAuthSection();
  }
}

let ntsApiToken = null;

async function getNtsApiToken() {
  if (ntsApiToken) return ntsApiToken;
  // Try background (populated by content script)
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getNtsApiToken' });
    if (result?.token) { ntsApiToken = result.token; return ntsApiToken; }
  } catch (e) {}
  // Fallback: fetch NTS homepage and parse token from HTML
  try {
    const res = await fetch('https://www.nts.live/');
    const html = await res.text();
    const match = html.match(/NTS_API_TOKEN['"]\s*:\s*['"]([^'"]+)['"]/);
    if (match) {
      ntsApiToken = match[1];
      chrome.runtime.sendMessage({ action: 'ntsApiToken', token: ntsApiToken }).catch(() => {});
      return ntsApiToken;
    }
  } catch (e) {}
  return null;
}

async function resolveStream(soundcloudUrl) {
  const token = await getNtsApiToken();
  try {
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Basic ${token}`;
    const res = await fetch(
      `${NTS_API}/resolve-stream?url=${encodeURIComponent(soundcloudUrl)}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      return data.url || data.hls || null;
    }
  } catch (e) {
    console.error('Failed to resolve stream:', e);
  }
  return null;
}

function renderAuthSection() {
  const section = $('#auth-section');

  if (userState.loggedIn) {
    const count = userState.follows.length;
    section.innerHTML = `
      <div class="section-header-row">
        <span class="section-header">Following (${count})</span>
        <button class="btn-resync" id="btn-resync" title="Re-sync from NTS">Sync</button>
      </div>
      <div id="favourites-list"></div>
    `;
    section.querySelector('#btn-resync').addEventListener('click', async () => {
      showToast('Syncing...');
      await checkAuth();
    });
  } else {
    section.innerHTML = `
      <div class="auth-logged-out">
        <p>Sign in to NTS to sync your followed shows and listen history</p>
        <button class="btn-login" id="btn-nts-login">Open NTS</button>
        <p class="hint" style="margin-top:8px">Sign in on nts.live, then your data syncs automatically</p>
      </div>
    `;
    section.querySelector('#btn-nts-login')?.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.nts.live/my-nts' });
    });
  }
}

async function fetchShowInfo(alias) {
  if (showCache.has(alias)) return showCache.get(alias);
  try {
    const res = await fetch(`${NTS_API}/shows/${alias}`);
    if (res.ok) {
      const data = await res.json();
      showCache.set(alias, data);
      return data;
    }
  } catch (e) {}
  showCache.set(alias, null);
  return null;
}

function formatAlias(alias) {
  return (alias || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatBroadcastDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function fetchShowEpisodes(alias) {
  try {
    const res = await fetch(`${NTS_API}/shows/${alias}/episodes?offset=0&limit=12`);
    if (res.ok) {
      const data = await res.json();
      return data.results || [];
    }
  } catch (e) {}
  // Fallback: try show info which may include episodes
  const show = await fetchShowInfo(alias);
  return show?.episodes?.results || [];
}

async function expandShowEpisodes(parentEl, showAlias, showTitle, showArt) {
  const epList = document.createElement('div');
  epList.className = 'episode-list';
  epList.innerHTML = '<div class="loading">Loading episodes...</div>';
  parentEl.appendChild(epList);

  const episodes = await fetchShowEpisodes(showAlias);
  if (episodes.length === 0) {
    epList.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:11px">No episodes found</div>';
    return;
  }

  epList.innerHTML = '';
  episodes.forEach(ep => {
    const scSrc = ep.audio_sources?.find(s => s.source === 'soundcloud');
    const epArt = ep.media?.picture_large || ep.media?.picture_medium_large || showArt || '';
    const epAlias = ep.episode_alias || '';

    const epEl = document.createElement('div');
    epEl.className = 'episode-item';
    epEl.innerHTML = `
      <div class="episode-info">
        <div class="episode-title">${esc(ep.name || ep.broadcast_title || showTitle)}</div>
        <div class="episode-date">${esc(ep.local_date || formatBroadcastDate(ep.broadcast))}</div>
        ${ep.genres?.length ? `<div class="episode-genres">${ep.genres.map(g => esc(g.value || g.name || '')).join(' \u00B7 ')}</div>` : ''}
      </div>
      <div class="episode-actions">
        ${scSrc ? `<button class="btn-sm btn-ep-play" title="Play">\u25B6</button>` : ''}
        ${scSrc ? `<button class="btn-sm btn-ep-queue" title="Add to queue">+</button>` : ''}
      </div>
    `;

    const playBtn = epEl.querySelector('.btn-ep-play');
    if (playBtn) {
      playBtn.addEventListener('click', async () => {
        showToast('Resolving stream...');
        const streamUrl = await resolveStream(scSrc.url);
        if (streamUrl) {
          chrome.runtime.sendMessage({
            action: 'play',
            url: streamUrl,
            title: ep.name || ep.broadcast_title || showTitle,
            subtitle: ep.local_date || 'Archived',
            artwork: epArt,
            type: 'archived'
          });
          recordListen(showAlias, epAlias);
        } else {
          showToast('Could not resolve stream');
        }
      });
    }

    const queueBtn = epEl.querySelector('.btn-ep-queue');
    if (queueBtn) {
      queueBtn.addEventListener('click', () => {
        addToQueue({
          id: `episode-${showAlias}-${epAlias}`,
          title: ep.name || ep.broadcast_title || showTitle,
          subtitle: ep.local_date || 'Archived',
          artwork: epArt,
          type: 'archived',
          soundcloudUrl: scSrc.url,
          ntsUrl: `https://www.nts.live/shows/${showAlias}/episodes/${epAlias}`
        });
      });
    }

    epList.appendChild(epEl);
  });
}

async function renderFollows() {
  const container = $('#favourites-list');
  if (!container) return;

  const follows = userState.follows;
  if (follows.length === 0) {
    container.innerHTML = '<div class="favourites-empty">No followed shows</div>';
    return;
  }

  container.innerHTML = '<div class="loading">Loading shows...</div>';

  // Fetch show details in parallel
  const showInfos = await Promise.all(
    follows.map(f => fetchShowInfo(f.show_alias))
  );

  // Sort followed hosts by most recent broadcast
  const combined = follows.map((fav, i) => ({ fav, show: showInfos[i] }));
  combined.sort((a, b) => {
    const aEps = a.show?.embeds?.episodes?.results || [];
    const bEps = b.show?.embeds?.episodes?.results || [];
    const aDate = aEps[0]?.broadcast || '';
    const bDate = bEps[0]?.broadcast || '';
    return bDate.localeCompare(aDate);
  });

  container.innerHTML = '';
  combined.forEach(({ fav, show }) => {
    const name = show?.name || formatAlias(fav.show_alias);
    const artwork = show?.media?.background_large || show?.media?.picture_large || '';
    const episodes = show?.embeds?.episodes?.results || show?.episodes?.results || [];
    const latestEp = Array.isArray(episodes) ? episodes[0] : null;
    const scSrc = latestEp?.audio_sources?.find(s => s.source === 'soundcloud');
    const latestDate = formatBroadcastDate(latestEp?.broadcast);

    const el = document.createElement('div');
    el.className = 'fav-item';
    el.innerHTML = `
      ${artwork ? `<img class="fav-art" src="${escAttr(artwork)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="fav-info">
        <div class="fav-title">${esc(name)}</div>
        ${latestEp ? `<div class="fav-meta">${esc(latestEp.name || latestEp.broadcast_title || '')}${latestDate ? ` \u00B7 ${latestDate}` : ''}</div>` : ''}
      </div>
      <div class="fav-actions">
        ${scSrc ? `<button class="btn-sm btn-fav-play" title="Play latest episode">\u25B6</button>` : ''}
        <button class="btn-sm btn-show-eps" title="Browse episodes">\u25BC</button>
        <button class="btn-sm btn-fav-unfollow" title="Unfollow">\u2715</button>
        <button class="btn-sm btn-fav-open" title="Open on NTS">\u2197</button>
      </div>
    `;

    // Play latest episode
    el.querySelector('.btn-fav-play')?.addEventListener('click', async () => {
      if (!scSrc?.url) return;
      showToast('Resolving stream...');
      const streamUrl = await resolveStream(scSrc.url);
      if (streamUrl) {
        chrome.runtime.sendMessage({
          action: 'play',
          url: streamUrl,
          title: latestEp.name || latestEp.broadcast_title || name,
          subtitle: latestEp.local_date || 'Archived',
          artwork: latestEp.media?.picture_large || artwork,
          type: 'archived'
        });
        recordListen(fav.show_alias, latestEp.episode_alias || '');
      } else {
        showToast('Could not resolve stream');
      }
    });

    // Browse episodes
    el.querySelector('.btn-show-eps').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const existing = el.querySelector('.episode-list');
      if (existing) { existing.remove(); btn.textContent = '\u25BC'; return; }
      btn.textContent = '\u25B2';
      await expandShowEpisodes(el, fav.show_alias, name, artwork);
    });

    // Unfollow
    el.querySelector('.btn-fav-unfollow').addEventListener('click', async () => {
      const result = await chrome.runtime.sendMessage({ action: 'removeFollow', docId: fav._id });
      if (result?.success) {
        userState.follows = userState.follows.filter(f => f._id !== fav._id);
        followAliases.delete(fav.show_alias);
        renderAuthSection();
        renderFollows();
        showToast('Unfollowed');
      } else {
        showToast(result?.error || 'Failed to unfollow');
      }
    });

    // Open on NTS
    el.querySelector('.btn-fav-open').addEventListener('click', () => {
      chrome.tabs.create({ url: `https://www.nts.live/shows/${fav.show_alias}` });
    });

    container.appendChild(el);
  });
}

function renderHistory() {
  const section = $('#history-section');
  const list = $('#history-list');
  if (!section || !list) return;

  if (!userState.loggedIn || userState.history.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  userState.history.forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const date = item.played_at ? new Date(item.played_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    const showName = formatAlias(item.show_alias || '');
    const epName = formatAlias(item.episode_alias || '');

    el.innerHTML = `
      <div class="history-info">
        <div class="history-title">${esc(epName || showName)}</div>
        <div class="history-meta">${esc(showName)}${date ? ` \u00B7 ${date}` : ''}</div>
      </div>
      <div class="history-actions">
        ${item.show_alias && item.episode_alias ? `<button class="btn-sm btn-history-play" title="Play">\u25B6</button>` : ''}
        <button class="btn-sm btn-history-open" title="Open on NTS">\u2197</button>
      </div>
    `;

    const histPlayBtn = el.querySelector('.btn-history-play');
    if (histPlayBtn) {
      histPlayBtn.addEventListener('click', async () => {
        showToast('Loading episode...');
        try {
          const res = await fetch(`${NTS_API}/shows/${item.show_alias}/episodes/${item.episode_alias}`);
          if (!res.ok) throw new Error('Not found');
          const ep = await res.json();
          const scSrc = ep.audio_sources?.find(s => s.source === 'soundcloud');
          if (!scSrc?.url) { showToast('No playable audio'); return; }
          const streamUrl = await resolveStream(scSrc.url);
          if (streamUrl) {
            chrome.runtime.sendMessage({
              action: 'play',
              url: streamUrl,
              title: ep.name || ep.broadcast_title || showName,
              subtitle: ep.local_date || 'Archived',
              artwork: ep.media?.picture_large || '',
              type: 'archived'
            });
          } else {
            showToast('Could not resolve stream');
          }
        } catch (e) {
          showToast('Could not load episode');
        }
      });
    }

    el.querySelector('.btn-history-open').addEventListener('click', () => {
      const path = item.episode_alias
        ? `/shows/${item.show_alias}/episodes/${item.episode_alias}`
        : `/shows/${item.show_alias}`;
      chrome.tabs.create({ url: `https://www.nts.live${path}` });
    });

    list.appendChild(el);
  });
}

function recordListen(showAlias, episodeAlias) {
  chrome.runtime.sendMessage({
    action: 'recordListen',
    showAlias: showAlias || '',
    episodeAlias: episodeAlias || '',
    duration: 0
  }).catch(() => {});
}

async function toggleFollow(showAlias) {
  if (!userState.loggedIn) {
    showToast('Sign in to NTS first');
    return;
  }

  if (followAliases.has(showAlias)) {
    // Unfollow
    const docId = followAliases.get(showAlias);
    const result = await chrome.runtime.sendMessage({ action: 'removeFollow', docId });
    if (result?.success) {
      userState.follows = userState.follows.filter(f => f._id !== docId);
      followAliases.delete(showAlias);
      renderAuthSection();
      renderFollows();
      showToast('Unfollowed');
    } else {
      showToast(result?.error || 'Failed to unfollow');
    }
  } else {
    // Follow
    const result = await chrome.runtime.sendMessage({ action: 'addFollow', showAlias });
    if (result?.success) {
      showToast('Followed');
      await checkAuth(); // refresh follows list
    } else {
      showToast(result?.error || 'Failed to follow');
    }
  }
}

// ── Queue ──

async function loadQueue() {
  const data = await chrome.storage.local.get(['queue', 'currentQueueIndex']);
  queue = data.queue || [];
  currentQueueIndex = data.currentQueueIndex ?? -1;
  renderQueue();
}

function saveQueue() {
  chrome.storage.local.set({ queue, currentQueueIndex });
}

function addToQueue(item) {
  if (queue.find(q => q.id === item.id)) {
    showToast('Already in queue');
    return;
  }
  queue.push(item);
  saveQueue();
  renderQueue();
  showToast(`Added to queue`);
}

function removeFromQueue(index) {
  queue.splice(index, 1);
  if (currentQueueIndex >= queue.length) currentQueueIndex = queue.length - 1;
  if (queue.length === 0) currentQueueIndex = -1;
  saveQueue();
  renderQueue();
}

async function playQueueItem(index) {
  if (index < 0 || index >= queue.length) return;
  currentQueueIndex = index;
  const item = queue[index];

  if (item.type === 'archived') {
    // Try to resolve SoundCloud URL to a playable stream
    if (item.soundcloudUrl) {
      showToast('Resolving stream...');
      const streamUrl = await resolveStream(item.soundcloudUrl);
      if (streamUrl) {
        chrome.runtime.sendMessage({
          action: 'play',
          url: streamUrl,
          title: item.title,
          subtitle: item.subtitle,
          artwork: item.artwork,
          type: 'archived'
        });
        // Record listen for history tracking
        const pathMatch = (item.ntsUrl || '').match(/\/shows\/([^/]+)(?:\/episodes\/([^/]+))?/);
        if (pathMatch) recordListen(pathMatch[1], pathMatch[2] || '');
        saveQueue();
        renderQueue();
        return;
      }
    }
    // Fallback: open on NTS/Mixcloud
    const url = item.ntsUrl || item.mixcloudUrl;
    if (url) chrome.tabs.create({ url });
    showToast('Could not resolve stream, opening NTS');
  } else {
    chrome.runtime.sendMessage({
      action: 'play',
      url: item.streamUrl,
      title: item.title,
      subtitle: item.subtitle,
      artwork: item.artwork,
      type: item.type
    });
  }

  saveQueue();
  renderQueue();
}

function renderQueue() {
  const list = $('#queue-list');
  const empty = $('#queue-empty');

  if (queue.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display = 'block';
  empty.style.display = 'none';
  list.innerHTML = '';

  queue.forEach((item, i) => {
    const isCurrent = i === currentQueueIndex;
    const el = document.createElement('div');
    el.className = `queue-item${isCurrent ? ' current' : ''}`;
    el.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      ${item.artwork ? `<img class="queue-art" src="${escAttr(item.artwork)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="queue-info">
        <div class="queue-title">${esc(item.title)}</div>
        <div class="queue-subtitle">
          <span class="queue-type-badge">${esc(item.type)}</span>
          ${esc(item.subtitle)}
        </div>
      </div>
      <div class="queue-actions">
        <button class="btn-sm btn-queue-play" title="Play">\u25B6</button>
        <button class="btn-sm btn-queue-rm" title="Remove">\u2715</button>
      </div>
    `;

    el.querySelector('.btn-queue-play').addEventListener('click', () => playQueueItem(i));
    el.querySelector('.btn-queue-rm').addEventListener('click', () => removeFromQueue(i));

    list.appendChild(el);
  });
}

// ── Player Bar ──

async function syncState() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getState' });
    if (state) {
      playerState = state;
      updatePlayerBar();
      updatePlayingIndicators();
      $('#volume-slider').value = state.volume ?? 0.8;
    }
  } catch (e) { /* background not ready */ }
}

function updatePlayerBar() {
  const title = $('#player-title');
  const subtitle = $('#player-subtitle');
  const artwork = $('#player-artwork');
  const playIcon = $('.icon-play');
  const pauseIcon = $('.icon-pause');

  if (playerState.url) {
    title.textContent = playerState.title || 'NTS Radio';
    subtitle.textContent = playerState.subtitle || '';
    if (playerState.artwork) {
      artwork.src = playerState.artwork;
      artwork.style.display = 'block';
    } else {
      artwork.style.display = 'none';
    }
  } else {
    title.textContent = 'Not playing';
    subtitle.textContent = '';
    artwork.style.display = 'none';
  }

  if (playerState.playing) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }

  // Show seek bar only for archived content
  const seekRow = $('#seek-row');
  if (playerState.type === 'archived' && playerState.url) {
    seekRow.style.display = 'flex';
  } else {
    seekRow.style.display = 'none';
    // Reset when switching away from archived
    $('#seek-slider').value = 0;
    $('#seek-current').textContent = '0:00';
    $('#seek-duration').textContent = '0:00';
  }
}

function updatePlayingIndicators() {
  // Live channel cards
  document.querySelectorAll('.channel-card').forEach(card => {
    const ch = parseInt(card.dataset.channel);
    const isPlaying = playerState.url === STREAMS[ch] && playerState.playing;
    card.classList.toggle('playing', isPlaying);
    const btn = card.querySelector('.btn-play-channel');
    if (btn) btn.textContent = isPlaying ? 'Pause' : 'Play';
    const header = card.querySelector('.channel-header');
    if (header) {
      const dot = header.querySelector('.live-dot');
      if (isPlaying && !dot) {
        const d = document.createElement('span');
        d.className = 'live-dot';
        header.appendChild(d);
      } else if (!isPlaying && dot) {
        dot.remove();
      }
    }
  });

  // Mixtape cards
  document.querySelectorAll('.mixtape-card').forEach(card => {
    const url = card.dataset.streamUrl;
    const isPlaying = playerState.url === url && playerState.playing;
    card.classList.toggle('playing', isPlaying);
    const overlay = card.querySelector('.mixtape-play-overlay');
    if (overlay) overlay.textContent = isPlaying ? '\u23F8' : '\u25B6';
  });
}

// ── Toast ──

function showToast(message) {
  let toast = $('#toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('show');
  // Force reflow for re-triggering animation
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ── Utilities ──

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
