// Csync Content Script

(function() {
  'use strict';

  const domain = window.location.hostname;

  // ---- Message handlers ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'get_localStorage') {
      if (!matchDomain(message.domain)) {
        sendResponse({ isOk: false, msg: `domain mismatch: ${message.domain} vs ${domain}` });
        return true;
      }
      try {
        const items = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) items.push({ key, value: localStorage.getItem(key) });
        }
        sendResponse({ isOk: true, msg: 'ok', result: items });
      } catch (e) {
        sendResponse({ isOk: false, msg: 'get localStorage error', result: e.message });
      }
      return true;
    }

    if (message.type === 'set_localStorage') {
      if (!matchDomain(message.domain)) {
        sendResponse({ isOk: false, msg: `domain mismatch: ${message.domain} vs ${domain}` });
        return true;
      }
      try {
        let count = 0;
        for (const item of message.items || []) {
          if (item.key) {
            localStorage.setItem(item.key, item.value || '');
            count++;
          }
        }
        sendResponse({ isOk: true, msg: `set ${count} items` });
      } catch (e) {
        sendResponse({ isOk: false, msg: 'set localStorage error', result: e.message });
      }
      return true;
    }
  });

  // ---- Domain matching ----

  function matchDomain(target) {
    if (!target) return false;
    const host = location.hostname;
    if (host === target) return true;
    if (host.endsWith('.' + target)) return true;
    if (target.endsWith('.' + host)) return true;
    return host.split('.').slice(-2).join('.') === target.split('.').slice(-2).join('.');
  }

  // ---- Init: notify background when incognito page is ready ----

  const isIncognito = chrome.extension.inIncognitoContext;

  function onPageReady() {
    chrome.storage.sync.get(['csync_websites'], (result) => {
      const websites = result.csync_websites || [];
      if (isIncognito && websites.some(w => matchDomain(w))) {
        chrome.runtime.sendMessage({
          type: 'incognito_page_ready',
          domain: domain,
          url: location.href
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageReady);
  } else {
    onPageReady();
  }
})();
