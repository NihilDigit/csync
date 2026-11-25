// Csync Background Service Worker (MV3)
import {
  buildCookieRemoveDetails,
  buildCookieSetDetails,
  buildMatchPatterns,
  filterLocalStorageItems,
  findMatchingSite,
  findMatchingSiteForCookie,
  hostMatchesSite,
  isSyncableUrl,
  localStorageSessionKey,
  normalizeHost
} from './sync-utils.js';

const WEBSITES_KEY = 'csync_websites';
const PENDING_DOMAINS_KEY = 'csync_pending_domains';
const WARMED_STORES_KEY = 'csync_warmed_stores';
const LAST_SYNC_KEY = 'csync_last_sync';
const COOKIE_DEBOUNCE_ALARM = 'csync_cookie_debounce';
const CONTENT_SCRIPT_ID = 'csync_dynamic_content';
const NORMAL_STORE_ID = '0';

// Fast in-memory debounce while SW is awake; 30s alarm only as sleep fallback
const FAST_DEBOUNCE_MS = 600;
const ALARM_FALLBACK_MINUTES = 0.5;

let configuredWebsites = [];
let websitesLoaded = false;
let websitesLoadingPromise = null;

const pendingDomains = new Set();
let debounceTimer = null;

// Track in-flight prewarm promises per incognito store to avoid duplicate reloads
const inFlightPrewarm = new Map();
// Guard against double-reloading the same tab during cold-start race
const reloadedColdTabs = new Set();

// ---- Initialization ----

async function configureSessionAccess() {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    });
  } catch (error) {
    console.warn('Failed to set storage.session access level:', error);
  }
}

async function cleanupLegacyDiskCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const legacyKeys = Object.keys(all).filter(
      (k) =>
        k.startsWith('csync_cookie_') ||
        k.startsWith('csync_localStorage_') ||
        k === 'csync_pending_domains'
    );
    if (legacyKeys.length > 0) {
      await chrome.storage.local.remove(legacyKeys);
    }
  } catch (error) {
    console.warn('Legacy cache cleanup skipped:', error);
  }
}

async function loadWebsites() {
  if (websitesLoadingPromise) return websitesLoadingPromise;
  websitesLoadingPromise = (async () => {
    const result = await chrome.storage.sync.get([WEBSITES_KEY]);
    const list = Array.isArray(result[WEBSITES_KEY]) ? result[WEBSITES_KEY] : [];
    configuredWebsites = Array.from(
      new Set(list.map(normalizeHost).filter(Boolean))
    );
    websitesLoaded = true;
    return configuredWebsites;
  })().finally(() => {
    websitesLoadingPromise = null;
  });
  return websitesLoadingPromise;
}

async function ensureWebsitesLoaded() {
  if (websitesLoaded) return configuredWebsites;
  return loadWebsites();
}

async function syncDynamicContentScripts() {
  const sites = await ensureWebsitesLoaded();
  const matches = buildMatchPatterns(sites);

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch {
    // Script not yet registered
  }

  if (matches.length === 0) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: ['content.js'],
        matches,
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true
      }
    ]);
  } catch (error) {
    console.error('Failed to register dynamic content scripts:', error);
  }
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: 'csync_sync_current',
        title: 'Sync cookies and localStorage to incognito',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*']
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

async function bootstrap() {
  await configureSessionAccess();
  await ensureWebsitesLoaded();
  await syncDynamicContentScripts();
  await warmLocalStorageFromOpenTabs();
  const stores = await getIncognitoStores();
  if (stores.length > 0) {
    await prewarmAllIncognitoStores();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  cleanupLegacyDiskCache();
  bootstrap().catch((e) => console.error('Bootstrap (onInstalled) failed:', e));
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  bootstrap().catch((e) => console.error('Bootstrap (onStartup) failed:', e));
});

// Ensure session access level is configured on every service worker wakeup
configureSessionAccess();

