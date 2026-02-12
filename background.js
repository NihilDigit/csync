// Csync Background Script

let configuredWebsites = [];
let configuredWebsitesLoaded = false;
let configuredWebsitesLoadingPromise = null;

// ---- Debounce & batching ----
const lastSyncTime = new Map();
const SYNC_COOLDOWN = 5000;

// Persisted to storage.local so pending domains survive service worker restarts
const changedDomainSet = new Set();
const CHANGED_DOMAINS_KEY = 'csync_pending_domains';
const DEBOUNCE_DELAY_MS = 3000;
const MAX_DEBOUNCE_WAIT_MS = 15000;
const COOKIE_DEBOUNCE_ALARM = 'csync_cookie_debounce';
const COOKIE_MAXWAIT_ALARM = 'csync_cookie_maxwait';
const INIT_CACHE_ALARM = 'csync_init_cache';
let cookieDebounceScheduledAt = 0;

// ---- Init ----
console.log('Csync service worker starting');

chrome.runtime.onInstalled.addListener(() => {
  console.log('Csync installed');
  loadWebsites();
  createContextMenus();
  // Delay cache init via alarm for MV3 reliability
  chrome.alarms.create(INIT_CACHE_ALARM, { delayInMinutes: 0.01 });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Csync startup');
  loadWebsites();
  chrome.alarms.create(INIT_CACHE_ALARM, { delayInMinutes: 0.02 });
});

// ---- Message handling ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'websites_updated') {
      configuredWebsites = message.websites;
      configuredWebsitesLoaded = true;
      console.log('Websites updated:', configuredWebsites);
      await initCache();
      sendResponse({ success: true });

    } else if (message.type === 'manual_sync_request') {
      await manualSync(message.domain);
      sendResponse({ success: true });

    } else if (message.type === 'get_sync_status') {
      const status = await getSyncStatus(message.domain);
      sendResponse({ success: true, data: status });

    } else if (message.type === 'incognito_page_ready') {
      await handleIncognitoPageReady(message.domain, message.url, sender.tab);
      sendResponse({ success: true });
    }
  })().catch((error) => {
    console.error('Message handler error:', error);
    sendResponse({ success: false, error: error?.message || String(error) });
  });

  return true;
});

function loadWebsites() {
  if (configuredWebsitesLoadingPromise) {
    return configuredWebsitesLoadingPromise;
  }

  configuredWebsitesLoadingPromise = (async () => {
    const result = await chrome.storage.sync.get(['csync_websites']);
    configuredWebsites = result.csync_websites || [];
    configuredWebsitesLoaded = true;
    console.log('Loaded websites:', configuredWebsites);
    return configuredWebsites;
  })().finally(() => {
    configuredWebsitesLoadingPromise = null;
  });

  return configuredWebsitesLoadingPromise;
}

async function ensureWebsitesLoaded() {
  if (configuredWebsitesLoaded && Array.isArray(configuredWebsites)) {
    return configuredWebsites;
  }
  return await loadWebsites();
}

function createContextMenus() {
  try {
    chrome.contextMenus.create({
      id: 'csync_sync_current',
      title: 'Sync cookies & localStorage to incognito',
      contexts: ['page']
    });
  } catch (e) {
    // May throw on duplicate creation (e.g. service worker restart)
    console.warn('Context menu create failed:', e);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'csync_sync_current') {
    try {
      const url = new URL(tab.url);
      manualSync(url.hostname);
    } catch (e) {
      console.error('Invalid URL:', tab.url);
    }
  }
});

// ---- Cache (cookies + localStorage) ----

async function initCache() {
  await ensureWebsitesLoaded();
  if (configuredWebsites.length === 0) return;

  console.log('Initializing cache for', configuredWebsites.length, 'websites');
  await Promise.all(configuredWebsites.map(w => cacheCookiesForDomain(w)));
  console.log('Cache initialized');
}

