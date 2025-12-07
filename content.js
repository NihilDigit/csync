// Csync Content Script
// 在页面中提供额外的同步功能

(function() {
  'use strict';
  
  // 检查是否在无痕窗口中
  if (chrome.extension.inIncognitoContext) {
    console.log('Csync: Running in incognito mode');
    
    // 监听来自background的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'sync_cookies') {
        console.log('Csync: Received sync request for', message.domain);
        // 可以在这里添加页面级别的同步逻辑
      }
    });
    
    // 页面加载完成后检查是否需要刷新以应用新的Cookie
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkAndRefresh);
    } else {
      checkAndRefresh();
    }
  }
  
  // 检查并刷新页面以应用Cookie
  function checkAndRefresh() {
    // 获取当前域名
    const domain = window.location.hostname;
    
    // 检查是否在配置的网站列表中
    chrome.storage.sync.get(['csync_websites'], (result) => {
      const websites = result.csync_websites || [];
      const shouldSync = websites.some(website => {
        return domain === website || domain.endsWith('.' + website);
      });
      
      if (shouldSync) {
        console.log('Csync: Domain is configured for sync:', domain);
        
        // 可以在这里添加页面特定的逻辑
        // 比如检查登录状态，如果未登录则提示用户
      }
    });
  }
  
  // 提供手动同步的API
  if (typeof window !== 'undefined') {
    window.Csync = {
      manualSync: function() {
        const domain = window.location.hostname;
        chrome.runtime.sendMessage({
          type: 'manual_sync_request',
          domain: domain
        });
      }
    };
  }
})();