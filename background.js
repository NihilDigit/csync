// Csync Background Script
// 监听标签页创建，同步 Cookie 和 localStorage 到无痕窗口

let configuredWebsites = [];
let configuredWebsitesLoaded = false;
let configuredWebsitesLoadingPromise = null;

// ==================== 防抖和批量处理 ====================
const lastSyncTime = new Map();
const SYNC_COOLDOWN = 5000;

// MV3 service worker 可能在空闲时被挂起，用 chrome.alarms 代替 setTimeout
// changedDomainSet 同时持久化到 storage.local，防止 worker 重启后丢失
const changedDomainSet = new Set();
const CHANGED_DOMAINS_KEY = 'csync_pending_domains';
const DEBOUNCE_DELAY_MS = 3000;
const MAX_DEBOUNCE_WAIT_MS = 15000;
const COOKIE_DEBOUNCE_ALARM = 'csync_cookie_debounce';
const COOKIE_MAXWAIT_ALARM = 'csync_cookie_maxwait';
const INIT_CACHE_ALARM = 'csync_init_cache';
let cookieDebounceScheduledAt = 0;

// ==================== 初始化 ====================
console.log('Csync service worker starting');

chrome.runtime.onInstalled.addListener(() => {
  console.log('Csync installed');
  loadWebsites();
  createContextMenus();
  // 延迟初始化缓存，用 alarm 保证 MV3 下可靠触发
  chrome.alarms.create(INIT_CACHE_ALARM, { delayInMinutes: 0.01 });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Csync startup');
  loadWebsites();
  chrome.alarms.create(INIT_CACHE_ALARM, { delayInMinutes: 0.02 });
});

// ==================== 消息处理 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'websites_updated') {
      configuredWebsites = message.websites;
      configuredWebsitesLoaded = true;
      console.log('Websites updated:', configuredWebsites);
      await initCache();
      sendResponse({ success: true });

    } else if (message.type === 'verify_sync') {
      const result = await verifyCookieSync(message.domain, message.currentCookies);
      sendResponse({ success: true, data: result });

    } else if (message.type === 'manual_sync_request') {
      await manualSync(message.domain);
      sendResponse({ success: true });

    } else if (message.type === 'get_sync_status') {
      const status = await getSyncStatus(message.domain);
      sendResponse({ success: true, data: status });

    } else if (message.type === 'incognito_page_ready') {
      // 无痕页面已准备好，可以设置 localStorage
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
      title: '同步当前网站 Cookie 和 localStorage 到无痕窗口',
      contexts: ['page']
    });
  } catch (e) {
    // 若重复创建会抛错（例如 service worker 重启时）
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

// ==================== 缓存机制（Cookie + localStorage）====================

// 初始化缓存
async function initCache() {
  await ensureWebsitesLoaded();
  if (configuredWebsites.length === 0) return;

  console.log('Initializing cache for', configuredWebsites.length, 'websites');
  await Promise.all(configuredWebsites.map(w => cacheCookiesForDomain(w)));
  console.log('Cache initialized');
}

// 缓存 cookies
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

// 缓存 localStorage（从普通窗口的标签页获取）
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

// 获取缓存的 cookies
async function getCachedCookies(domain) {
  let cacheKey = `csync_cookie_${domain}`;
  let result = await chrome.storage.local.get([cacheKey]);
  
  if (result[cacheKey]) {
    return result[cacheKey].cookies;
  }
  
  // 尝试匹配父域名
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

// 获取缓存的 localStorage
async function getCachedLocalStorage(domain) {
  let cacheKey = `csync_localStorage_${domain}`;
  let result = await chrome.storage.local.get([cacheKey]);
  
  if (result[cacheKey]) {
    return result[cacheKey].items;
  }
  
  // 尝试匹配父域名
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

// ==================== Cookie 变化监听（带防抖）====================

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

// 通用域名匹配函数
// 匹配规则：精确匹配 或 其中一方是另一方的子域名
// 例：www.example.com ↔ example.com ✓, a.example.com ↔ example.com ✓
// 不做根域名猜测，避免 foo.co.uk 误匹配 bar.co.uk
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

  // 只处理普通窗口的 cookie 变化
  if (cookie.storeId !== '0') {
    return;
  }

  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) {
    return;
  }

  changedDomainSet.add(matchedWebsite);
  // 持久化，防止 service worker 挂起后丢失
  await chrome.storage.local.set({
    [CHANGED_DOMAINS_KEY]: Array.from(changedDomainSet)
  });

  // 每次变化都重置 debounce alarm
  cookieDebounceScheduledAt = Date.now();
  await chrome.alarms.clear(COOKIE_DEBOUNCE_ALARM);
  await chrome.alarms.create(COOKIE_DEBOUNCE_ALARM, {
    when: Date.now() + DEBOUNCE_DELAY_MS
  });

  // max-wait alarm 只在第一次计划时设置
  const maxWaitAlreadyScheduled = (await chrome.alarms.get(COOKIE_MAXWAIT_ALARM)) !== undefined;
  if (!maxWaitAlreadyScheduled) {
    await chrome.alarms.create(COOKIE_MAXWAIT_ALARM, {
      when: cookieDebounceScheduledAt + MAX_DEBOUNCE_WAIT_MS
    });
  }
});

