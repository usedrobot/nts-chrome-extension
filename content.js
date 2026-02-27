// Content script — runs on nts.live pages
// Reads Firebase auth tokens from IndexedDB and the NTS API token from the page,
// then sends them to the extension.

const FIREBASE_IDB_KEY = 'firebase:authUser:AIzaSyA4Qp5AvHC8Rev72-10-_DY614w_bxUCJU:[DEFAULT]';

function readFirebaseAuth() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open('firebaseLocalStorageDb');
    } catch (e) {
      return resolve(null);
    }
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('firebaseLocalStorage', 'readonly');
        const store = tx.objectStore('firebaseLocalStorage');
        const get = store.get(FIREBASE_IDB_KEY);
        get.onsuccess = () => {
          const val = get.result?.value;
          if (val?.uid && val?.stsTokenManager) {
            resolve({
              uid: val.uid,
              accessToken: val.stsTokenManager.accessToken,
              refreshToken: val.stsTokenManager.refreshToken,
              expirationTime: val.stsTokenManager.expirationTime
            });
          } else {
            resolve(null);
          }
        };
        get.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    };
  });
}

// Extract NTS API token from page script tags (used for resolve-stream auth)
function extractNtsApiToken() {
  for (const script of document.querySelectorAll('script')) {
    const match = script.textContent.match(/NTS_API_TOKEN['"]\s*:\s*['"]([^'"]+)['"]/);
    if (match) return match[1];
  }
  return null;
}

// Send auth tokens and API token to extension on page load
readFirebaseAuth().then(auth => {
  if (auth) {
    chrome.runtime.sendMessage({ action: 'firebaseAuth', ...auth }).catch(() => {});
  }
});

const apiToken = extractNtsApiToken();
if (apiToken) {
  chrome.runtime.sendMessage({ action: 'ntsApiToken', token: apiToken }).catch(() => {});
}

// Respond to manual sync requests
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'requestAuth') {
    readFirebaseAuth().then(auth => sendResponse(auth));
    return true;
  }
});
