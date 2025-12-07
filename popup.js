// Csync Popup Script
// 显示当前网站信息，管理Cookie和配置

let currentTab = null;
let currentDomain = '';
let currentUrl = '';

document.addEventListener('DOMContentLoaded', function() {
  // 获取DOM元素
  const addToCsyncBtn = document.getElementById('addToCsyncBtn');
  const refreshCookiesBtn = document.getElementById('refreshCookiesBtn');
  const currentSiteUrl = document.getElementById('currentSiteUrl');
  const currentSiteDomain = document.getElementById('currentSiteDomain');
  const cookieList = document.getElementById('cookieList');
  const websiteList = document.getElementById('websiteList');
  const statusMessage = document.getElementById('statusMessage');
  
  // 初始化
  init();
  
  // 绑定事件
  addToCsyncBtn.addEventListener('click', addToCsync);
  refreshCookiesBtn.addEventListener('click', loadCookies);
  document.getElementById('verifySyncBtn').addEventListener('click', verifySync);
  
  // 初始化函数
  async function init() {
    try {
      // 获取当前标签页
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tabs[0];
      
      if (currentTab) {
        currentUrl = currentTab.url;
        
        // 解析域名
        try {
          const url = new URL(currentUrl);
          currentDomain = url.hostname;
          
          // 更新UI
          currentSiteUrl.textContent = currentDomain;
          currentSiteDomain.textContent = `完整URL: ${currentUrl.substring(0, 50)}${currentUrl.length > 50 ? '...' : ''}`;
          
          // 检查是否已在配置中
          checkIfConfigured();
          
          // 加载Cookie
          loadCookies();
          
        } catch (error) {
          showError('无法解析当前URL: ' + error.message);
        }
      }
    } catch (error) {
      showError('获取当前标签页失败: ' + error.message);
    }
    
    // 加载已配置网站列表
    loadConfiguredWebsites();
  }
  
  // 检查当前网站是否已配置
  async function checkIfConfigured() {
    try {
      const result = await chrome.storage.sync.get(['csync_websites']);
      const websites = result.csync_websites || [];
      
      if (websites.includes(currentDomain)) {
        addToCsyncBtn.textContent = '✅ 已在Csync中';
        addToCsyncBtn.disabled = true;
        addToCsyncBtn.classList.remove('btn-success');
        addToCsyncBtn.classList.add('btn-primary');
      } else {
        addToCsyncBtn.textContent = '➕ 添加到Csync';
        addToCsyncBtn.disabled = false;
        addToCsyncBtn.classList.add('btn-success');
        addToCsyncBtn.classList.remove('btn-primary');
      }
    } catch (error) {
      console.error('检查配置状态失败:', error);
    }
  }
  
  // 加载Cookie信息
  async function loadCookies() {
    cookieList.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        正在加载Cookie...
      </div>
    `;
    
    try {
      // 获取当前域名的Cookie
      const cookies = await chrome.cookies.getAll({ domain: currentDomain });
      
      // 获取www子域名的Cookie
      const wwwDomain = currentDomain.startsWith('www.') ? currentDomain : `www.${currentDomain}`;
      const wwwCookies = await chrome.cookies.getAll({ domain: wwwDomain });
      
      // 合并Cookie（去重）
      const allCookies = [...cookies];
      wwwCookies.forEach(wwwCookie => {
        if (!allCookies.find(c => c.name === wwwCookie.name && c.domain === wwwCookie.domain)) {
          allCookies.push(wwwCookie);
        }
      });
      
      // 更新Cookie数量
      document.getElementById('cookieCount').textContent = allCookies.length;
      
      if (allCookies.length === 0) {
        cookieList.innerHTML = '<div class="empty-state">当前网站没有Cookie</div>';
        return;
      }
      
      // 渲染Cookie列表
      cookieList.innerHTML = allCookies.map(cookie => `
        <div class="cookie-item">
          <div class="cookie-info">
            <div class="cookie-name">${escapeHtml(cookie.name)}</div>
            <div class="cookie-details">
              域名: ${escapeHtml(cookie.domain)} | 
              路径: ${escapeHtml(cookie.path)} | 
              ${cookie.secure ? '🔒' : '🌐'} 
              ${cookie.httpOnly ? '🔒' : ''}
            </div>
          </div>
          <div class="cookie-value" title="${escapeHtml(cookie.value)}">
            ${escapeHtml(cookie.value.substring(0, 20))}${cookie.value.length > 20 ? '...' : ''}
          </div>
        </div>
      `).join('');
      
    } catch (error) {
      console.error('加载Cookie失败:', error);
      cookieList.innerHTML = '<div class="empty-state">加载Cookie失败: ' + escapeHtml(error.message) + '</div>';
    }
  }
  
  // 添加到Csync
  async function addToCsync() {
    try {
      const result = await chrome.storage.sync.get(['csync_websites']);
      const websites = result.csync_websites || [];
      
      if (websites.includes(currentDomain)) {
        showInfo('当前网站已在配置列表中');
        return;
      }
      
      // 添加到配置
      websites.push(currentDomain);
      await chrome.storage.sync.set({ csync_websites: websites });
      
      // 更新UI
      addToCsyncBtn.textContent = '✅ 已在Csync中';
      addToCsyncBtn.disabled = true;
      addToCsyncBtn.classList.remove('btn-success');
      addToCsyncBtn.classList.add('btn-primary');
      
      showSuccess(`已将 ${currentDomain} 添加到Csync配置`);
      
      // 重新加载配置列表
      loadConfiguredWebsites();
      
      // 通知background script
      chrome.runtime.sendMessage({
        type: 'websites_updated',
        websites: websites
      });
      
    } catch (error) {
      showError('添加到Csync失败: ' + error.message);
    }
  }
  
  // 加载已配置网站列表
  async function loadConfiguredWebsites() {
    try {
      const result = await chrome.storage.sync.get(['csync_websites']);
      const websites = result.csync_websites || [];
      
      // 更新数量
      document.getElementById('configuredCount').textContent = websites.length;
      
      if (websites.length === 0) {
        websiteList.innerHTML = '<div class="empty-state">暂无配置网站</div>';
        return;
      }
      
      // 渲染网站列表
      websiteList.innerHTML = websites.map((website, index) => `
        <div class="website-item">
          <div class="website-url">${escapeHtml(website)}</div>
          <button class="btn btn-danger btn-sm" data-index="${index}">删除</button>
        </div>
      `).join('');
      
      // 绑定删除事件
      websiteList.querySelectorAll('.btn-danger').forEach(btn => {
        btn.addEventListener('click', function() {
          const index = parseInt(this.dataset.index);
          removeWebsite(index);
        });
      });
      
    } catch (error) {
      console.error('加载配置网站失败:', error);
    }
  }
  
  // 删除网站
  async function removeWebsite(index) {
    try {
      const result = await chrome.storage.sync.get(['csync_websites']);
      const websites = result.csync_websites || [];
      
      const removed = websites.splice(index, 1);
      await chrome.storage.sync.set({ csync_websites: websites });
      
      showSuccess(`已删除网站: ${removed[0]}`);
      
      // 如果删除的是当前网站，更新按钮状态
      if (removed[0] === currentDomain) {
        addToCsyncBtn.textContent = '➕ 添加到Csync';
        addToCsyncBtn.disabled = false;
        addToCsyncBtn.classList.add('btn-success');
        addToCsyncBtn.classList.remove('btn-primary');
      }
      
      // 重新加载列表
      loadConfiguredWebsites();
      
      // 通知background script
      chrome.runtime.sendMessage({
        type: 'websites_updated',
        websites: websites
      });
      
    } catch (error) {
      showError('删除网站失败: ' + error.message);
    }
  };
  
  // 显示状态消息
  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status ${type}`;
    statusMessage.style.display = 'block';
    
    // 3秒后自动隐藏
    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 3000);
  }
  
  function showSuccess(message) {
    showStatus(message, 'success');
  }
  
  function showError(message) {
    showStatus(message, 'error');
  }
  
  function showInfo(message) {
    showStatus(message, 'info');
  }
  
  // 验证Cookie同步
  async function verifySync() {
    const syncResult = document.getElementById('syncResult');
    const syncResultContent = document.getElementById('syncResultContent');
    
    syncResult.style.display = 'block';
    syncResultContent.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        正在验证Cookie同步...
      </div>
    `;
    
    try {
      // 获取当前窗口的Cookie
      const currentCookies = await chrome.cookies.getAll({ domain: currentDomain });
      const wwwDomain = currentDomain.startsWith('www.') ? currentDomain : `www.${currentDomain}`;
      const wwwCookies = await chrome.cookies.getAll({ domain: wwwDomain });
      
      // 合并Cookie
      const allCurrentCookies = [...currentCookies];
      wwwCookies.forEach(cookie => {
        if (!allCurrentCookies.find(c => c.name === cookie.name && c.domain === cookie.domain)) {
          allCurrentCookies.push(cookie);
        }
      });
      
      // 请求background script检查无痕窗口的Cookie
      const response = await chrome.runtime.sendMessage({
        type: 'verify_sync',
        domain: currentDomain,
        currentCookies: allCurrentCookies.map(c => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          value: c.value.substring(0, 20) + '...'
        }))
      });
      
      if (response && response.success) {
        displaySyncResult(response.data);
      } else {
        syncResultContent.innerHTML = `
          <div style="color: #dc3545; text-align: center; padding: 20px;">
            ❌ 验证失败: ${response ? response.error : '未知错误'}
          </div>
        `;
      }
      
    } catch (error) {
      console.error('验证同步失败:', error);
      syncResultContent.innerHTML = `
        <div style="color: #dc3545; text-align: center; padding: 20px;">
          ❌ 验证失败: ${error.message}
        </div>
      `;
    }
  }
  
  // 显示同步结果
  function displaySyncResult(data) {
    const syncResultContent = document.getElementById('syncResultContent');
    
    const { currentCookies, incognitoCookies, matched, missing, extra } = data;
    
    let html = `
      <div style="margin-bottom: 16px;">
        <strong>📊 同步统计:</strong><br>
        • 当前窗口Cookie: ${currentCookies.length} 个<br>
        • 无痕窗口Cookie: ${incognitoCookies.length} 个<br>
        • 成功同步: ${matched.length} 个<br>
        • 缺失Cookie: ${missing.length} 个<br>
        • 额外Cookie: ${extra.length} 个
      </div>
    `;
    
    if (matched.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <strong style="color: #28a745;">✅ 成功同步的Cookie:</strong>
          <div style="max-height: 100px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; margin-top: 4px;">
            ${matched.map(cookie => `
              <div style="font-size: 11px; padding: 2px 0;">
                <strong>${escapeHtml(cookie.name)}</strong> = ${escapeHtml(cookie.value)}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    if (missing.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <strong style="color: #dc3545;">❌ 缺失的Cookie:</strong>
          <div style="max-height: 100px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; margin-top: 4px;">
            ${missing.map(cookie => `
              <div style="font-size: 11px; padding: 2px 0;">
                <strong>${escapeHtml(cookie.name)}</strong> = ${escapeHtml(cookie.value)}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    if (extra.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <strong style="color: #ffc107;">⚠️ 额外的Cookie:</strong>
          <div style="max-height: 100px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; margin-top: 4px;">
            ${extra.map(cookie => `
              <div style="font-size: 11px; padding: 2px 0;">
                <strong>${escapeHtml(cookie.name)}</strong> = ${escapeHtml(cookie.value)}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    // 总体状态
    const status = missing.length === 0 ? 
      '<div style="color: #28a745; font-weight: bold; text-align: center; padding: 8px; background: #d4edda; border-radius: 4px;">✅ Cookie同步完全成功！</div>' :
      '<div style="color: #dc3545; font-weight: bold; text-align: center; padding: 8px; background: #f8d7da; border-radius: 4px;">❌ Cookie同步不完整</div>';
    
    html = status + html;
    
    syncResultContent.innerHTML = html;
  }
  
  // HTML转义
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});