// ---- Session state helpers ----

async function getIncognitoStores() {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.filter((store) => store.id !== NORMAL_STORE_ID);
}

async function getWarmedStoresMap() {
  const res = await chrome.storage.session.get([WARMED_STORES_KEY]);
  return res[WARMED_STORES_KEY] || {};
}

async function markStoreSiteWarmed(storeId, site) {
  const map = await getWarmedStoresMap();
  const sites = new Set(map[storeId] || []);
  sites.add(site);
  map[storeId] = Array.from(sites);
  await chrome.storage.session.set({ [WARMED_STORES_KEY]: map });
}

async function markStoreAllSitesWarmed(storeId, sites) {
  const map = await getWarmedStoresMap();
  const existing = new Set(map[storeId] || []);
  for (const s of sites) existing.add(s);
  map[storeId] = Array.from(existing);
  await chrome.storage.session.set({ [WARMED_STORES_KEY]: map });
}

async function isStoreSiteWarmed(storeId, site) {
  const map = await getWarmedStoresMap();
  return Array.isArray(map[storeId]) && map[storeId].includes(site);
}

async function getLastSyncMap() {
  const res = await chrome.storage.session.get([LAST_SYNC_KEY]);
  return res[LAST_SYNC_KEY] || {};
}

async function recordLastSync(site) {
  const map = await getLastSyncMap();
  map[site] = Date.now();
  await chrome.storage.session.set({ [LAST_SYNC_KEY]: map });
}

async function purgeSiteSessionCache(removedSite) {
  const all = await chrome.storage.session.get(null);
  const keysToRemove = [];

  for (const key of Object.keys(all)) {
    if (!key.startsWith('csync_ls_')) continue;
    const origin = key.slice('csync_ls_'.length);
    try {
      const host = new URL(origin).hostname;
      if (hostMatchesSite(host, removedSite)) {
        keysToRemove.push(key);
      }
    } catch {
      // ignore invalid origin
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.session.remove(keysToRemove);
  }

  const lastSync = await getLastSyncMap();
  if (removedSite in lastSync) {
    delete lastSync[removedSite];
    await chrome.storage.session.set({ [LAST_SYNC_KEY]: lastSync });
  }
}

// ---- Cookie sync ----

async function syncCookiesForSite(site, targetStores = null) {
  const stores = targetStores || (await getIncognitoStores());
  if (stores.length === 0) return { synced: 0, failed: 0, hasIncognito: false };

  const cookies = await chrome.cookies.getAll({
    domain: site,
    storeId: NORMAL_STORE_ID
  });

  if (cookies.length === 0) {
    return { synced: 0, failed: 0, hasIncognito: true };
  }

  let synced = 0;
  let failed = 0;

  const tasks = [];
  for (const store of stores) {
    for (const cookie of cookies) {
      tasks.push(
        setCookieWithFallback(cookie, store.id).then((ok) => {
          if (ok) synced++;
          else failed++;
        })
      );
    }
  }

  await Promise.all(tasks);
  return { synced, failed, hasIncognito: true };
}

async function setCookieWithFallback(cookie, storeId) {
  try {
    await chrome.cookies.set(buildCookieSetDetails(cookie, storeId));
    return true;
  } catch {
    // Retry without optional attributes if browser rejects strict combination
    try {
      const details = buildCookieSetDetails(cookie, storeId);
      delete details.sameSite;
      delete details.partitionKey;
      await chrome.cookies.set(details);
      return true;
    } catch (retryError) {
      console.warn(`Cookie sync failed (${cookie.name}):`, retryError?.message || retryError);
      return false;
    }
  }
}

async function removeCookieFromIncognito(cookie) {
  const stores = await getIncognitoStores();
  if (stores.length === 0) return;

  await Promise.allSettled(
    stores.map((store) =>
      chrome.cookies.remove(buildCookieRemoveDetails(cookie, store.id))
    )
  );
}

// ---- localStorage capture & sync (origin-scoped) ----

function readLocalStorageInPage() {
  try {
    const items = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) {
        items.push({ key, value: window.localStorage.getItem(key) ?? '' });
      }
    }
    return { ok: true, origin: window.location.origin, items };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function writeLocalStorageInPage(items) {
  try {
    let written = 0;
    for (const item of items || []) {
      if (item && item.key) {
        window.localStorage.setItem(item.key, item.value ?? '');
        written++;
      }
    }
    return { ok: true, written };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function captureLocalStorageFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readLocalStorageInPage
    });
    const payload = results?.[0]?.result;
    if (!payload?.ok || !payload.origin) return null;

    const filtered = filterLocalStorageItems(payload.items);
    const key = localStorageSessionKey(payload.origin);
    await chrome.storage.session.set({
      [key]: {
        origin: payload.origin,
        items: filtered,
        timestamp: Date.now()
      }
    });
    return { origin: payload.origin, items: filtered };
  } catch {
    return null;
  }
}

