// Csync Background Script
// 监听标签页创建，同步Cookie到无痕窗口
// 借鉴 sync-your-cookie 项目的设计

let configuredWebsites = [];

// ==================== 防抖和批量处理 ====================
// 记录域名最近一次同步时间，防止死循环刷新
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
  // 初始化时缓存配置网站的 cookies
  setTimeout(initCookieCache, 500);
});

chrome.runtime.onStartup.addListener(() => {
  loadWebsites();
  // 启动时也缓存 cookies
  setTimeout(initCookieCache, 1000);
});

// ==================== 消息处理 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'websites_updated') {
    configuredWebsites = message.websites;
    console.log('Websites updated:', configuredWebsites);
    // 配置更新后重新缓存
    initCookieCache();
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
    // 手动同步时强制刷新缓存并同步
    manualSync(message.domain);
    sendResponse({ success: true });
  } else if (message.type === 'get_sync_status') {
    // 获取同步状态
    getSyncStatus(message.domain).then(status => {
      sendResponse({ success: true, data: status });
    });
    return true;
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
    title: '同步当前网站Cookie到无痕窗口',
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

// ==================== Cookie 缓存机制 ====================

// 初始化 cookie 缓存 - 为所有配置的网站缓存 cookies
async function initCookieCache() {
  console.log('Initializing cookie cache for configured websites...');
  for (const website of configuredWebsites) {
    await cacheCookiesForDomain(website);
  }
  console.log('Cookie cache initialized');
}

// 为指定域名缓存 cookies（从普通窗口读取）
async function cacheCookiesForDomain(domain) {
  try {
    // 从普通窗口（storeId: '0'）获取 cookies
    const cookies = await chrome.cookies.getAll({ domain: domain, storeId: '0' });
    
    if (cookies.length === 0) {
      console.log(`No cookies found for ${domain} in normal window`);
      return;
    }

    // 将 cookies 存储到 local storage
    const cacheKey = `csync_cache_${domain}`;
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

// 从缓存获取 cookies
async function getCachedCookies(domain) {
  // 尝试精确匹配
  let cacheKey = `csync_cache_${domain}`;
  let result = await chrome.storage.local.get([cacheKey]);
  
  if (result[cacheKey]) {
    return result[cacheKey].cookies;
  }
  
  // 尝试匹配父域名
  for (const website of configuredWebsites) {
    if (domain === website || domain.endsWith('.' + website)) {
      cacheKey = `csync_cache_${website}`;
      result = await chrome.storage.local.get([cacheKey]);
      if (result[cacheKey]) {
        return result[cacheKey].cookies;
      }
    }
  }
  
  return [];
}

// ==================== Cookie 变化监听（带防抖）====================

// 检查域名是否匹配配置
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

// 监听 cookie 变化（借鉴 sync-your-cookie 的防抖设计）
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;
  const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
  
  // 只处理普通窗口的 cookie 变化
  if (cookie.storeId !== '0') {
    return;
  }
  
  // 检查是否是配置的网站
  const matchedWebsite = matchConfiguredDomain(domain);
  if (!matchedWebsite) {
    return;
  }
  
  // 如果已经在等待超时，跳过
  if (cookieChangeTimer && cookieChangeTimeoutFlag) {
    return;
  }
  
  // 清除之前的定时器
  if (cookieChangeTimer) {
    clearTimeout(cookieChangeTimer);
  }
  
  // 记录变化的域名
  changedDomainSet.add(matchedWebsite);
  
  // 设置新的防抖定时器
  cookieChangeTimer = setTimeout(async () => {
    cookieChangeTimeoutFlag = false;
    
    console.log('Processing cookie changes for:', Array.from(changedDomainSet));
    
    // 批量处理所有变化的域名
    for (const website of changedDomainSet) {
      await cacheCookiesForDomain(website);
      
      // 如果有无痕窗口打开，自动同步
      const incognitoStores = await getIncognitoStores();
      if (incognitoStores.length > 0) {
        // 检查冷却时间
        const now = Date.now();
        const lastSync = lastSyncTime.get(website) || 0;
        if (now - lastSync >= SYNC_COOLDOWN) {
          console.log(`Auto-syncing ${website} to incognito after cookie change`);
          await syncCookiesToIncognito(website, false);
        }
      }
    }
    
    changedDomainSet.clear();
  }, DEBOUNCE_DELAY);
  
  // 设置最大等待时间
  if (!cookieChangeTimeoutFlag) {
    setTimeout(() => {
      if (cookieChangeTimer) {
        console.log('Max debounce wait reached, forcing process');
        cookieChangeTimeoutFlag = true;
        clearTimeout(cookieChangeTimer);
        cookieChangeTimer = null;
        
        // 强制处理
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

// 获取无痕窗口的 cookie stores
async function getIncognitoStores() {
  const cookieStores = await chrome.cookies.getAllCookieStores();
  return cookieStores.filter(store => store.id !== '0');
}

// ==================== 同步逻辑 ====================

// 检查并执行同步（用于标签页事件）
async function checkAndSync(domain, tabId) {
  const matchedWebsite = matchConfiguredDomain(domain);
  if (!matchedWebsite) return;

  // 检查冷却时间
  const now = Date.now();
  const lastSync = lastSyncTime.get(domain) || 0;
  
  if (now - lastSync < SYNC_COOLDOWN) {
    console.log(`Skipping sync for ${domain}: in cooldown`);
    return;
  }

  console.log(`Starting sync for ${domain}...`);
  lastSyncTime.set(domain, now);
  await syncCookiesToIncognito(matchedWebsite, true);
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
  
  // 先更新缓存
  await cacheCookiesForDomain(matchedWebsite);
  
  // 然后同步
  await syncCookiesToIncognito(matchedWebsite, true);
  
  // 显示通知
  const cookies = await chrome.cookies.getAll({ domain: matchedWebsite, storeId: '0' });
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Csync',
    message: `已同步 ${cookies.length} 个 Cookie 到无痕窗口`
  });
}

// 核心同步函数
async function syncCookiesToIncognito(domain, shouldReload = false) {
  try {
    console.log('Starting sync for:', domain);
    
    // 获取无痕窗口的 cookie stores
    const targetStores = await getIncognitoStores();
    
    if (targetStores.length === 0) {
      console.log('No incognito window open, cookies are cached for later');
      return { success: false, reason: 'no_incognito' };
    }
    
    // 优先从普通窗口直接获取 cookies
    let cookies = await chrome.cookies.getAll({ domain: domain, storeId: '0' });
    
    // 如果普通窗口没有，尝试从缓存获取
    if (cookies.length === 0) {
      console.log('No cookies in normal window, trying cache...');
      cookies = await getCachedCookies(domain);
    }
    
    if (cookies.length === 0) {
      console.log(`No cookies found for ${domain}`);
      return { success: false, reason: 'no_cookies' };
    }
    
    console.log(`Found ${cookies.length} cookies to sync`);
    
    let syncedCount = 0;
    let failedCount = 0;
    
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
          syncedCount++;
          
        } catch (error) {
          // Retry with simplified options
          try {
             const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
             await chrome.cookies.set({
                url: `https://${cleanDomain}${cookie.path}`,
                name: cookie.name,
                value: cookie.value,
                path: cookie.path,
                storeId: store.id
             });
             syncedCount++;
          } catch (retryError) {
             failedCount++;
             console.error(`Failed to sync cookie ${cookie.name}:`, retryError.message);
          }
        }
      }
    }
    
    console.log(`Sync completed: ${syncedCount} synced, ${failedCount} failed`);
    
    // 更新同步时间
    lastSyncTime.set(domain, Date.now());
    
    // 自动刷新相关的无痕标签页
    if (shouldReload && syncedCount > 0) {
      await reloadIncognitoTabs(domain);
    }
    
    return { success: true, synced: syncedCount, failed: failedCount };
    
  } catch (error) {
    console.error('Fatal sync error:', error);
    return { success: false, reason: 'error', error: error.message };
  }
}

// 刷新无痕标签页
async function reloadIncognitoTabs(domain) {
  console.log('Reloading incognito tabs for:', domain);
  const tabs = await chrome.tabs.query({});
  
  for (const tab of tabs) {
    if (tab.incognito && tab.url) {
      try {
        const tabUrl = new URL(tab.url);
        if (tabUrl.hostname === domain || 
            tabUrl.hostname.endsWith('.' + domain) || 
            domain.endsWith('.' + tabUrl.hostname)) {
          console.log(`Reloading tab ${tab.id}: ${tab.url}`);
          chrome.tabs.reload(tab.id);
        }
      } catch (e) {
        // ignore invalid URLs
      }
    }
  }
}

// ==================== 存储变化监听 ====================
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.csync_websites) {
    configuredWebsites = changes.csync_websites.newValue || [];
    // 配置变化时重新缓存
    initCookieCache();
  }
});

// ==================== 状态查询 ====================
async function getSyncStatus(domain) {
  const matchedWebsite = matchConfiguredDomain(domain);
  const incognitoStores = await getIncognitoStores();
  const lastSync = lastSyncTime.get(domain);
  
  const cacheKey = `csync_cache_${matchedWebsite || domain}`;
  const cacheResult = await chrome.storage.local.get([cacheKey]);
  
  return {
    isConfigured: !!matchedWebsite,
    hasIncognito: incognitoStores.length > 0,
    lastSyncTime: lastSync || null,
    cachedCookies: cacheResult[cacheKey]?.cookies?.length || 0,
    cacheTimestamp: cacheResult[cacheKey]?.timestamp || null
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
    const cacheKeys = Object.keys(keys).filter(k => k.startsWith('csync_cache_'));
    await chrome.storage.local.remove(cacheKeys);
    console.log('Cache cleared:', cacheKeys);
  },
  forceSync: async function(domain) {
    console.log('Force syncing:', domain);
    return await syncCookiesToIncognito(domain, true);
  },
  getStatus: async function(domain) {
    return await getSyncStatus(domain);
  }
};
