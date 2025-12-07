// Csync Background Script
// 监听标签页创建，同步Cookie到无痕窗口

let configuredWebsites = [];
// 记录域名最近一次同步时间，防止死循环刷新
const lastSyncTime = new Map();
const SYNC_COOLDOWN = 10000; // 10秒冷却时间

// 初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('Csync installed');
  loadWebsites();
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  loadWebsites();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'websites_updated') {
    configuredWebsites = message.websites;
    console.log('Websites updated:', configuredWebsites);
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
    syncCookiesToIncognito(message.domain, true);
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
      syncCookiesToIncognito(url.hostname, tab.incognito);
    } catch (e) {
      console.error('Invalid URL:', tab.url);
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito && tab.url && tab.url !== 'chrome://newtab/') {
    try {
      const url = new URL(tab.url);
      if (shouldSyncDomain(url.hostname)) {
        console.log('Syncing for created tab:', url.hostname);
        syncCookiesToIncognito(url.hostname, true);
      }
    } catch (error) {
      console.error('Error parsing URL:', error);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.incognito && changeInfo.status === 'complete' && tab.url) {
    try {
      const url = new URL(tab.url);
      if (shouldSyncDomain(url.hostname)) {
        console.log('Syncing for updated tab:', url.hostname);
        syncCookiesToIncognito(url.hostname, true);
      }
    } catch (error) {
      console.error('Error parsing URL:', error);
    }
  }
});

// 检查域名是否需要同步
function shouldSyncDomain(domain) {
  const isConfigured = configuredWebsites.some(website => {
    return domain === website || domain.endsWith('.' + website);
  });
  
  if (!isConfigured) return false;
  
  // 检查冷却时间
  const now = Date.now();
  const lastSync = lastSyncTime.get(domain) || 0;
  
  if (now - lastSync < SYNC_COOLDOWN) {
    console.log(`Skipping sync for ${domain}: in cooldown (${Math.round((SYNC_COOLDOWN - (now - lastSync))/1000)}s left)`);
    return false;
  }
  
  return true;
}

// 同步Cookie到无痕窗口
async function syncCookiesToIncognito(domain, isIncognito) {
  // 如果是自动触发（无痕模式），更新冷却时间
  if (isIncognito) {
    lastSyncTime.set(domain, Date.now());
  }

  try {
    console.log('Starting sync for:', domain);
    
    const cookieStores = await chrome.cookies.getAllCookieStores();
    const targetStores = cookieStores.filter(store => store.id !== '0');
    
    if (targetStores.length === 0) {
      console.warn('No incognito store found');
      return;
    }
    
    const cookies = await chrome.cookies.getAll({ domain: domain, storeId: '0' });
    console.log(`Found ${cookies.length} cookies`);
    
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
          
        } catch (error) {
          console.error(`Failed sync ${cookie.name}:`, error);
          // Retry logic: HostOnly
          try {
             const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
             await chrome.cookies.set({
                url: `https://${cleanDomain}${cookie.path}`,
                name: cookie.name,
                value: cookie.value,
                path: cookie.path,
                storeId: store.id
             });
             console.log(`Retry Synced (HostOnly): ${cookie.name}`);
          } catch (retryError) {
             console.error(`Retry failed:`, retryError);
          }
        }
      }
    }
    
    console.log('Sync completed');
    
    // 自动刷新相关的无痕标签页
    if (isIncognito) {
      console.log('Reloading incognito tabs for:', domain);
      const tabs = await chrome.tabs.query({}); // 获取所有标签页，然后过滤
      
      for (const tab of tabs) {
        // 只刷新属于该域名且是无痕模式的标签页
        if (tab.incognito && tab.url && (tab.url.includes(domain) || (new URL(tab.url)).hostname.endsWith(domain))) {
           console.log(`Reloading tab ${tab.id}: ${tab.url}`);
           chrome.tabs.reload(tab.id);
        }
      }
    }
    
    if (!isIncognito) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Csync',
        message: `已同步 ${cookies.length} 个 Cookie`
      });
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.csync_websites) {
    configuredWebsites = changes.csync_websites.newValue || [];
  }
});

async function verifyCookieSync(domain, currentCookies) {
  const stores = await chrome.cookies.getAllCookieStores();
  const incognitoStore = stores.find(s => s.id !== '0');
  
  let targetCookies = [];
  if (incognitoStore) {
      targetCookies = await chrome.cookies.getAll({ domain: domain, storeId: incognitoStore.id });
  }

  const matched = [];
  const missing = [];
  const extra = [];
  
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
    extra
  };
}

self.CsyncDebug = {
  testSouthPlus: async function() {
    const stores = await chrome.cookies.getAllCookieStores();
    console.log('Stores:', stores);
  }
};