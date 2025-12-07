# Csync - Chrome Extension

Csync是一个Chrome扩展程序，用于在指定网站将Cookie从主窗口同步到无痕窗口，让你既能保持登录状态又不会留下浏览记录。

## 功能特性

- 🔄 自动同步Cookie到无痕窗口
- 📋 可配置需要同步的网站列表
- 🚀 支持子域名匹配
- 🔒 安全的Cookie传输
- 📱 简洁易用的界面

## 安装方法

1. 下载或克隆此项目到本地
2. 打开Chrome浏览器，进入 `chrome://extensions/`
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目文件夹

## 使用方法

### 1. 配置网站列表
- 点击扩展图标打开popup界面
- 在输入框中输入域名（如 `example.com`）
- 点击"添加"按钮
- 支持添加多个网站

### 2. 自动同步
- 在无痕窗口中打开配置的网站
- 扩展会自动检测并同步Cookie
- 支持页面导航时的同步

### 3. 手动同步
- 右键点击页面，选择"同步当前网站Cookie到无痕窗口"
- 或在开发者控制台中执行 `Csync.manualSync()`

## 工作原理

1. **监听标签页创建**：background script监听无痕窗口的标签页创建事件
2. **域名匹配**：检查当前域名是否在配置列表中
3. **Cookie获取**：从主窗口获取指定域名的所有Cookie
4. **Cookie同步**：将Cookie设置到无痕窗口中
5. **状态保持**：无痕窗口中的页面将保持登录状态

## 安全说明

- 只同步非httpOnly的Cookie（出于安全考虑）
- 所有数据存储在本地，不上传到服务器
- 支持子域名匹配，确保Cookie正确同步

## 文件结构

```
csync/
├── manifest.json          # 扩展配置文件
├── background.js          # 后台脚本
├── popup.html            # popup界面
├── popup.js              # popup逻辑
├── content.js            # 内容脚本
├── icons/                # 图标目录
└── README.md             # 说明文档
```

## 注意事项

- 某些网站的安全策略可能会限制Cookie同步
- httpOnly的Cookie无法通过JavaScript同步
- 建议在测试环境中验证同步效果

## 开发说明

如需修改或扩展功能，请参考Chrome Extension API文档：
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Cookies API](https://developer.chrome.com/docs/extensions/reference/cookies/)
- [Tabs API](https://developer.chrome.com/docs/extensions/reference/tabs/)