async function captureLocalStorageForSite(site, preferredOrigin = null) {
  const tabs = await chrome.tabs.query({});
  const matchingNormalTabs = tabs.filter((t) => {
    if (t.incognito || t.discarded || !isSyncableUrl(t.url)) return false;
    try {
      const url = new URL(t.url);
      if (preferredOrigin && url.origin === preferredOrigin) return true;
      return hostMatchesSite(url.hostname, site);
    } catch {
      return false;
    }
  });

  // Deduplicate by origin so each origin is captured once
  const seenOrigins = new Set();
  const captured = [];

  for (const tab of matchingNormalTabs) {
    const origin = new URL(tab.url).origin;
    if (seenOrigins.has(origin)) continue;
    seenOrigins.add(origin);

    const res = await captureLocalStorageFromTab(tab.id);
    if (res) captured.push(res);
  }

  return captured;
}

async function warmLocalStorageFromOpenTabs() {
  const sites = await ensureWebsitesLoaded();
  if (sites.length === 0) return;

  const tabs = await chrome.tabs.query({});
  const seenOrigins = new Set();
  const tasks = [];

  for (const tab of tabs) {
    if (tab.incognito || tab.discarded || !isSyncableUrl(tab.url)) continue;
    const url = new URL(tab.url);
    if (seenOrigins.has(url.origin)) continue;
    if (!findMatchingSite(url.hostname, sites)) continue;

    seenOrigins.add(url.origin);
    tasks.push(captureLocalStorageFromTab(tab.id));
  }

  await Promise.allSettled(tasks);
}

