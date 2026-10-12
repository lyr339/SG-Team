<div align="center">
  <img src="build/icon-shiguang-1024.png" width="80" height="80" alt="拾光图标" />
  <h1>拾光 · SG Team</h1>
  <p>Cursor 多 Agent 协作工作台。</p>
  <p><a href="https://github.com/lyr339/SG-Team/releases/latest">下载最新版</a> · <a href="https://github.com/lyr339/SG-Team/releases">更新记录</a> · <a href="https://github.com/lyr339/SG-Team/issues">反馈问题</a></p>
</div>

拾光是一款独立桌面应用，把 Cursor 的会话、执行过程和团队协作集中到一个界面。它不是 Cursor 插件，也不是 Cursor 官方产品。

## 核心功能

- **多会话管理**：创建会话、配置模型，查看运行状态、消息队列与上下文占用。
- **Agent 协作**：将已有会话组成团队，分配角色与任务，通过协作图查看消息往来。
- **过程与审查**：实时查看工具调用和代码差异，完成后收起过程；支持上下文交接。
- **统一工作台**：集中查看通知、用量与账号配置，支持明暗主题和可调侧栏。

## 下载与安装

从 [最新 Release](https://github.com/lyr339/SG-Team/releases/latest) 下载对应安装包，无需安装 Node.js。

| 系统 | 安装方式 |
| --- | --- |
| macOS · Apple Silicon | 下载 ZIP，解压后将「拾光.app」放入「应用程序」 |
| Windows · x64 | 下载 EXE，运行安装程序，可选择安装目录 |

当前适配 **Cursor 3.6.31、3.21.12**，自动识别版本；其他版本不保证兼容。

macOS 包未做 Apple 公证，首次打开可能出现安全提示。详细说明见 [使用指南](docs/USER-GUIDE.md)。

已安装的用户可在 **账号与 Cursor → 软件更新** 中升级。

## 三步上手

1. **准备项目**：打开 Cursor 项目并登录，在拾光顶栏核对工作区。
2. **创建会话**：进入「运行」，选好模型与参数，先创建一个会话并完成接入。
3. **开始协作**：在「会话」发送任务；需要分工时，再把已有会话组成协作组。

会话依赖 Cursor 账号权限与模型可用性，拾光不会增加额度。账号自动化为可选功能，启用前请阅读使用指南中的操作边界。

## 文档

- [使用指南](docs/USER-GUIDE.md)：详细安装、会话状态、账号自动化与常见问题。
- [开发指南](docs/DEVELOPMENT.md)：源码运行、验证、打包发布及技术文档索引。

## 问题反馈

请在 [Issues](https://github.com/lyr339/SG-Team/issues) 附上软件版本、系统、Cursor 版本和复现步骤。
截图或日志请遮盖 Token、密码、卡密及个人信息。
