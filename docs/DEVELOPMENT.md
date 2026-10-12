# 开发指南

[返回首页](../README.md) · [使用指南](USER-GUIDE.md)

## 从源码运行

开发环境需要 **Node.js 24+**。以下命令在仓库根目录执行：

```bash
npm ci
node node_modules/electron/install.js
npm run dev
```

第二条命令用于确保 Electron 本地运行时就绪，避免安装脚本未执行造成启动失败。

## 验证与打包

```bash
npm test                 # 单元与集成回归，包含独立 wire 测试
npm run lint:dead        # 死代码检查
npm run build            # 类型检查、主程序与 MCP 构建
npm run smoke:channel    # 使用构建产物验证通道 MCP

npm run dist:mac         # macOS arm64 ZIP，在 macOS 上执行
npm run pack:win         # Windows x64 安装包，在 Windows 上执行
```

产物位于 `release/`。本地打包前请退出正在使用同一构建目录的拾光，避免原地改写运行中的应用文件。

## 界面预览

```bash
npm run preview:ui
# 打开 http://localhost:5174/preview.html
```

预览使用模拟数据与桌面 API，不代表真实账号、Cursor 连接或业务执行结果。

## 发布流程

1. 同步更新 `package.json`、锁文件中的版本号与 `.github/release-notes.md`。
2. 推送对应的 `v<版本>` 标签，触发 Release 工作流。
3. macOS 验证并打包后，Windows 接续验证、打包并统一发布安装包与应用内更新清单。任何一步失败都不发布。

发版只运行 **macOS、Windows** 两个检查，不单列发布作业。日常 PR 另跑 CI，主分支发布提交不再重复跑一套验证。无需手动上传散落的构建文件。

流程定义：[Release](../.github/workflows/release.yml) · [PR 验证](../.github/workflows/ci.yml)。

## 技术文档索引

| 文档 | 内容 |
| --- | --- |
| [架构](ARCHITECTURE.md) | 进程边界、数据流与核心约束 |
| [MCP 工具契约](TASK-MCP.md) | 会话通信、任务与团队工具 |
| [界面结构](UI-STRUCTURE.md) | 页面组织与交互约定 |
| [设计系统](DESIGN-SYSTEM.md) · [主题系统](THEME-SYSTEM.md) | 视觉规范、配色与控件规则 |
| [通知系统](NOTIFICATIONS-DESIGN.md) | 提醒、历史记录与读回语义 |
| [协议研究](CURSOR-PROTOCOL.md) | 已有证据、实验范围与限制 |

历史实现记录保存在 [架构日志](ARCHITECTURE-LOG.md)，不作为当前功能清单或首次使用指南。

## 仓库与维护入口

- `src/`：运行代码；`packages/cursor-wire-runtime/`：独立协议运行依赖。
- `build/`：打包图标。设计源保留在 `docs/design/sg-monogram/`；生成 SVG 后用 `npm run icons` 生成栅格资源。
- `tests/` 与 `scripts/fixtures/`：隔离回归；`scripts/verify-*`：专项与打包验收，不是应用启动步骤。
- `scripts/app-shot.mjs`、`scripts/preview-shots.mjs`：开发截图；`scripts/prepare-notification-native-acceptance.mjs`：显式运行的隔离系统通知验收准备器。
- `scripts/patch-cursor-usage-hook.ts`、`scripts/unpatch-cursor.ts`：用量适配与旧补丁维护工具，不是普通安装步骤。

当前后续项见 [维护清单](OPTIMIZATION-BACKLOG.md)。早期交接目录与一次性诊断材料不再随主线维护，可从 [v0.5.28](https://github.com/lyr339/SG-Team/tree/v0.5.28) 或 Git 历史追溯。

`npm run lint:dead` 同时检查整个工程与生产入口：前者覆盖测试和工具，后者防止「只有测试还在引用」的退役实现逃过检查。预览、内存测试仓储和独立 Worker/维护入口按实际用途声明，不按文件年龄判断去留。

注意：`knip.json` 中带 `!` 的渲染入口供 production 模式使用。普通模式可从 Vite 自动发现它而提示重复，但不能据此删除，否则生产扫描会漏掉入口并误报整个前端。
