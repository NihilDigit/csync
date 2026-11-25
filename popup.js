// Csync Popup Script (ES Module)
import { findMatchingSite, isSyncableUrl, normalizeHost } from './sync-utils.js';

const WEBSITES_KEY = 'csync_websites';

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';

const EMPTY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';

let currentDomain = '';
let currentOrigin = '';
let currentFavIconUrl = '';
let currentTabSyncable = false;
let matchedRule = null;

document.addEventListener('DOMContentLoaded', () => {
  const versionLabel = document.getElementById('versionLabel');
  const incognitoPill = document.getElementById('incognitoPill');
  const incognitoText = document.getElementById('incognitoText');
  const heroCard = document.getElementById('heroCard');
  const siteAvatar = document.getElementById('siteAvatar');
  const siteDomainEl = document.getElementById('siteDomain');
  const siteStatusEl = document.getElementById('siteStatus');
  const siteSwitch = document.getElementById('siteSwitch');
  const cookieCountEl = document.getElementById('cookieCount');
  const storageCountEl = document.getElementById('storageCount');
  const syncBtn = document.getElementById('syncBtn');
  const syncLabelEl = document.getElementById('syncLabel');
  const sitesCountEl = document.getElementById('sitesCount');
  const sitesListEl = document.getElementById('sitesList');
  const snackbarEl = document.getElementById('snackbar');
  const snackbarTextEl = document.getElementById('snackbarText');
  const snackbarActionEl = document.getElementById('snackbarAction');

  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

  siteSwitch.addEventListener('click', handleToggleSite);
  syncBtn.addEventListener('click', handleManualSync);

  let snackbarTimer = null;
  let snackbarUndoHandler = null;

  snackbarActionEl.addEventListener('click', async () => {
    const handler = snackbarUndoHandler;
    hideSnackbar();
    if (handler) await handler();
  });

  init();

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (tab?.url && isSyncableUrl(tab.url)) {
        const url = new URL(tab.url);
        currentDomain = normalizeHost(url.hostname);
        currentOrigin = url.origin;
        currentFavIconUrl = tab.favIconUrl || '';
        currentTabSyncable = true;
        siteDomainEl.textContent = currentDomain;
        siteDomainEl.title = currentDomain;
        renderAvatar(currentDomain, currentFavIconUrl);
      } else {
        currentDomain = '';
        currentOrigin = '';
        currentFavIconUrl = '';
        currentTabSyncable = false;
        siteDomainEl.textContent = 'Browser page';
        siteStatusEl.textContent = 'Open a website to sync it';
        renderAvatar('', '');
      }

      await refreshAll();
    } catch (e) {
      showSnackbar(`Couldn't load tab info: ${e.message}`);
    }
  }

  function renderAvatar(domain, favIconUrl) {
    siteAvatar.innerHTML = '';
    siteAvatar.classList.remove('has-favicon');

    const fallbackChar = domain ? domain.charAt(0).toUpperCase() : '—';

    if (favIconUrl && (favIconUrl.startsWith('http://') || favIconUrl.startsWith('https://'))) {
      const img = document.createElement('img');
      img.src = favIconUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        siteAvatar.classList.remove('has-favicon');
        siteAvatar.textContent = fallbackChar;
      });
      siteAvatar.classList.add('has-favicon');
      siteAvatar.appendChild(img);
    } else {
      siteAvatar.textContent = fallbackChar;
    }
  }

  async function refreshAll() {
    const websites = await getWebsites();
    matchedRule = currentTabSyncable ? findMatchingSite(currentDomain, websites) : null;

    renderHeroState();
    renderSitesList(websites);
    await loadStatus();
  }

  function renderHeroState() {
    if (!currentTabSyncable) {
      heroCard.classList.remove('is-synced');
      siteSwitch.disabled = true;
      siteSwitch.setAttribute('aria-checked', 'false');
      syncBtn.disabled = true;
      return;
    }

    const active = Boolean(matchedRule);
    heroCard.classList.toggle('is-synced', active);
    siteSwitch.disabled = false;
    siteSwitch.setAttribute('aria-checked', active ? 'true' : 'false');
    syncBtn.disabled = false;
  }

  async function handleToggleSite() {
    if (!currentTabSyncable) return;

    const websites = await getWebsites();
    if (matchedRule) {
      const removedSite = matchedRule;
      const next = websites.filter((w) => w !== removedSite);
      await saveWebsites(next);
      await refreshAll();
      showSnackbar(`Removed ${removedSite}`, async () => {
        const latest = await getWebsites();
        if (!latest.includes(removedSite)) {
          latest.push(removedSite);
          await saveWebsites(latest);
          await refreshAll();
        }
      });
    } else {
      if (!websites.includes(currentDomain)) {
        websites.push(currentDomain);
      }
      await saveWebsites(websites);
      await refreshAll();
    }
  }

  function renderSitesList(websites) {
    sitesCountEl.textContent = String(websites.length);

    if (websites.length === 0) {
      sitesListEl.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon" aria-hidden="true">${EMPTY_ICON}</div>
          <div class="empty-copy">
            <span class="empty-title">No sites synced yet</span>
            <span class="empty-body">Turn on the site switch to sync cookies and storage to incognito</span>
          </div>
        </div>
      `;
      return;
    }

    sitesListEl.innerHTML = '';
    for (const site of websites) {
      const isCurrentMatch = site === matchedRule;

      const row = document.createElement('div');
      row.className = `segmented-item${isCurrentMatch ? ' is-active' : ''}`;

      const leading = document.createElement('div');
      leading.className = 'item-leading';

      const monogram = document.createElement('span');
      monogram.className = 'item-monogram';
      monogram.setAttribute('aria-hidden', 'true');
      monogram.textContent = site.charAt(0).toUpperCase();

      const label = document.createElement('span');
      label.className = 'item-name';
      label.textContent = site;
      label.title = site;

      leading.append(monogram, label);

      if (isCurrentMatch) {
        const activeTag = document.createElement('span');
        activeTag.className = 'item-badge';
        activeTag.textContent = 'Current';
        leading.appendChild(activeTag);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn-remove';
      removeBtn.setAttribute('aria-label', `Remove ${site}`);
      removeBtn.title = `Remove ${site}`;
      removeBtn.innerHTML = CLOSE_ICON;

      removeBtn.addEventListener('click', async () => {
        const latest = await getWebsites();
        const next = latest.filter((w) => w !== site);
        await saveWebsites(next);
        await refreshAll();
        showSnackbar(`Removed ${site}`, async () => {
          const current = await getWebsites();
          if (!current.includes(site)) {
            current.push(site);
            await saveWebsites(current);
            await refreshAll();
          }
        });
      });

      row.append(leading, removeBtn);
      sitesListEl.append(row);
    }
  }

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'get_sync_status',
        domain: currentDomain,
        origin: currentOrigin || null
      });
      if (!resp?.success) return;

      const s = resp.data;

      incognitoPill.classList.toggle('active', Boolean(s.hasIncognito));
      incognitoText.textContent = s.hasIncognito ? 'Incognito on' : 'Incognito off';

      if (!currentTabSyncable) {
        cookieCountEl.textContent = '—';
        storageCountEl.textContent = '—';
        return;
      }

      cookieCountEl.textContent = String(s.cookieCount || 0);
      storageCountEl.textContent = String(s.localStorageCount || 0);

      if (!s.isConfigured) {
        siteStatusEl.textContent = 'Sync off for this site';
      } else if (s.matchedSite && s.matchedSite !== currentDomain) {
        siteStatusEl.textContent = `Covered by ${s.matchedSite}`;
      } else if (s.hasIncognito && s.isWarmed && s.lastSyncTime) {
        siteStatusEl.textContent = `Pre-warmed ${timeAgo(s.lastSyncTime)}`;
      } else if (s.hasIncognito) {
        siteStatusEl.textContent = 'Ready in incognito';
      } else {
        siteStatusEl.textContent = 'Will pre-warm when incognito opens';
      }
    } catch {
      // Service worker may still be starting
    }
  }

  async function handleManualSync() {
    if (!currentTabSyncable) return;

    syncBtn.disabled = true;
    syncBtn.classList.add('syncing');
    syncLabelEl.textContent = 'Syncing…';

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'manual_sync_request',
        domain: currentDomain
      });

      if (!resp?.success) {
        showSnackbar(`Sync failed: ${resp?.error || 'unknown error'}`);
      } else if (!resp.data?.hasIncognito) {
        showSnackbar('Open an incognito window to sync');
      } else {
        const { cookiesSynced, localStorageSynced } = resp.data;
        showSnackbar(
          `Synced ${cookiesSynced} cookies and ${localStorageSynced} storage items`
        );
      }
      await loadStatus();
    } catch (e) {
      showSnackbar(`Sync failed: ${e.message}`);
    } finally {
      syncBtn.disabled = false;
      syncBtn.classList.remove('syncing');
      syncLabelEl.textContent = 'Sync';
    }
  }

  async function getWebsites() {
    const r = await chrome.storage.sync.get([WEBSITES_KEY]);
    const list = Array.isArray(r[WEBSITES_KEY]) ? r[WEBSITES_KEY] : [];
    return Array.from(new Set(list.map(normalizeHost).filter(Boolean)));
  }

  async function saveWebsites(websites) {
    await chrome.storage.sync.set({ [WEBSITES_KEY]: websites });
    try {
      await chrome.runtime.sendMessage({ type: 'websites_updated', websites });
    } catch {
      // Service worker will still pick up chrome.storage.onChanged
    }
  }

  function timeAgo(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  function showSnackbar(message, onUndo = null) {
    snackbarTextEl.textContent = message;
    snackbarUndoHandler = onUndo;
    snackbarActionEl.hidden = !onUndo;
    snackbarEl.classList.add('show');

    if (snackbarTimer) clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(hideSnackbar, onUndo ? 4500 : 2800);
  }

  function hideSnackbar() {
    snackbarEl.classList.remove('show');
    snackbarUndoHandler = null;
    if (snackbarTimer) {
      clearTimeout(snackbarTimer);
      snackbarTimer = null;
    }
  }
});