async function pushLocalStorageToIncognitoTabs(site) {
  const tabs = await chrome.tabs.query({});
  const incognitoTabs = tabs.filter((t) => {
    if (!t.incognito || t.discarded || !isSyncableUrl(t.url)) return false;
    try {
      return hostMatchesSite(new URL(t.url).hostname, site);
    } catch {
      return false;
    }
  });

  if (incognitoTabs.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const tab of incognitoTabs) {
    const origin = new URL(tab.url).origin;
    const sessionRes = await chrome.storage.session.get([localStorageSessionKey(origin)]);
    const cached = sessionRes[localStorageSessionKey(origin)];
    if (!cached?.items?.length) continue;

    try {
      const execRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: writeLocalStorageInPage,
        args: [cached.items]
      });
      if (execRes?.[0]?.result?.ok) {
        synced = Math.max(synced, execRes[0].result.written);
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { synced, failed };
}

// ---- Pre-warming on Incognito Window Creation ----

async function prewarmIncognitoStore(storeId) {
  if (inFlightPrewarm.has(storeId)) {
    return inFlightPrewarm.get(storeId);
  }

  const task = (async () => {
    const sites = await ensureWebsitesLoaded();
    if (sites.length === 0) return;

    const targetStore = [{ id: storeId }];
    await Promise.allSettled(
      sites.map(async (site) => {
        const res = await syncCookiesForSite(site, targetStore);
        if (res.synced > 0) {
          await recordLastSync(site);
        }
      })
    );
    await markStoreAllSitesWarmed(storeId, sites);
  })().finally(() => {
    inFlightPrewarm.delete(storeId);
  });

  inFlightPrewarm.set(storeId, task);
  return task;
}

async function prewarmAllIncognitoStores() {
  const stores = await getIncognitoStores();
  if (stores.length === 0) return;
  await Promise.allSettled(stores.map((s) => prewarmIncognitoStore(s.id)));
}

chrome.windows.onCreated.addListener((win) => {
  if (!win.incognito) return;
  // Pre-warm cookies and localStorage immediately while user is still on New Tab
  Promise.allSettled([
    prewarmAllIncognitoStores(),
    warmLocalStorageFromOpenTabs()
  ]).catch((e) => console.error('Incognito pre-warm failed:', e));
});

chrome.windows.onRemoved.addListener(async () => {
  const stores = await getIncognitoStores();
  if (stores.length === 0) {
    reloadedColdTabs.clear();
    await chrome.storage.session.remove([WARMED_STORES_KEY]);
  }
});

// ---- Early Navigation Guard (Cold-start "Open link in incognito") ----

async function handleIncognitoNavigation(tabId, urlString) {
  if (!isSyncableUrl(urlString)) return;

  const sites = await ensureWebsitesLoaded();
  const url = new URL(urlString);
  const matchedSite = findMatchingSite(url.hostname, sites);
  if (!matchedSite) return;

  const stores = await getIncognitoStores();
  if (stores.length === 0) return;
  const storeId = stores[0].id;

  const alreadyWarmed = await isStoreSiteWarmed(storeId, matchedSite);
  if (alreadyWarmed) return;

  // Cold-start race: navigation began before pre-warm finished
  if (inFlightPrewarm.has(storeId)) {
    await inFlightPrewarm.get(storeId);
  } else {
    await Promise.allSettled([
      syncCookiesForSite(matchedSite, [{ id: storeId }]),
      captureLocalStorageForSite(matchedSite, url.origin)
    ]);
    await markStoreSiteWarmed(storeId, matchedSite);
    await recordLastSync(matchedSite);
  }

  // Reload at most once per cold tab, interrupting the unauthenticated load early
  if (!reloadedColdTabs.has(tabId)) {
    reloadedColdTabs.add(tabId);
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      // Tab may have closed
    }
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const targetUrl = tab.pendingUrl || tab.url;
  if (tab.incognito && targetUrl) {
    handleIncognitoNavigation(tab.id, targetUrl).catch((e) =>
      console.error('Incognito onCreated sync failed:', e)
    );
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.incognito) return;
  const targetUrl = changeInfo.url || (changeInfo.status === 'loading' ? tab.url : null);
  if (targetUrl) {
    handleIncognitoNavigation(tabId, targetUrl).catch((e) =>
      console.error('Incognito onUpdated sync failed:', e)
    );
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  reloadedColdTabs.delete(tabId);
});

// ---- Real-Time Cookie Change Sync (Hybrid Fast Timer + Alarm Fallback) ----

async function flushPendingDomains() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const stored = await chrome.storage.session.get([PENDING_DOMAINS_KEY]);
  for (const d of stored[PENDING_DOMAINS_KEY] || []) {
    pendingDomains.add(d);
  }

  if (pendingDomains.size === 0) {
    await chrome.alarms.clear(COOKIE_DEBOUNCE_ALARM);
    return;
  }

  const batch = Array.from(pendingDomains);
  pendingDomains.clear();
  await chrome.storage.session.remove([PENDING_DOMAINS_KEY]);
  await chrome.alarms.clear(COOKIE_DEBOUNCE_ALARM);

  const stores = await getIncognitoStores();
  if (stores.length === 0) return;

  await Promise.allSettled(
    batch.map(async (site) => {
      const res = await syncCookiesForSite(site, stores);
      if (res.synced > 0) {
        await recordLastSync(site);
      }
    })
  );
}

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;
  if (cookie.storeId !== NORMAL_STORE_ID) return;

  const sites = await ensureWebsitesLoaded();
  const matchedSite = findMatchingSiteForCookie(cookie.domain, sites);
  if (!matchedSite) return;

  // Propagate real cookie removals (logout/expiry) immediately
  if (changeInfo.removed && changeInfo.cause !== 'overwrite') {
    await removeCookieFromIncognito(cookie);
    return;
  }

  pendingDomains.add(matchedSite);
  await chrome.storage.session.set({
    [PENDING_DOMAINS_KEY]: Array.from(pendingDomains)
  });

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    flushPendingDomains().catch((e) => console.error('Fast debounce flush failed:', e));
  }, FAST_DEBOUNCE_MS);

  // Fallback alarm only fires if service worker suspends before setTimeout completes
  chrome.alarms.create(COOKIE_DEBOUNCE_ALARM, {
    delayInMinutes: ALARM_FALLBACK_MINUTES
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COOKIE_DEBOUNCE_ALARM) {
    flushPendingDomains().catch((e) => console.error('Alarm debounce flush failed:', e));
  }
});

