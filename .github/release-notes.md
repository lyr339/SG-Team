## v0.2.1 修复

- 修复未启动团队仍可点击“结束运行”而被后端拒绝的问题。
- 团队切换至独立配置时，明确提示可直接创建新批次，无需先结束未启动运行。
- 操作在途时阻止重复点击和冲突操作，失败后恢复可重试状态。
- 保留既有会话数据与数据库结构；Windows 安装及真实会话运行仍需实机验收。

## 安装

**macOS（Apple Silicon）**：下载 `ShiGuang-<版本>-mac-arm64.zip`，解压，把 `拾光.app` 拖进「应用程序」，然后在「终端」执行一次：

```
xattr -dr com.apple.quarantine /Applications/拾光.app && open -a 拾光
```

拾光没有经过 Apple 公证，首次打开会被 Gatekeeper 拦下；上面这一行把下载时带上的隔离标记去掉即可。不想用终端的话，双击一次、选「完成」，再到「系统设置 → 隐私与安全性」底部点「仍要打开」。

**Windows（x64）**：下载 `ShiGuang-Setup-<版本>.exe` 运行；SmartScreen 提示时点「更多信息 → 仍要运行」。Windows 版尚未在真实机器上完整验证过，遇到问题请把界面提示或日志原样反馈。

## 使用前提

- Cursor **3.6.31**（拾光按这个版本的内部结构实现，别的版本可能对不上）。装好拾光后先到「设置 → Cursor 维护」点「关闭 Cursor 自动更新」把版本钉住。
- 第一次「一键建会话」时按界面提示点「重启 Cursor 并启用会话创建」（一次性，让 Cursor 带调试端口启动）。
- Cursor 里允许 MCP 工具自动运行——持续会话依赖 Agent 不停调用拾光的工具，逐次确认会让席位停摆。
- 拾光启动时会自动把「SG Team」MCP 服务器写进 `~/.cursor/mcp.json`，不需要手动安装；app 位置固定后不要再移动，移动了就重新打开一次让它重写路径。

## 升级

覆盖安装即可；数据在 `~/Library/Application Support/sg-team/`（Windows：`%APPDATA%\sg-team`），不受影响。