async function processChangedDomains(reason) {
  // 从持久化存储恢复（service worker 可能已重启）
  const stored = await chrome.storage.local.get([CHANGED_DOMAINS_KEY]);
  const persisted = stored[CHANGED_DOMAINS_KEY] || [];
  for (const d of persisted) changedDomainSet.add(d);

  if (changedDomainSet.size === 0) {
    return;
  }

  // 快照当前批次，处理期间新到的 domain 不会被误删
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

  // 只移除本批次处理过的 domain，保留处理期间新增的
  for (const d of domains) changedDomainSet.delete(d);
  cookieDebounceScheduledAt = 0;

  if (changedDomainSet.size > 0) {
    // 还有未处理的新 domain，持久化并重新调度
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

// ==================== 同步逻辑 ====================

// 无痕页面准备好后的处理
async function handleIncognitoPageReady(domain, url, tab) {
  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) return;
  
  console.log(`Incognito page ready: ${domain}`);
  
  // 尝试同步 localStorage
  await syncLocalStorageToTab(matchedWebsite, tab);
}

// 检查并执行同步（用于标签页事件）
async function checkAndSync(domain, tabId) {
  const matchedWebsite = await matchConfiguredDomain(domain);
  if (!matchedWebsite) return;

  // 检查无痕窗口是否已经有这个域名的 cookie
  const incognitoStores = await getIncognitoStores();
  if (incognitoStores.length === 0) return;
  
  // 获取普通窗口缓存的 cookie 数量
  const cachedCookies = await getCachedCookies(matchedWebsite);
  const cachedCount = cachedCookies.length;
  
  // 获取无痕窗口当前的 cookie
  const existingCookies = await chrome.cookies.getAll({ 
    domain: matchedWebsite, 
    storeId: incognitoStores[0].id 
  });
  
  console.log(`[checkAndSync] ${domain}: cached=${cachedCount}, incognito=${existingCookies.length}`);
  
  // 如果无痕窗口的 cookie 数量已经接近缓存数量，说明已同步过
  if (cachedCount > 0 && existingCookies.length >= cachedCount) {
    console.log(`Skipping sync for ${domain}: already synced (${existingCookies.length}/${cachedCount})`);
    return;
  }

  console.log(`First visit in incognito for ${domain}, syncing...`);
  await syncToIncognito(matchedWebsite, false, tabId);
  
  // 第一次同步后，只刷新触发同步的这个标签
  if (tabId) {
    console.log(`Reloading tab ${tabId} after first sync`);
    chrome.tabs.reload(tabId);
  }
}

// 标签页创建监听
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

// 标签页更新监听
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

// 手动同步
async function manualSync(domain) {
  const matchedWebsite = (await matchConfiguredDomain(domain)) || domain;
  
  // 更新缓存
  await cacheCookiesForDomain(matchedWebsite);
  await cacheLocalStorageForDomain(matchedWebsite);
  
  // 同步
  const result = await syncToIncognito(matchedWebsite, true);
  
  // 显示通知
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Csync',
    message: `已同步 ${result.cookiesSynced || 0} 个 Cookie 和 ${result.localStorageSynced || 0} 个 localStorage 项`
  });
}

