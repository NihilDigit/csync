// Csync Content Script (dynamically registered on whitelisted sites at document_start)
(function () {
  'use strict';

  const MAX_VALUE_BYTES = 256 * 1024;
  const MAX_ORIGIN_BYTES = 2 * 1024 * 1024;
  const RELOAD_GUARD_KEY = '__csync_ls_reloaded';
  const origin = window.location.origin;
  const sessionKey = `csync_ls_${origin}`;

  function isIncognitoContext() {
    try {
      return Boolean(chrome.extension?.inIncognitoContext);
    } catch {
      return false;
    }
  }

  function snapshotLocalStorage() {
    try {
      const items = [];
      let totalBytes = 0;
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        const value = window.localStorage.getItem(key) ?? '';
        const entryBytes = (key.length + value.length) * 2;
        if (entryBytes > MAX_VALUE_BYTES) continue;
        if (totalBytes + entryBytes > MAX_ORIGIN_BYTES) break;
        items.push({ key, value });
        totalBytes += entryBytes;
      }
      return items;
    } catch {
      return null;
    }
  }

  function applyLocalStorageItems(items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    let changed = false;
    try {
      for (const item of items) {
        if (!item || typeof item.key !== 'string' || !item.key) continue;
        const nextVal = typeof item.value === 'string' ? item.value : '';
        if (window.localStorage.getItem(item.key) !== nextVal) {
          window.localStorage.setItem(item.key, nextVal);
          changed = true;
        }
      }
    } catch {
      // Storage quota or access restricted
    }
    return changed;
  }

  function reloadOnceIfScriptsAlreadyRan() {
    // If no <script> tag has been parsed yet, page JS will read the freshly written
    // localStorage synchronously on first execution without any reload.
    if (document.scripts.length === 0) return;
    try {
      if (window.sessionStorage.getItem(RELOAD_GUARD_KEY) === '1') return;
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    } catch {
      return;
    }
    window.location.reload();
  }

  if (isIncognitoContext()) {
    // Fast path: read directly from in-memory chrome.storage.session at document_start
    chrome.storage.session.get([sessionKey], (result) => {
      if (chrome.runtime.lastError) return;
      const entry = result?.[sessionKey];

      if (entry && Array.isArray(entry.items) && entry.items.length > 0) {
        const changed = applyLocalStorageItems(entry.items);
        if (changed) {
          reloadOnceIfScriptsAlreadyRan();
        }
        return;
      }

      // Cold-cache fallback: ask service worker to capture from an open normal tab
      chrome.runtime.sendMessage(
        { type: 'incognito_needs_localStorage' },
        (response) => {
          if (chrome.runtime.lastError || !response?.success) return;
          const changed = applyLocalStorageItems(response.items);
          if (changed) {
            reloadOnceIfScriptsAlreadyRan();
          }
        }
      );
    });
  } else {
    // Normal window: proactively keep session snapshot warm before user switches to incognito
    let captureTimer = null;

    function pushSnapshot() {
      const items = snapshotLocalStorage();
      if (!items) return;
      chrome.storage.session.set({
        [sessionKey]: {
          origin,
          items,
          timestamp: Date.now()
        }
      });
    }

    function scheduleSnapshot(delayMs = 400) {
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(() => {
        captureTimer = null;
        pushSnapshot();
      }, delayMs);
    }

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          pushSnapshot();
          scheduleSnapshot(1500);
        },
        { once: true }
      );
    } else {
      pushSnapshot();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        pushSnapshot();
      }
    });

    window.addEventListener('pagehide', pushSnapshot);
    window.addEventListener('storage', () => scheduleSnapshot(400));
  }
})();