async function cacheCookiesForDomain(domain) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: domain, storeId: '0' });
    
    if (cookies.length === 0) {
      console.log(`No cookies found for ${domain} in normal window`);
      return;
    }

    const cacheKey = `csync_cookie_${domain}`;
    const cacheData = {
      domain: domain,
      cookies: cookies,
      timestamp: Date.now()
    };
    
    await chrome.storage.local.set({ [cacheKey]: cacheData });
    console.log(`Cached ${cookies.length} cookies for ${domain}`);
    
  } catch (error) {
    console.error(`Failed to cache cookies for ${domain}:`, error);
  }
}

async function cacheLocalStorageForDomain(domain) {
  try {
    const tabs = await chrome.tabs.query({});
    const normalTab = tabs.find(t => {
      if (t.incognito || !t.url) return false;
      try {
        return domainMatches(new URL(t.url).hostname, domain);
      } catch {
        return false;
      }
    });

    if (!normalTab) {
      console.log(`[localStorage] No normal tab found for ${domain}`);
      return null;
    }

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(normalTab.id, {
        type: 'get_localStorage',
        domain: domain
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('[localStorage] Failed to get:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }

        if (response && response.isOk) {
          const cacheKey = `csync_localStorage_${domain}`;
          chrome.storage.local.set({
            [cacheKey]: { domain, items: response.result, timestamp: Date.now() }
          });
          console.log(`[localStorage] Cached ${response.result.length} items for ${domain}`);
          resolve(response.result);
        } else {
          console.log('[localStorage] Response not ok:', response?.msg);
          resolve(null);
        }
      });
    });
  } catch (error) {
    console.error(`[localStorage] Failed to cache for ${domain}:`, error);
    return null;
  }
}

async function getCachedCookies(domain) {
  let cacheKey = `csync_cookie_${domain}`;
  let result = await chrome.storage.local.get([cacheKey]);
  
  if (result[cacheKey]) {
    return result[cacheKey].cookies;
  }
  
  // Try parent domain match
  for (const website of configuredWebsites) {
    if (domain === website || domain.endsWith('.' + website)) {
      cacheKey = `csync_cookie_${website}`;
      result = await chrome.storage.local.get([cacheKey]);
      if (result[cacheKey]) {
        return result[cacheKey].cookies;
      }
    }
  }
  
  return [];
}

async function getCachedLocalStorage(domain) {
  let cacheKey = `csync_localStorage_${domain}`;
  let result = await chrome.storage.local.get([cacheKey]);
  
  if (result[cacheKey]) {
    return result[cacheKey].items;
  }
  
  // Try parent domain match
  for (const website of configuredWebsites) {
    if (domain === website || domain.endsWith('.' + website)) {
      cacheKey = `csync_localStorage_${website}`;
      result = await chrome.storage.local.get([cacheKey]);
      if (result[cacheKey]) {
        return result[cacheKey].items;
      }
    }
  }
  
  return [];
}

// ---- Cookie change listener (debounced) ----

async function matchConfiguredDomain(domain) {
  await ensureWebsitesLoaded();

  const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain;

  for (const website of configuredWebsites) {
    if (domainMatches(cleanDomain, website)) {
      return website;
    }
  }
  return null;
}

// Domain matching: exact or subdomain relationship
// e.g. www.example.com <-> example.com, a.example.com <-> example.com
// No root-domain guessing to avoid foo.co.uk matching bar.co.uk
function domainMatches(host1, host2) {
  if (!host1 || !host2) return false;

  const clean1 = host1.startsWith('.') ? host1.substring(1) : host1;
  const clean2 = host2.startsWith('.') ? host2.substring(1) : host2;

  if (clean1 === clean2) return true;
  if (clean1.endsWith('.' + clean2)) return true;
  if (clean2.endsWith('.' + clean1)) return true;

  return false;
}

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;
  const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;

  // Only handle normal-window cookie changes
  if (cookie.storeId !== '0') {
    return;
  }

  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) {
    return;
  }

  changedDomainSet.add(matchedWebsite);
  // Persist so pending domains survive service worker suspension
  await chrome.storage.local.set({
    [CHANGED_DOMAINS_KEY]: Array.from(changedDomainSet)
  });

  // Reset debounce alarm on each change
  cookieDebounceScheduledAt = Date.now();
  await chrome.alarms.clear(COOKIE_DEBOUNCE_ALARM);
  await chrome.alarms.create(COOKIE_DEBOUNCE_ALARM, {
    when: Date.now() + DEBOUNCE_DELAY_MS
  });

  // Only set max-wait alarm on first schedule
  const maxWaitAlreadyScheduled = (await chrome.alarms.get(COOKIE_MAXWAIT_ALARM)) !== undefined;
  if (!maxWaitAlreadyScheduled) {
    await chrome.alarms.create(COOKIE_MAXWAIT_ALARM, {
      when: cookieDebounceScheduledAt + MAX_DEBOUNCE_WAIT_MS
    });
  }
});

