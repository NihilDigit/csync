// Csync Background Script
// 监听标签页创建，同步 Cookie 和 localStorage 到无痕窗口
// 借鉴 sync-your-cookie 项目的设计

let configuredWebsites = [];

// ==================== 防抖和批量处理 ====================
const lastSyncTime = new Map();
const SYNC_COOLDOWN = 5000; // 5秒冷却时间

// 防抖处理 cookie 变化
let cookieChangeTimer = null;
let cookieChangeTimeoutFlag = false;
const changedDomainSet = new Set();
const DEBOUNCE_DELAY = 3000; // 3秒防抖
const MAX_DEBOUNCE_WAIT = 15000; // 最长等待15秒

// ==================== 初始化 ====================
chrome.runtime.onInstalled.addListener(() => {
  console.log('Csync installed');
  loadWebsites();
  createContextMenus();
  setTimeout(initCache, 500);
});

chrome.runtime.onStartup.addListener(() => {
  loadWebsites();
  setTimeout(initCache, 1000);
});

// ==================== 消息处理 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'websites_updated') {
    configuredWebsites = message.websites;
    console.log('Websites updated:', configuredWebsites);
    initCache();
    sendResponse({ success: true });
    
  } else if (message.type === 'verify_sync') {
    verifyCookieSync(message.domain, message.currentCookies).then(result => {
      sendResponse({ success: true, data: result });
    }).catch(error => {
      console.error('Verify failed:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
    
  } else if (message.type === 'manual_sync_request') {
    manualSync(message.domain);
    sendResponse({ success: true });
    
  } else if (message.type === 'get_sync_status') {
    getSyncStatus(message.domain).then(status => {
      sendResponse({ success: true, data: status });
    });
    return true;
    
  } else if (message.type === 'incognito_page_ready') {
    // 无痕页面已准备好，可以设置 localStorage
    handleIncognitoPageReady(message.domain, message.url, sender.tab);
    sendResponse({ success: true });
  }
});

function loadWebsites() {
  chrome.storage.sync.get(['csync_websites'], (result) => {
    configuredWebsites = result.csync_websites || [];
    console.log('Loaded websites:', configuredWebsites);
  });
}

function createContextMenus() {
  chrome.contextMenus.create({
    id: 'csync_sync_current',
    title: '同步当前网站 Cookie 和 localStorage 到无痕窗口',
    contexts: ['page']
  });
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
  console.log('Initializing cache for configured websites...');
  for (const website of configuredWebsites) {
    await cacheCookiesForDomain(website);
    // localStorage 需要从页面获取，在页面加载时触发
  }
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
    // 查找普通窗口中该域名的标签页
    const tabs = await chrome.tabs.query({});
    const normalTab = tabs.find(tab => {
      if (tab.incognito || !tab.url) return false;
      try {
        const tabHost = new URL(tab.url).hostname;
        return tabHost === domain || tabHost.endsWith('.' + domain) || domain.endsWith('.' + tabHost);
      } catch {
        return false;
      }
    });
    
    if (!normalTab) {
      console.log(`No normal tab found for ${domain} to get localStorage`);
      return null;
    }
    
    // 向该标签页请求 localStorage
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(normalTab.id, {
        type: 'get_localStorage',
        domain: domain
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Failed to get localStorage:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        
        if (response && response.isOk) {
          const cacheKey = `csync_localStorage_${domain}`;
          const cacheData = {
            domain: domain,
            items: response.result,
            timestamp: Date.now()
          };
          chrome.storage.local.set({ [cacheKey]: cacheData });
          console.log(`Cached ${response.result.length} localStorage items for ${domain}`);
          resolve(response.result);
        } else {
          resolve(null);
        }
      });
    });
    
  } catch (error) {
    console.error(`Failed to cache localStorage for ${domain}:`, error);
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

function matchConfiguredDomain(domain) {
  const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain;
  
  for (const website of configuredWebsites) {
    if (cleanDomain === website || 
        cleanDomain.endsWith('.' + website) || 
        website.endsWith('.' + cleanDomain)) {
      return website;
    }
  }
  return null;
}

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;
  const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
  
  // 只处理普通窗口的 cookie 变化
  if (cookie.storeId !== '0') {
    return;
  }
  
  const matchedWebsite = matchConfiguredDomain(domain);
  if (!matchedWebsite) {
    return;
  }
  
  if (cookieChangeTimer && cookieChangeTimeoutFlag) {
    return;
  }
  
  if (cookieChangeTimer) {
    clearTimeout(cookieChangeTimer);
  }
  
  changedDomainSet.add(matchedWebsite);
  
  cookieChangeTimer = setTimeout(async () => {
    cookieChangeTimeoutFlag = false;
    
    console.log('Processing cookie changes for:', Array.from(changedDomainSet));
    
    for (const website of changedDomainSet) {
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
    
    changedDomainSet.clear();
  }, DEBOUNCE_DELAY);
  
  if (!cookieChangeTimeoutFlag) {
    setTimeout(() => {
      if (cookieChangeTimer) {
        console.log('Max debounce wait reached, forcing process');
        cookieChangeTimeoutFlag = true;
        clearTimeout(cookieChangeTimer);
        cookieChangeTimer = null;
        
        (async () => {
          for (const website of changedDomainSet) {
            await cacheCookiesForDomain(website);
          }
          changedDomainSet.clear();
        })();
      }
    }, MAX_DEBOUNCE_WAIT);
  }
});

