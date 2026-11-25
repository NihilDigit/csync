# Csync

Sync cookies and localStorage from normal windows to incognito, so you stay logged in while browsing privately.

## Features

- **Instant incognito pre-warming**: copies whitelisted cookies the moment an incognito window opens, so the very first page request carries your login session without waiting or reloading
- **Fast `document_start` localStorage injection**: caches origin-scoped `localStorage` snapshots in memory (`chrome.storage.session`) and injects them before page scripts run
- **Real-time cookie sync**: propagates cookie updates and logouts from normal windows to incognito within sub-second debounce
- **Configurable whitelist**: dynamically registers content scripts only on sites you explicitly add
- **Subdomain support**: adding `example.com` covers `www.example.com`, `app.example.com`, and nested subdomains
- **Manual sync**: force a fresh sync anytime via the popup or right-click context menu

## Install

### From Release

1. Download the latest `.zip` from [Releases](https://github.com/NihilDigit/csync/releases)
2. Unzip to a folder
3. Open `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the unzipped folder

### From Source

```bash
git clone https://github.com/NihilDigit/csync.git
```

Then load the cloned folder in Chrome as above.

## Usage

### Setup

1. Log into the website you want to sync in a **normal** (non-incognito) window
2. Click the Csync extension icon in the toolbar
3. Click "Add to Csync" to add the current site to the whitelist

### Browsing in Incognito

1. Open an incognito window — Csync immediately pre-warms cookies for all configured sites
2. Navigate to any configured site — cookies and `localStorage` are already ready on first load

### Manual Sync

If you need to force a re-sync (for example after switching accounts):

- Click the Csync icon and select **Sync**
- Or right-click on the page and select **Sync cookies and localStorage to incognito**

## How It Works

1. When an incognito window opens (`chrome.windows.onCreated`), Csync immediately copies cookies for all configured sites from the normal cookie store into the incognito store in parallel
2. Normal-window tabs on whitelisted sites keep their origin `localStorage` snapshot warm in memory (`chrome.storage.session`), which incognito tabs read directly at `document_start` before page scripts execute
3. For cold-start "Open link in incognito window" navigations, Csync intercepts during the early `loading` stage rather than waiting for full page completion
4. `chrome.cookies.onChanged` mirrors cookie updates and removals to open incognito stores using fast in-memory debouncing with an MV3 `chrome.alarms` sleep fallback

## Permissions

| Permission | Why |
|---|---|
| `cookies` | Read cookies from normal windows and write or remove them in incognito |
| `tabs` | Detect incognito navigations and locate matching normal tabs |
| `storage` | Persist the website whitelist in `storage.sync` and keep transient session snapshots in memory (`storage.session`) |
| `scripting` | Dynamically register content scripts only for whitelisted sites and capture `localStorage` from already-open tabs |
| `contextMenus` | Provide the right-click manual sync action |
| `notifications` | Report manual sync outcomes triggered from the context menu |
| `alarms` | Reliable MV3 service worker fallback timer for debounced cookie sync |
| `<all_urls>` | Read and write cookies and `localStorage` for any site you add to the whitelist |

## Development & Tests

```bash
bun test
```

## License

MIT