// ---- Manual Sync & Context Menu ----

async function reloadIncognitoTabs(site) {
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (!tab.incognito || !isSyncableUrl(tab.url)) continue;
    try {
      if (hostMatchesSite(new URL(tab.url).hostname, site)) {
        chrome.tabs.reload(tab.id);
      }
    } catch {
      // skip
    }
  }
}

async function manualSync(domain, showNotification = false) {
  const sites = await ensureWebsitesLoaded();
  const targetSite = findMatchingSite(domain, sites) || normalizeHost(domain);
  if (!targetSite) {
    return { hasIncognito: false, cookiesSynced: 0, localStorageSynced: 0 };
  }

  await captureLocalStorageForSite(targetSite);

  const stores = await getIncognitoStores();
  if (stores.length === 0) {
    if (showNotification) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'No incognito window open',
        message: `Open an incognito window to sync ${targetSite}`
      });
    }
    return { hasIncognito: false, cookiesSynced: 0, localStorageSynced: 0 };
  }

  const cookieRes = await syncCookiesForSite(targetSite, stores);
  const lsRes = await pushLocalStorageToIncognitoTabs(targetSite);

  for (const store of stores) {
    await markStoreSiteWarmed(store.id, targetSite);
  }
  await recordLastSync(targetSite);

  if (cookieRes.synced > 0 || lsRes.synced > 0) {
    await reloadIncognitoTabs(targetSite);
  }

  if (showNotification) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: `Synced ${targetSite}`,
      message: `${cookieRes.synced} cookies and ${lsRes.synced} storage items copied`
    });
  }

  return {
    hasIncognito: true,
    cookiesSynced: cookieRes.synced,
    localStorageSynced: lsRes.synced
  };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'csync_sync_current') return;
  if (!isSyncableUrl(tab?.url)) return;
  const host = new URL(tab.url).hostname;
  manualSync(host, true).catch((e) => console.error('Context menu sync failed:', e));
});

// ---- Status Query ----

