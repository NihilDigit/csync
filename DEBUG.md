# Csync 调试指南

## 1. 打开Chrome开发者工具

### 方法一：扩展页面调试
1. 打开 `chrome://extensions/`
2. 找到Csync扩展，点击"检查视图"按钮
3. 会打开多个调试窗口：
   - **Service Worker**：调试background.js
   - **Popup**：调试popup界面

### 方法二：页面调试
1. 在任意页面按F12打开开发者工具
2. 切换到"Console"标签
3. 可以查看content.js的输出

## 2. 查看错误信息

### Service Worker错误
- 在 `chrome://extensions/` 页面
- 如果扩展图标变红，说明有错误
- 点击"错误"按钮查看详细错误信息

### Console输出
- 在各个调试窗口的Console标签查看日志
- 检查是否有红色错误信息

## 3. 添加调试代码

让我先添加一些调试代码来帮助定位问题：