async function processChangedDomains(reason) {
  // Restore from persistent storage (worker may have restarted)
  const stored = await chrome.storage.local.get([CHANGED_DOMAINS_KEY]);
  const persisted = stored[CHANGED_DOMAINS_KEY] || [];
  for (const d of persisted) changedDomainSet.add(d);

  if (changedDomainSet.size === 0) {
    return;
  }

  // Snapshot current batch; domains arriving during processing are preserved
  const domains = Array.from(changedDomainSet);
  console.log(`Processing cookie changes (${reason}) for:`, domains);

  for (const website of domains) {
    await cacheCookiesForDomain(website);

    const incognitoStores = await getIncognitoStores();
    if (incognitoStores.length > 0) {
      const now = Date.now();
      const lastSync = lastSyncTime.get(website) || 0;
      if (now - lastSync >= SYNC_COOLDOWN) {
        console.log(`Auto-syncing ${website} to incognito after cookie change`);
        await syncToIncognito(website, false);
      }
    }
  }

  // Only remove processed domains, keep new arrivals
  for (const d of domains) changedDomainSet.delete(d);
  cookieDebounceScheduledAt = 0;

  if (changedDomainSet.size > 0) {
    // New domains pending, persist and reschedule
    await chrome.storage.local.set({
      [CHANGED_DOMAINS_KEY]: Array.from(changedDomainSet)
    });
    await chrome.alarms.create(COOKIE_DEBOUNCE_ALARM, {
      when: Date.now() + DEBOUNCE_DELAY_MS
    });
  } else {
    await chrome.storage.local.remove(CHANGED_DOMAINS_KEY);
    await chrome.alarms.clear(COOKIE_DEBOUNCE_ALARM);
  }
  await chrome.alarms.clear(COOKIE_MAXWAIT_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COOKIE_DEBOUNCE_ALARM) {
    processChangedDomains('debounce').catch((e) => {
      console.error('processChangedDomains (debounce) failed:', e);
    });
  } else if (alarm.name === COOKIE_MAXWAIT_ALARM) {
    processChangedDomains('max-wait').catch((e) => {
      console.error('processChangedDomains (max-wait) failed:', e);
    });
  } else if (alarm.name === INIT_CACHE_ALARM) {
    ensureWebsitesLoaded().then(initCache).catch((e) => {
      console.error('Init cache (alarm) failed:', e);
    });
  }
});

async function getIncognitoStores() {
  const cookieStores = await chrome.cookies.getAllCookieStores();
  return cookieStores.filter((store) => store.id !== '0');
}

// ---- Sync logic ----

async function handleIncognitoPageReady(domain, url, tab) {
  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) return;
  
  console.log(`Incognito page ready: ${domain}`);
  
  await syncLocalStorageToTab(matchedWebsite, tab);
}

