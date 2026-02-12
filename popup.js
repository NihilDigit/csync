// Csync Popup Script

let currentDomain = '';

document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('addBtn');
  const syncBtn = document.getElementById('syncBtn');

  addBtn.addEventListener('click', toggleSite);
  syncBtn.addEventListener('click', manualSync);

  init();

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;

      const url = new URL(tab.url);
      currentDomain = url.hostname;
      document.getElementById('siteDomain').textContent = currentDomain;

      updateAddButton();
      loadSites();
      loadStatus();
    } catch (e) {
      toast('Failed to load: ' + e.message, 'error');
    }
  }

  // ---- Add / Remove site ----

  async function updateAddButton() {
    const websites = await getWebsites();
    if (websites.includes(currentDomain)) {
      addBtn.textContent = 'Added';
      addBtn.className = 'btn btn-added';
      addBtn.dataset.action = 'remove';
    } else {
      addBtn.textContent = 'Add to Csync';
      addBtn.className = 'btn btn-add';
      addBtn.dataset.action = 'add';
    }
  }

  async function toggleSite() {
    const websites = await getWebsites();

    if (addBtn.dataset.action === 'add') {
      if (!websites.includes(currentDomain)) websites.push(currentDomain);
      await saveWebsites(websites);
      toast(`Added ${currentDomain}`, 'success');
    } else {
      const idx = websites.indexOf(currentDomain);
      if (idx !== -1) websites.splice(idx, 1);
      await saveWebsites(websites);
      toast(`Removed ${currentDomain}`, 'info');
    }

    updateAddButton();
    loadSites();
    loadStatus();
  }

  // ---- Sites list ----

  async function loadSites() {
    const websites = await getWebsites();
    const container = document.getElementById('sitesList');
    document.getElementById('sitesCount').textContent = websites.length;

    if (websites.length === 0) {
      container.innerHTML = '<div class="empty">No sites configured yet</div>';
      return;
    }

    container.innerHTML = websites.map((site, i) => `
      <div class="site-item">
        <span class="site-name">${esc(site)}</span>
        <button class="site-remove" data-index="${i}" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.site-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        const sites = await getWebsites();
        const removed = sites.splice(idx, 1)[0];
        await saveWebsites(sites);
        toast(`Removed ${removed}`, 'info');
        updateAddButton();
        loadSites();
      });
    });
  }

  // ---- Status ----

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'get_sync_status',
        domain: currentDomain
      });

      if (!resp?.success) return;
      const s = resp.data;
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');

      if (!s.isConfigured) {
        dot.className = 'status-dot off';
        text.textContent = 'Site not in sync list';
      } else if (!s.hasIncognito) {
        dot.className = 'status-dot off';
        text.textContent = 'No incognito window open';
      } else if (s.cachedCookies > 0 && s.lastSyncTime) {
        dot.className = 'status-dot ok';
        text.textContent = `${s.cachedCookies} cookies cached · synced ${timeAgo(s.lastSyncTime)}`;
      } else if (s.cachedCookies > 0) {
        dot.className = 'status-dot ok';
        text.textContent = `${s.cachedCookies} cookies cached · ready to sync`;
      } else {
        dot.className = 'status-dot warn';
        text.textContent = 'No cookies found for this site';
      }
    } catch {
      // ignore
    }
  }

  // ---- Manual sync ----

  async function manualSync() {
    syncBtn.disabled = true;
    toast('Syncing...', 'info');

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'manual_sync_request',
        domain: currentDomain
      });
      if (resp?.success === false) {
        toast('Sync failed: ' + (resp.error || 'unknown error'), 'error');
      }
      await loadStatus();
    } catch (e) {
      toast('Sync failed: ' + e.message, 'error');
    } finally {
      syncBtn.disabled = false;
    }
  }

  // ---- Helpers ----

  async function getWebsites() {
    const r = await chrome.storage.sync.get(['csync_websites']);
    return r.csync_websites || [];
  }

  async function saveWebsites(websites) {
    await chrome.storage.sync.set({ csync_websites: websites });
    chrome.runtime.sendMessage({ type: 'websites_updated', websites });
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  let toastTimer;
  function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }
});