async function getSyncStatus(domain, origin = null) {
  const sites = await ensureWebsitesLoaded();
  const matchedSite = findMatchingSite(domain, sites);
  const targetSite = matchedSite || normalizeHost(domain);

  const [stores, cookies, lastSyncMap, warmedMap] = await Promise.all([
    getIncognitoStores(),
    targetSite
      ? chrome.cookies.getAll({ domain: targetSite, storeId: NORMAL_STORE_ID })
      : Promise.resolve([]),
    getLastSyncMap(),
    getWarmedStoresMap()
  ]);

  let localStorageCount = 0;
  if (origin) {
    const lsRes = await chrome.storage.session.get([localStorageSessionKey(origin)]);
    localStorageCount = lsRes[localStorageSessionKey(origin)]?.items?.length || 0;
  }

  const hasIncognito = stores.length > 0;
  const isWarmed =
    hasIncognito &&
    Boolean(matchedSite) &&
    stores.every((s) => Array.isArray(warmedMap[s.id]) && warmedMap[s.id].includes(matchedSite));

  return {
    isConfigured: Boolean(matchedSite),
    matchedSite,
    hasIncognito,
    isWarmed,
    lastSyncTime: (matchedSite && lastSyncMap[matchedSite]) || lastSyncMap[targetSite] || null,
    cookieCount: cookies.length,
    localStorageCount
  };
}

async function applyWebsitesUpdate(nextWebsites) {
  const oldSites = [...configuredWebsites];
  const newSites = Array.from(
    new Set((nextWebsites || []).map(normalizeHost).filter(Boolean))
  );

  configuredWebsites = newSites;
  websitesLoaded = true;

  const removed = oldSites.filter((s) => !newSites.includes(s));
  for (const site of removed) {
    await purgeSiteSessionCache(site);
  }

  await syncDynamicContentScripts();

  const added = newSites.filter((s) => !oldSites.includes(s));
  if (added.length > 0) {
    const stores = await getIncognitoStores();
    await Promise.allSettled(
      added.map(async (site) => {
        await captureLocalStorageForSite(site);
        if (stores.length > 0) {
          const res = await syncCookiesForSite(site, stores);
          for (const store of stores) {
            await markStoreSiteWarmed(store.id, site);
          }
          if (res.synced > 0) await recordLastSync(site);
        }
      })
    );
  }
}

// ---- Storage Sync Listener ----

chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace !== 'sync' || !changes[WEBSITES_KEY]) return;
  await applyWebsitesUpdate(changes[WEBSITES_KEY].newValue || []);
});

// ---- Message Handling (with Sender Validation) ----

function isExtensionPopupSender(sender) {
  return !sender.tab && sender.id === chrome.runtime.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ success: false, error: 'Invalid message' });
      return;
    }

    if (message.type === 'incognito_needs_localStorage') {
      if (!sender.tab?.incognito || !isSyncableUrl(sender.tab.url)) {
        sendResponse({ success: false, error: 'Unauthorized sender' });
        return;
      }
      const url = new URL(sender.tab.url);
      const sites = await ensureWebsitesLoaded();
      const matchedSite = findMatchingSite(url.hostname, sites);
      if (!matchedSite) {
        sendResponse({ success: true, items: [] });
        return;
      }
      await captureLocalStorageForSite(matchedSite, url.origin);
      const res = await chrome.storage.session.get([localStorageSessionKey(url.origin)]);
      sendResponse({
        success: true,
        items: res[localStorageSessionKey(url.origin)]?.items || []
      });
      return;
    }

    // Management messages must originate from the extension popup
    if (!isExtensionPopupSender(sender)) {
      sendResponse({ success: false, error: 'Unauthorized sender' });
      return;
    }

    if (message.type === 'websites_updated') {
      await applyWebsitesUpdate(message.websites);
      sendResponse({ success: true });
    } else if (message.type === 'manual_sync_request') {
      const data = await manualSync(message.domain, false);
      sendResponse({ success: true, data });
    } else if (message.type === 'get_sync_status') {
      const data = await getSyncStatus(message.domain, message.origin || null);
      sendResponse({ success: true, data });
    } else {
      sendResponse({ success: false, error: 'Unknown message type' });
    }
  })().catch((error) => {
    console.error('Message handler error:', error);
    sendResponse({ success: false, error: error?.message || String(error) });
  });

  return true;
});