async function checkAndSync(domain, tabId) {
  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) return;

  // Check if incognito already has cookies for this domain
  const incognitoStores = await getIncognitoStores();
  if (incognitoStores.length === 0) return;
  
  const cachedCookies = await getCachedCookies(matchedWebsite);
  const cachedCount = cachedCookies.length;
  
  const existingCookies = await chrome.cookies.getAll({ 
    domain: matchedWebsite, 
    storeId: incognitoStores[0].id 
  });
  
  console.log(`[checkAndSync] ${domain}: cached=${cachedCount}, incognito=${existingCookies.length}`);
  
  // Already synced if incognito cookie count >= cached count
  if (cachedCount > 0 && existingCookies.length >= cachedCount) {
    console.log(`Skipping sync for ${domain}: already synced (${existingCookies.length}/${cachedCount})`);
    return;
  }

  console.log(`First visit in incognito for ${domain}, syncing...`);
  await syncToIncognito(matchedWebsite, false, tabId);
  
  // After first sync, only reload the triggering tab
  if (tabId) {
    console.log(`Reloading tab ${tabId} after first sync`);
    chrome.tabs.reload(tabId);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito && tab.url && tab.url !== 'chrome://newtab/') {
    try {
      const url = new URL(tab.url);
      checkAndSync(url.hostname, tab.id).catch((e) => {
        console.error('checkAndSync (onCreated) failed:', e);
      });
    } catch (error) {
      console.error('Error parsing URL:', error);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.incognito && changeInfo.status === 'complete' && tab.url) {
    try {
      const url = new URL(tab.url);
      checkAndSync(url.hostname, tabId).catch((e) => {
        console.error('checkAndSync (onUpdated) failed:', e);
      });
    } catch (error) {
      console.error('Error parsing URL:', error);
    }
  }
});

async function manualSync(domain) {
  const matchedWebsite = (await matchConfiguredDomain(domain)) || domain;
  
  await cacheCookiesForDomain(matchedWebsite);
  await cacheLocalStorageForDomain(matchedWebsite);
  
  const result = await syncToIncognito(matchedWebsite, true);
  
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Csync',
    message: `Synced ${result.cookiesSynced || 0} cookies and ${result.localStorageSynced || 0} localStorage items`
  });
}

async function syncToIncognito(domain, shouldReload = false, specificTabId = null) {
  const result = {
    success: false,
    cookiesSynced: 0,
    localStorageSynced: 0
  };
  
  try {
    console.log('Starting sync for:', domain);
    
    const cookieResult = await syncCookiesToIncognito(domain);
    result.cookiesSynced = cookieResult.synced || 0;
    
    const localStorageResult = await syncLocalStorageToIncognito(domain, specificTabId);
    result.localStorageSynced = localStorageResult.synced || 0;
    
    lastSyncTime.set(domain, Date.now());
    
    if (shouldReload && (result.cookiesSynced > 0 || result.localStorageSynced > 0)) {
      await reloadIncognitoTabs(domain);
    }
    
    result.success = true;
    console.log(`Sync completed: ${result.cookiesSynced} cookies, ${result.localStorageSynced} localStorage items`);
    
  } catch (error) {
    console.error('Sync error:', error);
    result.error = error.message;
  }
  
  return result;
}

