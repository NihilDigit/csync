# Csync

Sync cookies and localStorage from normal windows to incognito, so you stay logged in while browsing privately.

## Features

- Auto-syncs cookies and localStorage when you open a configured site in incognito
- Configurable website whitelist — only syncs sites you explicitly add
- Subdomain matching (e.g. adding `example.com` covers `www.example.com`)
- Smart first-visit detection — only syncs once per incognito session, skips if already done
- Manual sync via right-click context menu
- MV3 service worker compatible — uses `chrome.alarms` for reliable background processing

## Install

### From Release

1. Download the latest `.zip` from [Releases](https://github.com/NihilDigit/csync/releases)
2. Unzip to a folder
3. Open `chrome://extensions/`
4. Enable "Developer mode" (top right toggle)
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

1. Open an incognito window and navigate to the same site
2. Csync automatically syncs cookies and localStorage from the normal window
3. The page reloads once after the first sync — you should now be logged in
4. Subsequent visits in the same incognito session skip the sync (already done)

### Manual Sync

If you need to force a re-sync (e.g. after re-logging in the normal window):

- Click the Csync icon → "Sync" button
- Or right-click on the page → "Sync cookies & localStorage to incognito"

### Important Notes

- The normal window tab for the site **must stay open** — localStorage can only be read from a live tab
- Cookie changes in the normal window are automatically detected and synced to incognito (with a few seconds debounce)
- Adding `example.com` also covers `www.example.com`, `app.example.com`, etc.

## How It Works

1. On startup, caches cookies for all configured sites from the normal cookie store
2. When an incognito tab navigates to a configured site:
   - Compares cookie counts to detect if sync is needed
   - Copies cookies to the incognito cookie store via `chrome.cookies` API
   - Sends localStorage data to the incognito tab via content script messaging
   - Reloads the tab once so the site picks up the new state
3. Monitors `chrome.cookies.onChanged` with debounced batching to keep incognito in sync with ongoing cookie changes

## Permissions

| Permission | Why |
|---|---|
| `cookies` | Read cookies from normal window, write them to incognito |
| `tabs` | Detect incognito tabs and find matching normal tabs for localStorage |
| `storage` | Persist the website whitelist and cookie cache |
| `alarms` | Reliable debounce timing in MV3 service workers |
| `<all_urls>` | Content script access for localStorage sync on any configured site |

## License

MIT
