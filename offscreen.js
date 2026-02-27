const audio = document.getElementById('player');
let hls = null;

function destroyHls() {
  if (hls) { hls.destroy(); hls = null; }
}

function playUrl(url, volume) {
  destroyHls();
  audio.volume = volume ?? 0.8;

  if (url.includes('.m3u8') && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(console.error));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        console.error('HLS fatal error:', data.type);
        chrome.runtime.sendMessage({ action: 'stateUpdate', state: { playing: false } }).catch(() => {});
      }
    });
  } else {
    audio.src = url;
    audio.play().catch(console.error);
  }
}

// Throttled time updates (~1/sec)
let lastTimeUpdate = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastTimeUpdate < 1000) return;
  lastTimeUpdate = now;
  const duration = audio.duration;
  if (!duration || !isFinite(duration)) return;
  chrome.runtime.sendMessage({
    action: 'timeUpdate',
    currentTime: audio.currentTime,
    duration
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'play':
      playUrl(msg.url, msg.volume);
      break;
    case 'pause':
      audio.pause();
      break;
    case 'resume':
      audio.play().catch(console.error);
      break;
    case 'stop':
      audio.pause();
      destroyHls();
      audio.removeAttribute('src');
      audio.load();
      break;
    case 'setVolume':
      audio.volume = msg.volume;
      break;
    case 'seek':
      audio.currentTime = msg.time;
      break;
    case 'getTime': {
      const duration = audio.duration;
      sendResponse({
        currentTime: audio.currentTime,
        duration: (duration && isFinite(duration)) ? duration : 0
      });
      return true;
    }
  }
});

audio.addEventListener('playing', () => {
  chrome.runtime.sendMessage({ action: 'stateUpdate', state: { playing: true } }).catch(() => {});
});

audio.addEventListener('pause', () => {
  chrome.runtime.sendMessage({ action: 'stateUpdate', state: { playing: false } }).catch(() => {});
});

audio.addEventListener('error', () => {
  chrome.runtime.sendMessage({ action: 'stateUpdate', state: { playing: false } }).catch(() => {});
});