async function syncCookiesToIncognito(domain) {
  const result = { synced: 0, failed: 0 };
  
  try {
    const targetStores = await getIncognitoStores();
    
    if (targetStores.length === 0) {
      console.log('No incognito window open');
      return result;
    }
    
    let cookies = await chrome.cookies.getAll({ domain: domain, storeId: '0' });
    
    if (cookies.length === 0) {
      cookies = await getCachedCookies(domain);
    }
    
    if (cookies.length === 0) {
      console.log(`No cookies found for ${domain}`);
      return result;
    }
    
    console.log(`Found ${cookies.length} cookies to sync`);
    
    for (const cookie of cookies) {
      for (const store of targetStores) {
        try {
          const rawDomain = cookie.domain;
          const cleanDomain = rawDomain.startsWith('.') ? rawDomain.substring(1) : rawDomain;
          const cookieUrl = `https://${cleanDomain}${cookie.path}`;

          const cookieDetails = {
            url: cookieUrl,
            name: cookie.name,
            value: cookie.value,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            storeId: store.id,
            domain: cookie.hostOnly ? undefined : cookie.domain
          };

          if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
            cookieDetails.sameSite = cookie.sameSite;
          }

          if (cookie.expirationDate) {
            cookieDetails.expirationDate = cookie.expirationDate;
          }

          await chrome.cookies.set(cookieDetails);
          result.synced++;

        } catch (error) {
          // Fallback retry with minimal fields
          try {
            const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
            await chrome.cookies.set({
              url: `https://${cleanDomain}${cookie.path}`,
              name: cookie.name,
              value: cookie.value,
              path: cookie.path,
              storeId: store.id
            });
            result.synced++;
          } catch (retryError) {
            console.warn(`Failed to sync cookie ${cookie.name}:`, retryError.message);
            result.failed++;
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Cookie sync error:', error);
  }
  
  return result;
}

async function syncLocalStorageToIncognito(domain, specificTabId = null) {
  const result = { synced: 0, failed: 0 };

  try {
    const freshItems = await cacheLocalStorageForDomain(domain);
    const items = freshItems || await getCachedLocalStorage(domain);

    if (!items || items.length === 0) {
      return result;
    }

    const allTabs = await chrome.tabs.query({});
    const targetTabs = allTabs.filter(tab => {
      if (!tab.incognito || !tab.url) return false;
      if (specificTabId && tab.id !== specificTabId) return false;
      try {
        return domainMatches(new URL(tab.url).hostname, domain);
      } catch {
        return false;
      }
    });

    if (targetTabs.length === 0) return result;

    console.log(`[localStorage] Syncing ${items.length} items to ${targetTabs.length} incognito tabs`);

    for (const tab of targetTabs) {
      try {
        await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'set_localStorage',
            domain: domain,
            items: items
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            if (response && response.isOk) {
              result.synced = items.length;
              resolve();
            } else {
              reject(new Error(response?.msg || 'Unknown error'));
            }
          });
        });
      } catch (error) {
        console.error(`[localStorage] Failed to sync to tab ${tab.id}:`, error.message);
        result.failed++;
      }
    }
  } catch (error) {
    console.error('[localStorage] Sync error:', error);
  }

  return result;
}

async function syncLocalStorageToTab(domain, tab) {
  if (!tab || !tab.id) return;

  let items = await getCachedLocalStorage(domain);

  if (!items || items.length === 0) {
    items = await cacheLocalStorageForDomain(domain);
  }

  if (!items || items.length === 0) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: 'set_localStorage',
    domain: domain,
    items: items
  }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.isOk) {
      console.log(`Synced ${items.length} localStorage items to incognito tab ${tab.id}`);
    }
  });
}

async function reloadIncognitoTabs(domain) {
  const allTabs = await chrome.tabs.query({});

  for (const tab of allTabs) {
    if (!tab.incognito || !tab.url) continue;
    try {
      if (domainMatches(new URL(tab.url).hostname, domain)) {
        chrome.tabs.reload(tab.id);
      }
    } catch {
      // invalid URL, skip
    }
  }
}

// ---- Storage change listener ----
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.csync_websites) {
    configuredWebsites = changes.csync_websites.newValue || [];
    configuredWebsitesLoaded = true;
    initCache().catch((e) => console.error('Init cache (storage.onChanged) failed:', e));
  }
});

// ---- Status query ----
async function getSyncStatus(domain) {
  const matchedWebsite = await matchConfiguredDomain(domain);
  const incognitoStores = await getIncognitoStores();
  const lastSync = lastSyncTime.get(domain);
  
  const cookieCacheKey = `csync_cookie_${matchedWebsite || domain}`;
  const localStorageCacheKey = `csync_localStorage_${matchedWebsite || domain}`;
  const cacheResult = await chrome.storage.local.get([cookieCacheKey, localStorageCacheKey]);
  
  return {
    isConfigured: !!matchedWebsite,
    hasIncognito: incognitoStores.length > 0,
    lastSyncTime: lastSync || null,
    cachedCookies: cacheResult[cookieCacheKey]?.cookies?.length || 0,
    cachedLocalStorage: cacheResult[localStorageCacheKey]?.items?.length || 0,
    cookieCacheTimestamp: cacheResult[cookieCacheKey]?.timestamp || null,
    localStorageCacheTimestamp: cacheResult[localStorageCacheKey]?.timestamp || null
  };
}
