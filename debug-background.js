// 添加到background.js的调试函数

// 调试命令：在Service Worker Console中运行这些函数
window.CsyncDebug = {
  // 测试获取所有Cookie
  async testGetAllCookies(domain = 'example.com') {
    console.log('=== 测试获取Cookie ===');
    try {
      const cookies = await chrome.cookies.getAll({ domain: domain });
      console.log(`域名 ${domain} 的Cookie:`, cookies);
      return cookies;
    } catch (error) {
      console.error('获取Cookie失败:', error);
    }
  },

  // 测试设置Cookie
  async testSetCookie() {
    console.log('=== 测试设置Cookie ===');
    try {
      const result = await chrome.cookies.set({
        url: 'https://example.com/',
        name: 'csync_test',
        value: 'test_value_' + Date.now(),
        domain: 'example.com',
        path: '/'
      });
      console.log('设置Cookie成功:', result);
      return result;
    } catch (error) {
      console.error('设置Cookie失败:', error);
    }
  },

  // 查看当前配置
  async showConfig() {
    console.log('=== 当前配置 ===');
    const result = await chrome.storage.sync.get(['csync_websites']);
    console.log('配置的网站:', result.csync_websites);
    return result.csync_websites;
  },

  // 手动触发同步
  async manualSync(domain = 'example.com') {
    console.log('=== 手动触发同步 ===');
    await syncCookiesToIncognito(domain, false);
  },

  // 测试域名匹配
  testDomainMatching() {
    console.log('=== 测试域名匹配 ===');
    const testDomains = ['example.com', 'sub.example.com', 'google.com', 'mail.google.com'];
    testDomains.forEach(domain => {
      console.log(`${domain} -> ${shouldSyncDomain(domain)}`);
    });
  }
};

console.log('Csync调试函数已加载。使用 CsyncDebug.testGetAllCookies() 等命令进行测试');

// 添加south-plus.net专用调试函数
window.CsyncDebug.testSouthPlus = async function() {
  console.log('=== 测试 south-plus.net ===');
  
  // 测试获取Cookie
  const cookies = await chrome.cookies.getAll({ domain: 'south-plus.net' });
  console.log('south-plus.net Cookie数量:', cookies.length);
  
  cookies.forEach((cookie, index) => {
    console.log(`Cookie ${index}:`, {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      valueLength: cookie.value ? cookie.value.length : 0
    });
  });
  
  // 测试子域名
  const wwwCookies = await chrome.cookies.getAll({ domain: 'www.south-plus.net' });
  console.log('www.south-plus.net Cookie数量:', wwwCookies.length);
  
  return { main: cookies, www: wwwCookies };
};

// 添加south-plus.net到配置的快捷函数
window.CsyncDebug.addSouthPlus = async function() {
  console.log('=== 添加 south-plus.net 到配置 ===');
  const result = await chrome.storage.sync.get(['csync_websites']);
  const websites = result.csync_websites || [];
  
  if (!websites.includes('south-plus.net')) {
    websites.push('south-plus.net');
    await chrome.storage.sync.set({ csync_websites: websites });
    console.log('已添加 south-plus.net 到配置列表');
    configuredWebsites = websites; // 更新内存中的配置
  } else {
    console.log('south-plus.net 已在配置列表中');
  }
  
  return websites;
};