async function getIncognitoStores() {
  const cookieStores = await chrome.cookies.getAllCookieStores();
  return cookieStores.filter(store => store.id !== '0');
}

// ==================== 同步逻辑 ====================

// 无痕页面准备好后的处理
async function handleIncognitoPageReady(domain, url, tab) {
  const matchedWebsite = matchConfiguredDomain(domain);
  if (!matchedWebsite) return;
  
  console.log(`Incognito page ready: ${domain}`);
  
  // 尝试同步 localStorage
  await syncLocalStorageToTab(matchedWebsite, tab);
}

// 检查并执行同步（用于标签页事件）
async function checkAndSync(domain, tabId) {
  const matchedWebsite = matchConfiguredDomain(domain);
  if (!matchedWebsite) return;

  const now = Date.now();
  const lastSync = lastSyncTime.get(domain) || 0;
  
  if (now - lastSync < SYNC_COOLDOWN) {
    console.log(`Skipping sync for ${domain}: in cooldown`);
    return;
  }

  console.log(`Starting sync for ${domain}...`);
  lastSyncTime.set(domain, now);
  await syncToIncognito(matchedWebsite, true, tabId);
}

// 标签页创建监听
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito && tab.url && tab.url !== 'chrome://newtab/') {
    try {
      const url = new URL(tab.url);
      checkAndSync(url.hostname, tab.id);
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
      checkAndSync(url.hostname, tabId);
    } catch (error) {
      console.error('Error parsing URL:', error);
    }
  }
});

// 手动同步
async function manualSync(domain) {
  const matchedWebsite = matchConfiguredDomain(domain) || domain;
  
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
    
    // 获取 localStorage 数据
    let items = freshItems || await getCachedLocalStorage(domain);
    
    if (!items || items.length === 0) {
      console.log(`No localStorage items found for ${domain}`);
      return result;
    }
    
    console.log(`Found ${items.length} localStorage items to sync`);
    
    // 查找无痕窗口中该域名的标签页
    const tabs = await chrome.tabs.query({ incognito: true });
    const targetTabs = tabs.filter(tab => {
      if (specificTabId && tab.id !== specificTabId) return false;
      if (!tab.url) return false;
      try {
        const tabHost = new URL(tab.url).hostname;
        return tabHost === domain || tabHost.endsWith('.' + domain) || domain.endsWith('.' + tabHost);
      } catch {
        return false;
      }
    });
    
    if (targetTabs.length === 0) {
      console.log(`No incognito tabs found for ${domain}`);
      return result;
    }
    
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
        console.log(`Synced localStorage to tab ${tab.id}`);
      } catch (error) {
        console.error(`Failed to sync localStorage to tab ${tab.id}:`, error.message);
        result.failed++;
      }
    }
    
  } catch (error) {
    console.error('localStorage sync error:', error);
  }
  
  return result;
}

// 向特定标签页同步 localStorage
async function syncLocalStorageToTab(domain, tab) {
  if (!tab || !tab.id) return;
  
  const items = await getCachedLocalStorage(domain);
  
  if (!items || items.length === 0) {
    // 尝试从普通窗口获取
    const freshItems = await cacheLocalStorageForDomain(domain);
    if (!freshItems || freshItems.length === 0) {
      console.log(`No localStorage items to sync for ${domain}`);
      return;
    }
  }
  
  const itemsToSync = items || await getCachedLocalStorage(domain);
  
  if (itemsToSync && itemsToSync.length > 0) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'set_localStorage',
      domain: domain,
      items: itemsToSync
    }, (response) => {
      if (response && response.isOk) {
        console.log(`Synced ${itemsToSync.length} localStorage items to incognito tab`);
      }
    });
  }
}

// 刷新无痕标签页
async function reloadIncognitoTabs(domain) {
  console.log('Reloading incognito tabs for:', domain);
  const tabs = await chrome.tabs.query({ incognito: true });
  
  for (const tab of tabs) {
    if (tab.url) {
      try {
        const tabUrl = new URL(tab.url);
        if (tabUrl.hostname === domain || 
            tabUrl.hostname.endsWith('.' + domain) || 
            domain.endsWith('.' + tabUrl.hostname)) {
          console.log(`Reloading tab ${tab.id}: ${tab.url}`);
          chrome.tabs.reload(tab.id);
        }
      } catch (e) {
        // ignore
      }
    }
  }
}

// ==================== 存储变化监听 ====================
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.csync_websites) {
    configuredWebsites = changes.csync_websites.newValue || [];
    initCache();
  }
});

// ==================== 状态查询 ====================
async function getSyncStatus(domain) {
  const matchedWebsite = matchConfiguredDomain(domain);
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
  const incognitoStore = stores.find(s => s.id !== '0');
  
  let targetCookies = [];
  if (incognitoStore) {
    targetCookies = await chrome.cookies.getAll({ domain: domain, storeId: incognitoStore.id });
  }

  const matched = [];
  const missing = [];
  
  currentCookies.forEach(currentCookie => {
    const found = targetCookies.find(c => c.name === currentCookie.name);
    if (found) matched.push(currentCookie);
    else missing.push(currentCookie);
  });
  
  return {
    currentCookies,
    incognitoCookies: targetCookies,
    matched,
    missing,
    syncRate: currentCookies.length > 0 
      ? Math.round((matched.length / currentCookies.length) * 100) 
      : 0
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
