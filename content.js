// Csync Content Script
// 在页面中提供 Cookie 和 localStorage 同步功能

(function() {
  'use strict';
  
  const domain = window.location.hostname;
  
  // ==================== 消息监听 ====================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 获取 localStorage
    if (message.type === 'get_localStorage') {
      if (matchDomain(message.domain)) {
        try {
          const items = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              items.push({
                key: key,
                value: localStorage.getItem(key)
              });
            }
          }
          console.log('Csync: Got localStorage items:', items.length);
          sendResponse({ 
            isOk: true, 
            msg: 'get localStorage success',
            result: items 
          });
        } catch (error) {
          console.error('Csync: Failed to get localStorage:', error);
          sendResponse({ 
            isOk: false, 
            msg: 'get localStorage error',
            result: error.message 
          });
        }
      } else {
        sendResponse({ 
          isOk: false, 
          msg: 'domain not match' 
        });
      }
      return true;
    }
    
    // 设置 localStorage
    if (message.type === 'set_localStorage') {
      if (matchDomain(message.domain)) {
        try {
          const items = message.items || [];
          let setCount = 0;
          
          for (const item of items) {
            if (item.key) {
              localStorage.setItem(item.key, item.value || '');
              setCount++;
            }
          }
          
          console.log('Csync: Set localStorage items:', setCount);
          sendResponse({ 
            isOk: true, 
            msg: `set ${setCount} localStorage items success` 
          });
        } catch (error) {
          console.error('Csync: Failed to set localStorage:', error);
          sendResponse({ 
            isOk: false, 
            msg: 'set localStorage error',
            result: error.message 
          });
        }
      } else {
        sendResponse({ 
          isOk: false, 
          msg: 'domain not match' 
        });
      }
      return true;
    }
    
    // 手动同步请求的响应
    if (message.type === 'sync_cookies') {
      console.log('Csync: Received sync request for', message.domain);
    }
  });
  
  // ==================== 辅助函数 ====================
  
  // 检查域名是否匹配
  function matchDomain(targetDomain) {
    if (!targetDomain) return false;
    return location.hostname === targetDomain || 
           location.hostname.endsWith('.' + targetDomain) ||
           targetDomain.endsWith('.' + location.hostname);
  }
  
  // 检查是否是配置的网站
  function isConfiguredWebsite(websites) {
    return websites.some(website => {
      return domain === website || domain.endsWith('.' + website);
    });
  }
  
  // ==================== 初始化 ====================
  
  // 检查是否在无痕窗口中
  const isIncognito = chrome.extension.inIncognitoContext;
  
  if (isIncognito) {
    console.log('Csync: Running in incognito mode on', domain);
  }
  
  // 页面加载完成后的处理
  function onPageReady() {
    chrome.storage.sync.get(['csync_websites'], (result) => {
      const websites = result.csync_websites || [];
      
      if (isConfiguredWebsite(websites)) {
        console.log('Csync: Domain is configured for sync:', domain);
        
        // 如果在无痕窗口，通知 background 页面已准备好接收 localStorage
        if (isIncognito) {
          chrome.runtime.sendMessage({
            type: 'incognito_page_ready',
            domain: domain,
            url: location.href
          });
        }
      }
    });
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageReady);
  } else {
    onPageReady();
  }
  
  // ==================== 公开 API ====================
  
  window.Csync = {
    // 手动触发同步
    manualSync: function() {
      chrome.runtime.sendMessage({
        type: 'manual_sync_request',
        domain: domain
      });
    },
    
    // 获取当前页面的 localStorage（用于调试）
    getLocalStorage: function() {
      const items = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          items.push({
            key: key,
            value: localStorage.getItem(key)
          });
        }
      }
      console.log('localStorage items:', items);
      return items;
    },
    
    // 检查是否在无痕模式
    isIncognito: function() {
      return isIncognito;
    }
  };
  
  console.log('Csync: Content script loaded for', domain);
})();
