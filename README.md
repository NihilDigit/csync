# Csync

Sync cookies and localStorage from normal window to incognito window, stay logged in while browsing privately.

将 Cookie 和 localStorage 从普通窗口同步到无痕窗口，保持登录状态的同时不留浏览记录。

## Features

- Auto sync cookies and localStorage to incognito window
- Configurable website whitelist
- Subdomain matching support
- First-visit detection (only syncs once per session)
- Manual sync via right-click menu

## Install

### From Release

1. Download the latest `.zip` from [Releases](https://github.com/NihilDigit/csync/releases)
2. Unzip to a folder
3. Open `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the folder

### From Source

```bash
git clone https://github.com/NihilDigit/csync.git
```
Then load the folder in Chrome as above.

## Usage

1. Click the extension icon, add websites you want to sync (e.g. `example.com`)
2. **Keep the website open in a normal window** (logged in)
3. Open the same website in an incognito window
4. Cookies and localStorage will sync automatically, page reloads once

### Manual Sync

- Right-click on page → "同步当前网站 Cookie 和 localStorage 到无痕窗口"
- Or in page console: `Csync.manualSync()`

### Debug

In Service Worker console:
```javascript
CsyncDebug.showCache()           // View cached data
CsyncDebug.getStatus('example.com')  // Check sync status
CsyncDebug.forceSync('example.com')  // Force sync
```

## How It Works

1. Caches cookies from normal window on startup
2. When incognito tab opens a configured site:
   - Checks if already synced (compares cookie count)
   - If not synced: copies cookies via Chrome API, sends localStorage via message to content script
   - Reloads the tab once
3. Subsequent tabs skip sync (already have cookies)

## Permissions

- `cookies` - Read/write cookies
- `tabs` - Detect incognito tabs
- `storage` - Save website list
- `<all_urls>` - Access all sites for localStorage sync

## License

MIT
