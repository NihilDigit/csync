// Csync Content Script
// 在页面中提供 Cookie 和 localStorage 同步功能

(function() {
  'use strict';
  
  const domain = window.location.hostname;
  const DEBUG = true; // 调试开关
  
  function log(...args) {
    if (DEBUG) {
      console.log('[Csync]', ...args);
    }
  }
  
  // ==================== 消息监听 ====================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Received message:', message.type, 'for domain:', message.domain, 'current:', domain);
    
    // 获取 localStorage
    if (message.type === 'get_localStorage') {
      log('Checking domain match:', message.domain, 'vs', domain, '=', matchDomain(message.domain));
      
      if (matchDomain(message.domain)) {
        try {
          const items = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              const value = localStorage.getItem(key);
              items.push({ key, value });
              log('  -', key, '=', value ? value.substring(0, 50) + '...' : '(empty)');
            }
          }
          log('Got localStorage items:', items.length);
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
        log('Domain not match, skipping');
        sendResponse({ 
          isOk: false, 
          msg: `domain not match: ${message.domain} vs ${domain}` 
        });
      }
      return true;
    }
    
    // 设置 localStorage
    if (message.type === 'set_localStorage') {
      log('Checking domain match for set:', message.domain, 'vs', domain, '=', matchDomain(message.domain));
      
      if (matchDomain(message.domain)) {
        try {
          const items = message.items || [];
          let setCount = 0;
          
          log('Setting', items.length, 'localStorage items');
          for (const item of items) {
            if (item.key) {
              localStorage.setItem(item.key, item.value || '');
              setCount++;
              log('  Set:', item.key, '=', item.value ? item.value.substring(0, 30) + '...' : '(empty)');
            }
          }
          
          log('Set localStorage items:', setCount);
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
        log('Domain not match for set, skipping');
        sendResponse({ 
          isOk: false, 
          msg: `domain not match: ${message.domain} vs ${domain}` 
        });
      }
      return true;
    }
    
    // 手动同步请求的响应
    if (message.type === 'sync_cookies') {
      log('Received sync request for', message.domain);
    }
  });
  
  // ==================== 辅助函数 ====================
  
  // 检查域名是否匹配（更宽松的匹配）
  function matchDomain(targetDomain) {
    if (!targetDomain) return false;
    const currentHost = location.hostname;
    
    // 精确匹配
    if (currentHost === targetDomain) return true;
    
    // 子域名匹配: www.touchgal.io matches touchgal.io
    if (currentHost.endsWith('.' + targetDomain)) return true;
    
    // 反向匹配: touchgal.io matches www.touchgal.io
    if (targetDomain.endsWith('.' + currentHost)) return true;
    
    // 提取根域名比较
    const currentParts = currentHost.split('.');
    const targetParts = targetDomain.split('.');
    
    // 获取根域名 (最后两部分，如 touchgal.io)
    const currentRoot = currentParts.slice(-2).join('.');
    const targetRoot = targetParts.slice(-2).join('.');
    
    return currentRoot === targetRoot;
  }
  
  // 检查是否是配置的网站
  function isConfiguredWebsite(websites) {
    return websites.some(website => matchDomain(website));
  }
  
  // ==================== 初始化 ====================
  
  // 检查是否在无痕窗口中
  const isIncognito = chrome.extension.inIncognitoContext;
  
  log('Content script loaded, incognito:', isIncognito, 'domain:', domain);
  
  // 页面加载完成后的处理
  function onPageReady() {
    log('Page ready, checking configuration...');
    
    chrome.storage.sync.get(['csync_websites'], (result) => {
      const websites = result.csync_websites || [];
      log('Configured websites:', websites);
      
      const isConfigured = isConfiguredWebsite(websites);
      log('Is configured:', isConfigured);
      
      if (isConfigured) {
        log('Domain is configured for sync:', domain);
        
        // 如果在无痕窗口，通知 background 页面已准备好接收 localStorage
        if (isIncognito) {
          log('Sending incognito_page_ready message...');
          chrome.runtime.sendMessage({
            type: 'incognito_page_ready',
            domain: domain,
            url: location.href
          }, (response) => {
            log('incognito_page_ready response:', response);
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
      log('Manual sync triggered');
      chrome.runtime.sendMessage({
        type: 'manual_sync_request',
        domain: domain
      }, (response) => {
        log('Manual sync response:', response);
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
    },
    
    // 调试信息
    debug: function() {
      console.log('=== Csync Debug Info ===');
      console.log('Domain:', domain);
      console.log('Is Incognito:', isIncognito);
      console.log('localStorage items:', localStorage.length);
      
      chrome.storage.sync.get(['csync_websites'], (result) => {
        console.log('Configured websites:', result.csync_websites);
        console.log('Is configured:', isConfiguredWebsite(result.csync_websites || []));
      });
    }
  };
  
  log('Content script initialized for', domain);
})();