// 核心同步函数 - Cookie + localStorage
async function syncToIncognito(domain, shouldReload = false, specificTabId = null) {
  const result = {
    success: false,
    cookiesSynced: 0,
    localStorageSynced: 0
  };
  
  try {
    console.log('Starting sync for:', domain);
    
    // 同步 Cookies
    const cookieResult = await syncCookiesToIncognito(domain);
    result.cookiesSynced = cookieResult.synced || 0;
    
    // 同步 localStorage
    const localStorageResult = await syncLocalStorageToIncognito(domain, specificTabId);
    result.localStorageSynced = localStorageResult.synced || 0;
    
    // 更新同步时间
    lastSyncTime.set(domain, Date.now());
    
    // 刷新页面
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

// 同步 Cookies 到无痕窗口
async function syncCookiesToIncognito(domain) {
  const result = { synced: 0, failed: 0 };
  
  try {
    const targetStores = await getIncognitoStores();
    
    if (targetStores.length === 0) {
      console.log('No incognito window open');
      return result;
    }
    
    // 获取 cookies
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
          // 降级重试：只保留必要字段
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

// 同步 localStorage 到无痕窗口
async function syncLocalStorageToIncognito(domain, specificTabId = null) {
  const result = { synced: 0, failed: 0 };

  try {
    // 先尝试从普通窗口获取最新的 localStorage
    const freshItems = await cacheLocalStorageForDomain(domain);
    const items = freshItems || await getCachedLocalStorage(domain);

    if (!items || items.length === 0) {
      return result;
    }

    // 查找无痕窗口中该域名的标签页
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

    // 向每个目标标签页发送 localStorage
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

// 向特定标签页同步 localStorage
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

// 刷新无痕标签页
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

// ==================== 存储变化监听 ====================
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.csync_websites) {
    configuredWebsites = changes.csync_websites.newValue || [];
    configuredWebsitesLoaded = true;
    initCache().catch((e) => console.error('Init cache (storage.onChanged) failed:', e));
  }
});

// ==================== 状态查询 ====================
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

// ==================== 验证同步结果 ====================
async function verifyCookieSync(domain, currentCookies) {
  const stores = await chrome.cookies.getAllCookieStores();
  const incognitoStore = stores.find((s) => s.id !== '0');

  let targetCookies = [];
  if (incognitoStore) {
    targetCookies = await chrome.cookies.getAll({ domain: domain, storeId: incognitoStore.id });
  }

  const matched = [];
  const missing = [];
  const extra = [];

  currentCookies.forEach((currentCookie) => {
    const found = targetCookies.find((c) => c.name === currentCookie.name);
    if (found) matched.push(currentCookie);
    else missing.push(currentCookie);
  });

  targetCookies.forEach((incognitoCookie) => {
    const found = currentCookies.find((c) => c.name === incognitoCookie.name);
    if (!found) {
      extra.push({
        name: incognitoCookie.name,
        domain: incognitoCookie.domain,
        path: incognitoCookie.path,
        value: (incognitoCookie.value || '').substring(0, 20) + '...'
      });
    }
  });

  return {
    currentCookies,
    incognitoCookies: targetCookies,
    matched,
    missing,
    extra,
    syncRate:
      currentCookies.length > 0 ? Math.round((matched.length / currentCookies.length) * 100) : 0
  };
}

// ==================== 调试工具 ====================
self.CsyncDebug = {
  getStores: async function() {
    const stores = await chrome.cookies.getAllCookieStores();
    console.log('Cookie Stores:', stores);
    return stores;
  },
  
  showCache: async function() {
    const result = await chrome.storage.local.get(null);
    console.log('All cached data:', result);
    return result;
  },
  
  clearCache: async function() {
    const keys = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(keys).filter(k => 
      k.startsWith('csync_cookie_') || k.startsWith('csync_localStorage_')
    );
    await chrome.storage.local.remove(cacheKeys);
    console.log('Cache cleared:', cacheKeys);
  },
  
  forceSync: async function(domain) {
    console.log('Force syncing:', domain);
    return await syncToIncognito(domain, true);
  },
  
  getStatus: async function(domain) {
    return await getSyncStatus(domain);
  },
  
  // 手动获取某个域名的 localStorage
  getLocalStorage: async function(domain) {
    return await cacheLocalStorageForDomain(domain);
  },
  
  // 手动同步 localStorage 到无痕窗口
  syncLocalStorage: async function(domain) {
    return await syncLocalStorageToIncognito(domain);
  }
};
