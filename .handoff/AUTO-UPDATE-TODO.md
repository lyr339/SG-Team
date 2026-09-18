# 交接任务书：拾光自动更新（Windows 先行 · electron-updater · 手动组件；mac 自替换待做）

> **状态（2026-09-18 15:29）：Windows 路线已随 v0.3.3 发布；mac 自替换路线（§4–§7）09-17 合回 main（`0d73eec`）并随 v0.3.4 发布**（Release 带 `latest.yml` 与 `update-manifest.json`，见 §12 末行）。
> 真机验收两项仍待：**Windows 应用内升级 §0.6.4**——现在有真实目标，装 0.3.3 检查应看到 0.3.4；**mac §11**（支持矩阵 → 检查 → 下载校验 → 替换 → 回滚，待 mac 在手）。
> typecheck / knip / 全量测试 / build / smoke:channel 全绿。每完成一步在 §12 追加一行；中断后接手者只读 §0、§12、§13 即可定位。
>
> **2026-09-16 用户重新拍板**（在真实 Windows 机器上，覆盖 09-15 的 U2 / U3）：① **Windows 先行**；② **允许引入 `electron-updater`**（运行时依赖从 ws + zod 扩到三项）；
> ③ 按机安装带来的 **UAC 弹窗可接受**；④ **手动组件**——用户使用中不得被打断，只允许一个不打扰的小提醒告知有新版本，下载与安装都由用户显式点击。
>
> 原始来源：CH-1 09-15 14:31–14:55 的可行性分析（当时拍板：不花钱、先做 mac、先出任务书）+ CH-4 对发布链、运行方式与 GitHub 端点的实测（§0.3）。
> 09-16 CH-2 在真机上补齐 Windows 事实（§0.5）并落地 Windows 路线（§0.6）。
>
> 项目：拾光 / SG Team（`shiguang-team` 0.3.2）· 仓库 `lyr339/SG-Team`（09-15 文中的 `SG-Team-for-Mac` 是旧名，GitHub 会重定向，新代码一律用新名）。
> Windows 上 `E:` 是 exFAT，建不了软链 / junction：worktree 的 `node_modules` 是从主仓 robocopy 的完整副本。**主工作树的未提交文件属其他 Agent——不要碰**（§9.2 列了会碰面的文件）。
>
> 命名提醒：仓库里已有 `domain/cursor-update.ts` / `register-cursor-update-ipc.ts` / 设置页「Cursor 维护」——那是**关闭 Cursor 自身自动更新**的开关，
> 与本任务无关。本任务一律叫 **`app-update`（拾光自更新）**，不要混用。

***

## 0. 接手人先读

### 0.1 一句话

让拾光自己知道 GitHub Releases 上有没有新版本、把新版本告诉用户并让用户选择是否更新；mac 上在**不买 Apple 开发者证书**的前提下，
点一下就能下载、校验、备份、替换 `.app` 并重启，失败自动回滚——同时不打断 Cursor 里正在跑的 SG Team 会话。

### 0.2 已拍板的决策（不要再讨论）

| # | 决策 | 结论 |
|---|---|---|
| U1 | 是否购买 Apple Developer Program（99 美元/年）走 Squirrel.Mac 标准路 | **否**。mac 走「路线 B：自己替换」（§7） |
| U2 | 平台顺序 | ~~mac 先做~~ → **09-16 改为 Windows 先做**（真机在手；§0.6）；mac 自替换随后 |
| U3 | 交付顺序 | ~~任务书 → 阶段 0 → 阶段 1（mac）~~ → **09-16 改为**：Windows 全链（检查 + 提醒 + 下载 + 安装，`electron-updater`）一次落地 → 真机验收 → mac 路线 B |
| U4 | 更新源 | GitHub Releases（仓库 `lyr339/SG-Team`）；国内镜像留接口（Windows：设置页「自定义更新源」= electron-updater `generic` 目录；mac：清单 URL 可覆盖），暂不搭镜像 |
| U5 | Windows 用 `electron-updater` 还是零依赖自研 rename-swap | **`electron-updater`**（09-16）。代价：新增运行时依赖 + 安装器会杀掉 Cursor 托管的 MCP 进程（§0.5-5）；收益：差分下载、注册表 / 快捷方式 / 卸载项由安装器维护、成熟度 |
| U6 | 按机安装的 UAC 弹窗 | **接受**（09-16）。发布说明建议新装机选「仅当前用户」 |
| U7 | 席位在线时是否允许安装 | **确认后继续**（`confirm` 门禁，文案写清 5 秒瞬断）；一键建会话在途 → `block` |
| U8 | 组件性质 | **手动组件**（09-16）：只静默检查；发现新版 = 右下角小提醒框（15 秒自动收起，每版每次运行一次）+ 齿轮 / 导航角标；不自动下载、不在退出时静默安装、不弹模态框 |

### 0.3 实测事实（2026-09-15，决定设计的硬约束）

1. **mac 包是 adhoc 签名**：`codesign -dv` 显示 `Signature=adhoc`、`TeamIdentifier=not set`（`scripts/dist-mac.mjs` 用 `codesign --sign -` 重签）。
   Squirrel.Mac / `electron-updater`(mac) 要求新旧包满足同一 designated requirement，adhoc 的 DR 是每次构建都不同的 `cdhash`，**永远通不过**。这是 U1 的技术根因。
2. **Cursor 握着拾光的二进制在跑 MCP**：`~/.cursor/mcp.json` 的「SG Team」条目 `command = process.execPath`（拾光启动时由
   `infrastructure/cursor/global-mcp-registrar.ts` 幂等写入），`env.ELECTRON_RUN_AS_NODE=1`，`args = Contents/Resources/mcp/index.mjs`。
   本机此刻就有 1 个这样的进程（统一服务器只起一个）从 `release/mac-arm64/拾光.app` 跑着。替换 `.app` 不能原地覆盖文件，只能整包 `mv` 交换（inode 不变，旧进程照常运行）。
3. **mcp.json 内容变化会让 Cursor 重载 MCP 服务器**（`global-mcp-registrar.ts:90-91` 注释记录的既有观察）；内容不变则不重载。
   更新后新包路径不变 → mcp.json 不变 → Cursor 里跑的仍是旧版 MCP。要主动制造一次变化（§7.4）。
4. **GitHub 匿名 REST API 限额 60 次/小时/IP，本机此刻 `x-ratelimit-remaining: 0`**（`api.github.com/repos/…/releases/latest` 返回空体）。
   而**网页重定向端点不计限额、当场可用**：
   - `https://github.com/lyr339/SG-Team-for-Mac/releases/latest` → `302 Location: …/releases/tag/v0.2.1`（拿最新 tag）
   - `https://github.com/lyr339/SG-Team-for-Mac/releases/latest/download/<资产名>` → `302` → `…/releases/download/v0.2.1/<资产名>` → `302` → `release-assets.githubusercontent.com/…?se=<1 小时后过期>&sig=…` → `200`
   → 检查与下载**全部走重定向端点 + 一个静态清单资产**，不碰 REST API（§4）。
5. 现有发布链：`release.yml` 在 mac runner 上 `npm run dist:mac` 产出 `ShiGuang-<version>-mac-arm64.zip`（v0.2.1 实测 133,376,930 字节；解压后的 `.app` 299 MB，约 2.3 倍），
   Windows runner 产出 `ShiGuang-Setup-<version>.exe`；`publish` job 用 `gh release create <tag> artifacts/* --notes-file .github/release-notes.md`。
   tag 强制等于 `v<package.json.version>`。**没有任何清单 / 哈希文件**。
6. `.app` 的 Info.plist **没有 `LSFileQuarantineEnabled`**：拾光自己用 Node/`net` 写到磁盘的文件不会带 `com.apple.quarantine`；
   Chromium 下载管理器（`session.downloadURL` / `will-download`）在 mac 上**会**给下载文件打隔离标记——不要用它下载。
7. 所有 SQLite 仓储对「库版本高于代码」**一律抛错**（`sqlite-task-pool-repository.ts:510`、`sqlite-team-control-repository.ts:2273`、
   team-collaboration / team-memory / team-continuity 同样）。新版本迁移过库后，**旧版本打不开这个库**。回滚必须连库一起回（§7.5）。
8. `/Applications` 对当前用户可写；`/Applications` 与 `~/Library/Application Support` 在同一 APFS 卷（`/System/Volumes/Data`），`rename(2)` 是原子操作。
   本机目前**没有** `/Applications/拾光.app`——用户自己是从 `release/mac-arm64/` 直接运行的（§5.2 的「构建目录」位置类型，阶段 1 对它只做阶段 0 行为）。
9. 用户手工升级留下过一套流程（`release/local-upgrade-<ts>/{backup,staging}`）：备份了 `拾光.app`、`task-pool.sqlite3(+wal/shm)`、`mcp.json`、`settings/`。自动化按同样的清单备份（§7.2）。
10. 运行时：Electron 43.4.1（内置 Node 24.18.1），`net.fetch` / `app.relaunch({ execPath, args })` / `fs.statfs` / `Readable.fromWeb` / `node:sqlite` 均可用。
11. 数据目录 `~/Library/Application Support/sg-team/`（`main/user-data-directory.ts`；开发态 `sg-team-dev`），库文件 `task-pool.sqlite3`（约 90 MB）。

### 0.4 实施纪律

1. **分层照旧**：`domain/`（版本比较、清单模型、状态机、门禁、位置判定——纯函数）→ `application/`（`AppUpdateService`、设置存储）→
   `infrastructure/`（GitHub 拉取、mac 替换器 / 辅助脚本、SQLite 备份）→ `main/register-app-update-ipc.ts` → `preload` → `renderer/settings/SettingsUpdate.tsx`。
   渲染层仍是纯快照消费者：所有状态由主进程推送，渲染层只发意图。
2. **更新状态不进 `DesktopSnapshot`**：新增独立推送通道 `app-update:event` + 拉取 `app-update:get-state`，不碰 `register-session-ipc.ts` / `snapshot-push.ts` 的版本剔重机制。
3. **每个非平凡决策写进 `docs/ARCHITECTURE.md`**（症状 → 根因 → 修法 → 未做 → 验证），并更新其「Distribution boundary」一节。
4. **事件序列级测试**（沿用 `.handoff/HANDOFF.md` §8）：状态机每条边、辅助脚本每个失败分支都要有用例；生成的 shell 脚本要在临时目录里**真的跑一遍**（stub 掉 `open` / `codesign` / `xattr`）。
5. **对共享文件只做最小触碰**（§9.2）：`main/index.ts` 一处 import + 一处装配 + 一处 dispose；`desktop-api.ts` 一组 IPC 键 + 一组方法；`preload/index.ts` 一组转发。今天 groups / process-image 合回 main 时正是靠这一点让 `checkout -m` 三方合并全部自动通过。
6. **绝不在席位在线时静默替换**：门禁（§5.4）默认拦住，用户显式确认后才继续，并把后果写在确认框里。
7. 全部网络失败静默（只写 `[app-update]` stderr 日志），绝不弹错误框——国内访问 GitHub 失败是常态不是异常。
8. 提交前 `npm run typecheck && npm run lint:dead && npm test && npm run build && npm run smoke:channel`（与 `ci.yml` 一致）。

### 0.5 Windows 实测事实（2026-09-16，CH-2 在真机 `D:\SG-Team\ShiGuang` 上补齐）

1. **已装包自带更新源**：`resources/app-update.yml` 内容为 `provider: github, owner: lyr339, repo: SG-Team`（electron-builder 从 git remote 推断；`build.publish` 现已显式写入以免漂移）。
2. **差分缓存目录**：`%LOCALAPPDATA%\shiguang-team-updater\installer.exe` 是 NSIS 自拷贝，供 electron-updater 做 blockmap 差分下载；`updaterCacheDirName` 必须与 `package.json` `build` 一致。
3. **发布链缺口（已修）**：`pack:win` 本地已产出 `latest.yml` + `*.exe.blockmap`，但 v0.3.2 的 `release.yml` 只上传 `.exe`——Release 上没有更新 feed；`release.yml` 现已一并上传 `latest.yml` 与 `.blockmap`。
4. **安装器读注册表**：`HKLM\Software\<guid>\InstallLocation` 记录自定义目录与 `/allusers` 模式；`--updated` 模式（安装器装完拉起新版）沿用同一目录与模式；per-machine 安装会弹一次 UAC（U6 已接受）。
5. **进程终止语义**：electron-builder NSIS 的 `_CHECK_APP_RUNNING` 用 `Get-CimInstance Win32_Process | ? Path.StartsWith($INSTDIR)` 按**安装目录前缀**杀进程，无提示；Cursor 托管的 MCP 是同一个 `ShiGuang.exe … index.mjs`，安装必然打断每个在线席位一次（Agent 端按瞬断续接 5 秒重试）。
6. **Windows 文件锁**：运行中的 exe 及其父目录可 `rename`，不可 `delete` / 覆盖（用复制的 `node.exe` 探过）——保留日后零依赖 rename-swap 备选；本期走 electron-updater + NSIS。
7. **electron-updater 检查源**：GitHub provider 读 `releases.atom` + `releases/download/<tag>/latest.yml`，**不碰** REST API（§0.3-4 的 60/h 限额与此无关）。
8. **ESM 导入陷阱**：`import { autoUpdater } from 'electron-updater'` 在 ESM 链接期失败（`autoUpdater` 是 CJS `module.exports` 上的 lazy getter）；主进程必须用 `import electronUpdater from 'electron-updater'` 再取 `.autoUpdater`。

### 0.6 Windows 路线已落地（2026-09-16，分支 `feat/app-auto-update`）

**代码落点**（与 §9.1  mac 清单路线不同——Windows 走 electron-updater，无 `update-manifest.mjs`）：

| 层 | 文件 | 职责 |
|---|---|---|
| domain | `src/domain/app-update.ts` | 版本比较、设置归一化、状态机、提醒判定、安装门禁 |
| application | `app-update-service.ts` / `app-update-settings-store.ts` | 定时检查、check/download/cancel/install/skip/snooze、userData 持久化 |
| infrastructure | `infrastructure/app-update/electron-updater-port.ts` | win32 + packaged 才支持；`autoDownload=false`、`autoInstallOnAppQuit=false` |
| main | `register-app-update-ipc.ts` + `main/index.ts` 装配 | `app-update:*` IPC + `app-update:status` 推送 |
| renderer | `SettingsUpdate` / `UpdateReminder` / `update-view.ts` / `update.css` | 设置页第 8 组「软件更新」+ 右下角小提醒 + 齿轮角标 |
| 共享 | `global-mcp-registrar` 写 `SG_TEAM_APP_VERSION` | 升级后首次启动改写 mcp.json → Cursor 重载 MCP |
| CI | `release.yml` 上传 `latest.yml` + `.blockmap`；`package.json` `build.publish` | 更新 feed 不再依赖 remote 推断 |

**行为摘要**（U8 手动组件）：启动 45 s 后静默检查，之后每 6 h（可关 / 改 12 / 24 h）；有新版 → 右下角小提醒（15 s 自动收起，每版每运行一次）+ 设置齿轮 / 导航角标；不自动下载、不静默安装、不弹模态框；下载 / 安装只在 设置 › 软件更新 里点；安装前门禁：`sessionLaunchRunning` → block，席位在线 → confirm（文案写清约 5 秒瞬断）；`quitAndInstall(true, true)` 静默安装并拉起；`--updated`  argv 触发一次「已更新到 x」提示。

#### 0.6.4 真机验收（待用户）

1. 先发一个带 `latest.yml` + `.blockmap` 的 tag（≥ 0.3.3）；从已装的 0.3.2 **不能**应用内升到该版——发布说明须写明「首版带更新能力，请手动装一次 0.3.3+」。
2. 装 0.3.3+ 后：等 45 s 或点「立即检查」→ 发布更高 tag → 小提醒出现 → 下载 → 安装 → 确认门禁 → 拾光退出 → 新版拉起 → 「已更新到 x」→ `mcp.json` 的 `SG_TEAM_APP_VERSION` 变化 → Cursor 重载 SG Team（在线席位瞬断后 5 s 续接）。
3. 负面：检查失败无弹窗；一键建会话在途时安装按钮 block；per-machine UAC 出现一次可接受。

**验证（代码侧，2026-09-16）**：typecheck、knip、198/199 测试文件全绿（`brand-migration` 在 Node 22 因 vitest 无法 bundle `node:sqlite` 失败——CI Node 24 无此问题）、build、smoke:channel；新增 8 个测试文件 + 预览截图矩阵 `?update=<phase>`。

### 0.7 明确排除

- mac 自替换（§4–§7、§11 设计不变，待做）；mac 面板本期只链发布页。
- 后台静默安装；强制更新（`minimumVersion` 字段预留，本期不强制）。
- 国内镜像源的搭建（Windows 只留设置页 `feedUrl` → `generic` 目录；mac 留清单 URL 覆盖项）。
- 更新期间保住 Cursor 长轮询不中断——MCP 重载是 Cursor 行为，Agent 端协议已当瞬断处理（5 秒重试），本期只做「先提示、后重载」。

***

## 1. 现状盘点：与设计相关的每一个事实

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 版本号 `0.2.1`，`package.json` 打进 asar，`app.getVersion()` 可读 | `package.json` `files` | 本地版本来源唯一 |
| tag 必须等于 `v<version>` | `release.yml` mac job 第一步 | 清单里 `tag = "v" + version` 可推导 |
| mac 产物 `ShiGuang-<version>-mac-arm64.zip`（ditto 保留符号链接） | `scripts/dist-mac.mjs` | 客户端解压必须用 `ditto -x -k`，不能用 `unzip` / 第三方库 |
| win 产物 `ShiGuang-Setup-<version>.exe`，`executableName: ShiGuang` | `package.json` `build.nsis` | NSIS 安装前会杀 `ShiGuang.exe`——Cursor 起的 MCP 进程同名，见 §14 |
| Release 说明来自 `.github/release-notes.md`（每版手改） | `release.yml` publish | 清单里带 `notesMarkdown`，弹窗直接展示 |
| Windows 打包失败不阻塞发 mac 版 | `release.yml` publish `if:` | 清单里 `assets.win-x64` 可缺省 |
| MCP 条目 `command = process.execPath`，只在内容变化时重写 + 备份 | `global-mcp-registrar.ts:74-127` | §7.4 用 `SG_TEAM_APP_VERSION` 制造一次变化 |
| MCP 服务器路径 `Contents/Resources/mcp/index.mjs`（asar 外） | `main/task-mcp-runtime.ts` | 旧 MCP 进程已把整包 `index.mjs` 加载进内存，`mv` 走旧包不影响它 |
| 单实例锁 | `main/index.ts:154` | 辅助脚本 `open` 新版前旧实例必须已退出（`app.relaunch` 保证） |
| 设置页分组静态表 `GROUPS` + `SettingsGroupId` 联合类型 | `settings/SettingsPage.tsx:21-38` | 新增分组只改这两处 + 新组件文件 |
| 设置项存储惯例：`userData/<name>.json`，`{ version: 1, settings }`，临时文件 + `rename` 原子写，0o600 | `application/cursor-cdp-settings-store.ts` | `AppUpdateSettingsStore` 照抄 |
| IPC 惯例：`ipcMain.handle` + `assertTrustedSender` + 返回 dispose；键名 `'<模块>:<动作>'` | `main/register-cdp-keeper-ipc.ts`、`main/ipc-security.ts` | `register-app-update-ipc.ts` 照抄 |
| 渲染层经 `window.sgDesktop`（`SgDesktopApi`）调用；推送通道用 `ipcRenderer.on` | `preload/index.ts:179`、`renderer/src/env.d.ts` | 新组件自取 `window.sgDesktop`，不经 `App.tsx` 传 props |
| 会话在线判定：`desktopSessionService.getSnapshot().sessions[].online`；一键建会话在途：`isSessionLaunchRunning()` | `application/desktop-session-service.ts`、`register-team-group-ipc.ts:56` | 门禁输入（§5.4） |
| README / 发布说明写着「app 位置固定后不要再移动」 | `.github/release-notes.md` | 替换保持同一路径，mcp.json 路径不失效 |
| 「Distribution boundary」声明签名 / 公证是以后的事 | `docs/ARCHITECTURE.md:99-101` | 本任务落地后补一段「Self-update boundary」 |

***

## 2. 目标行为（用户视角）

### 阶段 0 · 知道有新版（mac / win 通用，本期只在 mac 验收）

1. 启动后约 45 秒静默检查一次；之后每 6 小时一次；设置页「软件更新」有「立即检查」。
2. 有新版：设置页导航项出现角标；「软件更新」面板显示 `当前 0.2.1 → 最新 0.2.2`、发布时间、发布说明、包大小；按钮：**下载**、**跳过此版本**、**稍后**（24 小时内不再提示）。
3. 「下载」：应用内下载到 `~/Downloads/ShiGuang-<version>-mac-arm64.zip`，进度条，完成后校验 sha512，然后「在 Finder 中显示」+ 一行替换说明（解压 → 拖进「应用程序」替换 → 重新打开）。
4. 任何网络失败：面板显示「上次检查失败（<时间>），可稍后重试或打开发布页」，绝不弹窗；「打开发布页」= `shell.openExternal('https://github.com/lyr339/SG-Team-for-Mac/releases/latest')`。
5. 面板常驻信息：当前版本、安装位置（`/Applications/拾光.app` / 构建目录 / 已被系统隔离运行）、数据目录、上次检查时间。

### 阶段 1 · mac 一键更新与回滚

6. 位置合法时（§7.1）「下载」变成「下载并安装」：下载 → 校验 → 解压到暂存区 → 验签 → 备份（app + 库 + 配置）→ 门禁确认 → 退出并替换 → 新版自动打开。
7. 新版首次启动：顶部提示「已更新到 0.2.2」；MCP 条目随之重写，Cursor 自动重载 SG Team（若 30 秒内没重载，提示「在 Cursor 的 MCP 设置里刷新一次 SG Team」）。
8. 面板出现「回滚到 0.2.1」（备份存在时）：把旧 app 与旧库换回来，当前库另存一份不丢。
9. 替换任一步失败：辅助脚本自动把旧 app 放回原位，下次启动提示「更新失败，已恢复 0.2.1：<原因>」，日志在 `updates/apply.log`。

***

## 3. 方案取舍与否决理由

| 方案 | 结论 | 理由 |
|---|---|---|
| Electron `autoUpdater`（Squirrel.Mac）/ `electron-updater` mac 目标 | **否决** | 需要有效签名且新旧包 DR 一致；adhoc 不满足（§0.3-1）。U1 已排除买证书 |
| GitHub REST API `releases/latest` 作检查源 | **否决** | 匿名限额 60/h/IP，本机实测已耗尽；返回体还会随 API 演进变化 |
| 直接解析 `releases/latest` 的 302 Location 拿 tag | **仅作退化路径** | 无限额、可靠，但拿不到哈希 / 大小 / 说明 |
| 静态清单 `update-manifest.json` 作 Release 资产，客户端走 `releases/latest/download/update-manifest.json` | **采纳** | 不计限额；格式自控；可镜像；一处写 sha512 / 大小 / 说明 / 最低版本 |
| `session.downloadURL` 下载 | **否决** | Chromium 会打隔离标记；进度事件也更绕 |
| `net.fetch` 流式写盘 + 边写边算 sha512 | **采纳** | 走系统代理（国内挂代理即可用）；无隔离标记；Electron 43 原生支持 |
| 解压后原地覆盖 `.app` 内文件 | **否决** | Cursor 的 MCP 进程握着二进制，覆盖可能崩（§0.3-2） |
| 整包 `mv` 交换（旧 → 备份目录，新 → 原路径） | **采纳** | 同卷原子；旧进程照常；路径不变 mcp.json 不失效 |
| 主进程自己做替换 | **否决** | 主进程退出前不能替换自己（单实例锁、库句柄）；必须由外部进程在退出后完成 |
| `app.relaunch({ execPath: '/bin/sh', args: [脚本] })` + `app.exit()` | **采纳（优先）** | Electron 的 relauncher 等当前进程退出后再执行 execPath；脚本仍带一段有界 PID 等待兜底。若实机不符预期，退化为 `spawn(detached)` + 脚本内轮询 `kill -0` |
| 只备份 app 不备份库 | **否决** | 旧版本打不开新库（§0.3-7），回滚会变成启动崩溃 |
| 把更新状态并进 `DesktopSnapshot` | **否决** | 快照推送有版本剔重机制，改动面大且与在途工作重叠；独立通道足够 |

***

## 4. 更新源：清单与发布链改动

### 4.1 清单 `update-manifest.json`（schema v1，Release 资产）

```json
{
  "schemaVersion": 1,
  "version": "0.2.2",
  "tag": "v0.2.2",
  "publishedAt": "2026-09-16T02:10:00Z",
  "minimumVersion": "0.2.0",
  "notesMarkdown": "## v0.2.2 修复\n- …",
  "assets": {
    "mac-arm64": {
      "name": "ShiGuang-0.2.2-mac-arm64.zip",
      "url": "https://github.com/lyr339/SG-Team-for-Mac/releases/download/v0.2.2/ShiGuang-0.2.2-mac-arm64.zip",
      "size": 133376930,
      "sha512": "<hex>"
    },
    "win-x64": {
      "name": "ShiGuang-Setup-0.2.2.exe",
      "url": "https://github.com/lyr339/SG-Team-for-Mac/releases/download/v0.2.2/ShiGuang-Setup-0.2.2.exe",
      "size": 0,
      "sha512": "<hex>"
    }
  }
}
```

- `assets` 的键是 `platform-arch`（`process.platform === 'darwin' && process.arch === 'arm64'` → `mac-arm64`）；缺键 = 该平台本版没有产物。
- `url` 写死为 `releases/download/<tag>/<name>`（不是 `latest/download`），保证清单与产物同版；客户端下载时仍会经历 302 到 `release-assets.githubusercontent.com`，签名 URL 约 1 小时过期——**断点续传时重新从 `url` 解析**，不要缓存最终地址。
- `notesMarkdown` 直接取 `.github/release-notes.md` 全文（当前它每版手改，本身就是发布说明）。
- `minimumVersion` 本期只用于展示「建议尽快更新」，不强制。

### 4.2 `scripts/update-manifest.mjs`（零依赖，node 24）

输入：`--version`、`--tag`、`--notes <path>`、`--assets <dir>`（`artifacts/`）、`--out <path>`。对目录里每个匹配 `ShiGuang-<version>-mac-<arch>.zip` / `ShiGuang-Setup-<version>.exe` 的文件算 `sha512` 与大小，产出 §4.1。
文件名不匹配版本号即报错退出（防止把上一版残留资产写进清单）。测试见 §10。

### 4.3 `release.yml` 改动（`publish` job，mac/win job 不动）

```yaml
      - name: 生成更新清单
        run: |
          node scripts/update-manifest.mjs \
            --version "${GITHUB_REF_NAME#v}" --tag "$GITHUB_REF_NAME" \
            --notes .github/release-notes.md --assets artifacts --out artifacts/update-manifest.json
          cat artifacts/update-manifest.json
```

放在 `download-artifact` 之后、`gh release create/upload` 之前；`artifacts/*` 通配会把清单一起上传。`gh release upload --clobber` 分支同样覆盖清单。
注意上传不是原子的：客户端拿到清单后下载 404 时按「产物暂缺，稍后重试」处理，不报损坏。

### 4.4 客户端检查算法

```text
manifestUrl = settings.manifestUrl ?? 'https://github.com/lyr339/SG-Team-for-Mac/releases/latest/download/update-manifest.json'
GET manifestUrl（net.fetch，redirect: 'follow'，超时 15s，头带 If-None-Match / If-Modified-Since 若有缓存）
  200 → 校验 schema（version 合法、assets 结构、sha512 为 128 位 hex）→ compare(version, app.getVersion())
        > 0 且 ≠ skippedVersion → available；≤ 0 → up_to_date
  304 → 沿用上次结果
  404 → 退化：GET 'https://github.com/lyr339/SG-Team-for-Mac/releases/latest'（redirect: 'manual'）读 Location 末段 tag
        → 版本更高 → available_without_manifest（只能「打开发布页」，不能应用内下载）
  其他 / 网络错误 / 超时 → check_failed（静默，记录时间与原因）
```

不把 `api.github.com` 写进任何路径。`manifestUrl` 覆盖项即未来的国内镜像接口（把清单和 zip 同步到任意静态托管即可）。

***

## 5. 领域模型与状态机（`src/domain/app-update.ts`，全部纯函数）

### 5.1 类型

```ts
export interface AppVersion { major: number; minor: number; patch: number; prerelease?: string }
export function parseAppVersion(text: string): AppVersion | undefined   // 接受 'v0.2.1' / '0.2.1' / '0.3.0-beta.1'
export function compareAppVersions(a: AppVersion, b: AppVersion): -1 | 0 | 1  // 有 prerelease 的低于同号正式版

export type UpdatePlatformKey = 'mac-arm64' | 'mac-x64' | 'win-x64'
export interface UpdateManifestAsset { name: string; url: string; size: number; sha512: string }
export interface UpdateManifest { schemaVersion: 1; version: string; tag: string; publishedAt: string; minimumVersion?: string; notesMarkdown?: string; assets: Partial<Record<UpdatePlatformKey, UpdateManifestAsset>> }
export function parseUpdateManifest(raw: unknown): UpdateManifest | { error: string }

export type InstallLocationKind = 'applications' | 'user-folder' | 'build-output' | 'translocated' | 'unknown'
export interface InstallLocation { kind: InstallLocationKind; bundlePath: string; writable: boolean }
export function classifyInstallLocation(input: { execPath: string; platform: NodeJS.Platform; homeDir: string; writable: boolean }): InstallLocation

export interface AppUpdateSettings { autoCheck: boolean; checkIntervalHours: number; skippedVersion?: string; snoozedUntil?: number; manifestUrl?: string }
export const DEFAULT_APP_UPDATE_SETTINGS = { autoCheck: true, checkIntervalHours: 6 }
export function normalizeAppUpdateSettings(raw: unknown): AppUpdateSettings

export type AppUpdateState =
  | { phase: 'idle'; lastCheckedAt?: number; lastError?: string }
  | { phase: 'checking' }
  | { phase: 'up_to_date'; checkedAt: number }
  | { phase: 'available'; manifest: UpdateManifest; asset?: UpdateManifestAsset; checkedAt: number }
  | { phase: 'available_without_manifest'; version: string; releaseUrl: string; checkedAt: number }
  | { phase: 'downloading'; version: string; receivedBytes: number; totalBytes: number }
  | { phase: 'verifying'; version: string }
  | { phase: 'downloaded'; version: string; filePath: string }                      // 阶段 0 终态：已在 ~/Downloads
  | { phase: 'staged'; version: string; stagedBundlePath: string; backupPlan: BackupPlan }  // 阶段 1：已解压验签，待确认
  | { phase: 'applying'; version: string }
  | { phase: 'failed'; step: 'check' | 'download' | 'verify' | 'stage' | 'backup' | 'apply'; message: string; at: number }
```

### 5.2 位置判定规则（`classifyInstallLocation`）

| 条件（按顺序） | kind | 阶段 1 允许自替换？ |
|---|---|---|
| `execPath` 含 `/AppTranslocation/` | `translocated` | 否——路径是系统临时挂载，替换无意义；提示「把拾光拖进应用程序后再更新」 |
| bundle 路径含 `/release/mac-` 或 `/out/`（electron-builder 输出、开发运行） | `build-output` | 否——那是构建目录，下次 `pack:mac` 会重写；只做阶段 0 行为 |
| bundle 在 `/Applications/` 或 `~/Applications/` 下 | `applications` | 是 |
| 其他任意可写目录（如 `~/Downloads/拾光.app` 直接运行） | `user-folder` | 是（同样保持路径不变） |
| 非 darwin / 解析失败 | `unknown` | 否 |

bundle 路径 = `execPath` 去掉末尾 `/Contents/MacOS/<name>`；不满足此形状 → `unknown`。

### 5.3 状态机（每条边一个用例）

```text
idle ──check──▶ checking ──manifest ok, newer──▶ available ──download──▶ downloading ──done──▶ verifying
   ▲               │ ──manifest ok, not newer / skipped──▶ up_to_date          │ cancel        │ sha512 ✗ → failed(verify)，删文件
   │               │ ──404──▶ available_without_manifest                       ▼               ▼ sha512 ✓
   │               └──error──▶ idle(lastError)                                available    阶段0: downloaded ／ 阶段1: stage → staged
   │                                                                                            │ apply（门禁通过或用户确认）
   └──────────────────────────── failed(*) ──retry / dismiss ──────────────────────────────── applying → 进程退出
```

- `skip(version)`：写 `skippedVersion`，回 `up_to_date`；同版不再提示，直到出现更高版本。
- `snooze()`：`snoozedUntil = now + 24h`，自动检查在此前不推送 `available` 事件（手动检查不受限）。
- 任何阶段的 `settings.save` 不改变当前 phase。
- 单飞：`checking / downloading / applying` 期间拒绝重入（返回当前 state，不抛错）。

### 5.4 门禁（`evaluateUpdateGate`）

```ts
export interface UpdateGateInput { onlineSeats: number; sessionLaunchRunning: boolean; location: InstallLocation; freeBytes: number; requiredBytes: number }
export type UpdateGate =
  | { verdict: 'allow' }
  | { verdict: 'confirm'; reasons: string[] }   // 席位在线：可确认后继续
  | { verdict: 'block'; reasons: string[] }     // 位置非法 / 建会话在途 / 磁盘不足：不可继续
```

- `onlineSeats > 0` → `confirm`，文案：「有 N 个席位在线。替换后 Cursor 会重载 SG Team 服务器，各会话会经历一次约 5 秒的瞬断并自动续接；进行中的团队运行不会丢数据。」
- `sessionLaunchRunning` → `block`：「一键会话创建正在进行」。
- `location.kind ∉ {applications, user-folder}` 或 `!writable` → `block`（各自文案见 §5.2）。
- `freeBytes < requiredBytes`（= zip 大小 + 解压后大小（约 2.3 × zip，v0.2.1 为 299 MB）+ 库备份（约 90 MB）+ 200 MB 余量）→ `block`：「磁盘可用空间不足」。

门禁输入由 `main/index.ts` 注入：`onlineSeats = desktopSessionService.getSnapshot().sessions.filter(s => s.online).length`，
`sessionLaunchRunning = isSessionLaunchRunning()`（与 `registerTeamGroupIpc` 用的同一个函数），`freeBytes` 用 `fs.statfs(bundle 所在卷)`。

***

## 6. 服务层与主进程接线

### 6.1 `application/app-update-service.ts` · `AppUpdateService`

构造：`(deps: { currentVersion, platformKey, location: () => InstallLocation, settings: AppUpdateSettingsStore, feed: UpdateFeed, downloader: UpdateDownloader, replacer?: MacAppReplacer, backup?: UpdateBackup, gateInput: () => UpdateGateInput, clock, log })`。
公开方法（全部返回最新 `AppUpdateState`）：`getState()`、`check({ manual })`、`download()`、`cancel()`、`stage()`、`apply({ confirmed })`、`rollback({ confirmed })`、`skipCurrent()`、`snooze()`、`dismissFailure()`。
事件：`onChange(listener)`，每次 state 变化推一次（下载进度按 ≥ 1% 或 ≥ 500 ms 节流）。
定时：`start()` 启动 45 s 后首检 + `checkIntervalHours` 周期；`stop()` 清定时器；`autoCheck=false` 时只手动。
首启检查：`start()` 时读 `updates/pending-result.json`（§7.3 辅助脚本写），存在则先发 `applied` / `rolled_back` / `apply_failed` 事件供渲染层提示，然后删除。

### 6.2 `application/app-update-settings-store.ts`

`userData/app-update.json`，`{ version: 1, settings: AppUpdateSettings, runtime: { lastCheckedAt?, lastError?, etag?, lastModified? } }`，原子写，照抄 `SeatRotationSettingsStore`。

### 6.3 `infrastructure/app-update/github-release-feed.ts` · `UpdateFeed`

- `fetchManifest(url, cache)`：`net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: 条件请求头 })`；返回 `{ kind: 'manifest', manifest, etag?, lastModified? } | { kind: 'not_modified' } | { kind: 'not_found' } | { kind: 'error', message }`。
- `resolveLatestTag()`：`net.fetch('https://github.com/lyr339/SG-Team-for-Mac/releases/latest', { redirect: 'manual' })` → 读 `location` 头末段。
- 只接受 `https:`；跟随重定向时最终主机不做白名单（GitHub 的 CDN 主机名会变，本次实测已从 `objects.githubusercontent.com` 变成 `release-assets.githubusercontent.com`）。

### 6.4 `infrastructure/app-update/update-downloader.ts` · `UpdateDownloader`

- 目标目录：阶段 0 → `~/Downloads`；阶段 1 → `userData/updates/downloads/`。先写 `<name>.part`，完成且 sha512 匹配后 `rename` 为 `<name>`；不匹配 → 删 `.part`，返回 `verify` 失败。
- `Readable.fromWeb(response.body)` 管道到 `createWriteStream` 与 `createHash('sha512')`；`content-length` 缺失时进度只报已收字节。
- 重试：网络中断最多 3 次，每次重新从清单 `url` 解析（§4.1 签名 URL 过期）；若服务器接受 `Range`（`accept-ranges: bytes`）则续传，否则从零。
- `AbortController` 支持取消；取消删 `.part`。
- 下载前 `statfs` 检查磁盘。

### 6.5 `infrastructure/app-update/mac-app-replacer.ts` · `MacAppReplacer`（阶段 1，§7）

`stage(zipPath, version)` → 解压验签，返回 `stagedBundlePath`；`buildApplyScript(plan)` → 生成 shell 文本；`apply(plan)` → 写脚本、`app.relaunch({ execPath: '/bin/sh', args: [scriptPath] })`、`app.exit(0)`；`buildRollbackScript(plan)` 同理。
脚本生成与执行分离，生成是纯函数（可测）。

### 6.6 `infrastructure/app-update/update-backup.ts` · `UpdateBackup`

`plan(version)` → `BackupPlan { dir: userData/updates/backup/<oldVersion>-<ts>/, bundle, database, files[] }`；`runPreQuit(plan)`：`VACUUM INTO` 库副本（用独立 `DatabaseSync` 连接，目标文件不得已存在）、复制 `mcp.json` 与 userData 根下的 `*.json`、写 `backup.json`（旧版本、时间、库各仓储 schema 版本）。app 本体的 `mv` 由辅助脚本做（主进程活着时不能动自己的包）。
保留策略：只留最近一份备份；新备份成功后删除更早的。

### 6.7 `main/register-app-update-ipc.ts`

| IPC 键 | 方向 | 语义 |
|---|---|---|
| `app-update:get-state` | invoke | `service.getState()` + `{ currentVersion, location, dataDirectory }` |
| `app-update:check` | invoke | 手动检查 |
| `app-update:download` / `app-update:cancel` | invoke | 下载 / 取消 |
| `app-update:apply` `{ confirmed }` | invoke | 阶段 1：stage（若未 stage）→ 门禁 → 备份 → 退出替换 |
| `app-update:rollback` `{ confirmed }` | invoke | 阶段 1 |
| `app-update:skip` / `app-update:snooze` / `app-update:dismiss-failure` | invoke | 见 §5.3 |
| `app-update:open-release-page` | invoke | `shell.openExternal(releaseUrl)` |
| `app-update:reveal-download` | invoke | `shell.showItemInFolder(filePath)` |
| `app-update:get-settings` / `app-update:save-settings` | invoke | 设置读写（保存后按新周期重排定时器） |
| `app-update:event` | 主进程 → 渲染层推送 | 每次 state 变化 |

全部 `assertTrustedSender`；返回 dispose；`main/index.ts` 在 `before-quit` 里调用 `service.stop()` 与 dispose（照现有列表追加两行）。
`SgDesktopApi` 新增对应方法与 `onAppUpdateEvent(listener): () => void`。

### 6.8 `global-mcp-registrar.ts` 加一项 env（§7.4 的关键一步）

`desired` 条目的 `env` 增加 `SG_TEAM_APP_VERSION: input.appVersion`（`main/index.ts` 传 `app.getVersion()`）。版本变化 → 条目变化 → mcp.json 重写并备份 → Cursor 重载。
`src/mcp/index.ts` 不读它（无行为影响）；`tests/global-mcp-registrar.test.ts` 补「版本变化即 changed、版本相同不重写、`SG_TEAM_KEEPALIVE_MS` 仍保留」。
**这是本任务里唯一会影响所有用户每次升级体验的改动**：升级后首次启动必然触发一次 MCP 重载——这正是要的效果（新 MCP 代码上线）。

***

## 7. macOS 自替换（阶段 1 核心）

### 7.1 `stage` 前置检查（任一不满足 → `failed(stage)`，不动任何东西）

1. `location.kind ∈ {applications, user-folder}` 且 bundle 父目录可写（`fs.accessSync(parent, W_OK)`）。
2. 磁盘：`statfs` 可用空间 ≥ zip + 2.3 × zip + 库大小 + 200 MB（§5.4 同一公式）。
3. `ditto -x -k <zip> <userData>/updates/staging/<version>/` → 得到 `…/拾光.app`（ditto 保留符号链接与权限；不用 `unzip`）。
4. `plutil -extract CFBundleShortVersionString raw <staged>/Contents/Info.plist` 必须等于清单 `version`；`CFBundleIdentifier` 必须等于 `app.shiguang.team`。
5. `codesign --verify --deep --strict <staged>`（dist-mac 已 adhoc 重签，应通过）；顺手 `xattr -dr com.apple.quarantine <staged>`（预期本来就没有，防御用）。
6. `<staged>/Contents/Resources/mcp/index.mjs` 与 `Contents/MacOS/拾光` 存在且可执行。

### 7.2 `apply` 前的备份（主进程内完成，失败 → `failed(backup)`，不退出）

按 §6.6：`VACUUM INTO` 库副本 → 复制 `~/.cursor/mcp.json`、userData 根 `*.json`（`cursor-accounts.json`、`account-automation.json`、`aozai-card.json`、`browser-profiles.json`、`cursor-cdp.json`、`app-update.json` 等）→ 写 `backup.json`。
备份目录 `userData/updates/backup/<oldVersion>-<ts>/`，app 本体稍后由脚本 `mv` 进同一目录。

### 7.3 辅助脚本（`/bin/sh`，由 `buildApplyScript` 生成到 `userData/updates/apply-<ts>.sh`）

参数全部在生成时内联（用 `printf %q` 级别的单引号转义；路径含中文与空格是常态：`拾光.app`、`Application Support`）。

```sh
#!/bin/sh
set -u
LOG='<updates>/apply.log'; exec >>"$LOG" 2>&1
echo "[$(date '+%F %T')] apply <old> -> <new> pid=<pid>"
APP='<bundle>'; NEW='<staged>/拾光.app'; BAK='<backupDir>/拾光.app'; RESULT='<updates>/pending-result.json'
fail() { printf '{"status":"apply_failed","from":"<old>","to":"<new>","reason":"%s"}\n' "$1" > "$RESULT"; echo "FAIL: $1"; open "$APP" 2>/dev/null; exit 1; }
# 1. 等旧实例退出（relauncher 已等过；兜底 60 s）
i=0; while kill -0 <pid> 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && fail app_still_running; sleep 0.2; done
# 2. 交换
[ -d "$NEW" ] || fail staged_missing
mv "$APP" "$BAK" || fail move_old_failed
mv "$NEW" "$APP" || { mv "$BAK" "$APP"; fail move_new_failed; }
# 3. 收尾校验；失败即换回
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
codesign --verify --deep --strict "$APP" || { mv "$APP" '<staged>/rejected.app'; mv "$BAK" "$APP"; fail codesign_failed; }
printf '{"status":"applied","from":"<old>","to":"<new>","backupDir":"<backupDir>"}\n' > "$RESULT"
echo "OK"
open "$APP"
```

- 启动方式：`app.relaunch({ execPath: '/bin/sh', args: [scriptPath] })` 然后 `app.exit(0)`。Electron 的 relauncher 等本进程退出后再执行；脚本第 1 步是兜底。**实机验证项 A**（§11）。
  若验证发现 relauncher 在 mac 上不等待，退化为 `spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()` + 脚本内 PID 轮询（脚本已具备）。
- `mv` 同卷是 `rename(2)`，瞬时；Cursor 起的 MCP 进程继续从 `$BAK` 里的旧二进制运行，不受影响。
- `open "$APP"` 启动新版；单实例锁此时已释放。
- 权限：`/Applications` 对非管理员不可写时，`stage` 前置检查已 `block`；本期不做 `osascript … with administrator privileges` 提权（登记风险 §13）。

### 7.4 新版首次启动

1. `AppUpdateService.start()` 读 `pending-result.json` → 推 `applied` 事件 → 渲染层顶部提示「已更新到 <new>」→ 删文件。
2. `reconcileGlobalChannelServers` 因 `SG_TEAM_APP_VERSION` 变化重写 mcp.json（自动备份旧文件）→ Cursor 重载 SG Team → 各 Agent 会话按协议 5 秒后重试续接。
3. 渲染层若 30 秒内未观测到 presence 重新上线（`sessions[].online` 从 false 翻回 true）且此前有在线席位，提示「在 Cursor 的 MCP 设置里刷新一次 SG Team」。**实机验证项 B**。
4. 清理 `updates/downloads/` 与 `updates/staging/`（保留 `apply.log` 与备份）。
5. 库迁移由各仓储构造时自动完成（v7 → v8 等）；失败即启动失败——此时用户唯一出路是回滚（§7.5），所以备份是硬前置。

### 7.5 回滚（`rollback({ confirmed })`）

- 前提：`backup/<oldVersion>-<ts>/backup.json` 存在且 `拾光.app` 在其中。
- 确认文案：「回滚到 <old>。当前数据库将另存到 `updates/rollback-<ts>/`，并恢复更新前的数据库副本——更新后产生的会话记录与任务在旧版本里不可见。」
- 步骤：主进程先 `VACUUM INTO` 当前库到 `rollback-<ts>/`（不丢数据），然后生成 `rollback` 脚本：等退出 → `mv $APP <staging>/rolled-back.app` → `mv $BAK $APP` → 用备份库覆盖 `task-pool.sqlite3`（先删 `-wal` / `-shm`）→ 写 `pending-result.json {status:'rolled_back'}` → `open`。
- 为什么库必须一起回：§0.3-7——旧代码遇到更高 schema 版本直接抛「数据库版本不兼容」，回滚只换 app 等于让用户启动崩溃。
- 回滚后 `SG_TEAM_APP_VERSION` 再变一次 → Cursor 再重载一次 MCP（回到旧版 MCP），与库一致。

### 7.6 与 Cursor 托管的 MCP 进程

| 时刻 | 桌面端 | Cursor 里的 MCP 进程 | 库 |
|---|---|---|---|
| 替换前 | 旧 | 旧（从原路径起） | 旧 schema |
| 脚本 `mv` 后、新版未启动 | 无 | 旧（二进制已在内存，从备份目录路径继续） | 旧 schema |
| 新版启动、迁移完成 | 新 | 旧——**读新 schema 库**：所有迁移 additive + 默认值（阶段 1 任务书纪律 5），旧代码不读新列；但见下方例外 | 新 schema |
| mcp.json 重写 → Cursor 重载 | 新 | 新（从原路径起新二进制） | 新 schema |

风险点只有第三行「旧 MCP 读新库」。五个仓储里四个只在**打开时**校验版本（team-control `:2273`、collaboration、memory、continuity），运行中的旧进程不受迁移影响；
**例外是任务池**：`sqlite-task-pool-repository.ts:209` 的 `compareAndSwap` 每次写入都校验 `loadState()` 读到的 `task_pool_meta.schema_version === 3`——
若某次发版把任务池 schema 从 3 升到 4，旧 MCP 进程在 Cursor 重载前的几秒到几十秒内所有任务写入会抛「不支持的任务池 schemaVersion」。
本任务不改任何 schema；mcp.json 重写紧跟仓储构造之后（`main/index.ts:323`），窗口只有数秒。将来任何提升任务池 schema 的发版，发布说明须写明「更新后请确认 Cursor 已重载 SG Team」。

***

## 8. 渲染层（新分组「软件更新」）

- `settings/SettingsPage.tsx`：`SettingsGroupId` 加 `'update'`；`GROUPS` 末尾加 `{ id: 'update', label: '软件更新', description: '检查新版本、下载与安装', icon: SettingsUpdateIcon }`；内容区加一行 `<div hidden={group !== 'update'}><SettingsUpdate active={group === 'update'} /></div>`。
  导航项角标：`available` / `downloaded` / `staged` 时显示圆点（复用自动化项的状态圆点样式）。
- `settings/icons.tsx`：加 `SettingsUpdateIcon`（与现有图标同一线宽风格）。
- `settings/SettingsUpdate.tsx`（新）：挂载时 `window.sgDesktop.getAppUpdateState()`，订阅 `onAppUpdateEvent`；自包含，**不经 `App.tsx` 传 props**，不改 `settings-view.ts`。视图纯函数放 `settings/update-view.ts`（新），样式放 `settings/update.css`（新，仿 `stats.css` 的拆分方式）——三个文件都是新增，与在途工作零冲突。
- 面板区块：① 当前版本 / 安装位置 / 数据目录 / 上次检查；② 状态卡（按 `phase` 切文案，见下表）；③ 设置：自动检查开关、检查间隔（6 / 12 / 24 h）、「自定义更新源」（高级，折叠，填清单 URL）。
- 顶部全局提示（`applied` / `rolled_back` / `apply_failed`）：用设置页内横幅即可；`DesktopShell.tsx` 目前是在途文件，全局横幅留到合并后再加（§9.2）。
- 托盘菜单「检查更新…」：可选；`main/index.ts` 的 tray 模板加一项，触发 `service.check({ manual: true })` 并打开设置页 `#account:update`。

| phase | 主文案 | 按钮 |
|---|---|---|
| `idle` / `up_to_date` | 「已是最新版本 0.2.1」/「上次检查 18:32」；有 `lastError` 时附「上次检查失败：<原因>」 | 立即检查 · 打开发布页 |
| `checking` | 「正在检查…」 | — |
| `available` | 「发现新版本 0.2.2（09-16 发布，127 MB）」+ 发布说明（Markdown 按纯文本段落渲染） | 下载（阶段 1 位置合法时为「下载并安装」）· 跳过此版本 · 稍后 |
| `available_without_manifest` | 「发现新版本 0.2.2，此版本未提供应用内下载」 | 打开发布页 · 跳过 · 稍后 |
| `downloading` | 进度条 + 「已下载 48 / 127 MB」 | 取消 |
| `verifying` / `staged`（阶段 1） | 「正在校验…」/「已就绪，点击安装将退出拾光并替换为 0.2.2」+ 门禁提示 | 安装并重启 · 取消 |
| `downloaded`（阶段 0 / 位置不合法） | 「已下载到 ~/Downloads/…，校验通过」+ 三步替换说明 | 在 Finder 中显示 |
| `failed` | 「<步骤>失败：<原因>」 | 重试 · 知道了 |
| 备份存在 | 卡片底部「可回滚到 0.2.1（备份于 09-16 10:12）」 | 回滚… |

***

## 9. 改动落点（文件级）

### 9.1 新增（与任何在途工作零冲突）

```text
src/domain/app-update.ts
src/application/app-update-service.ts
src/application/app-update-settings-store.ts
src/infrastructure/app-update/github-release-feed.ts
src/infrastructure/app-update/update-downloader.ts
src/infrastructure/app-update/mac-app-replacer.ts          （阶段 1）
src/infrastructure/app-update/update-backup.ts             （阶段 1）
src/main/register-app-update-ipc.ts
src/renderer/src/settings/SettingsUpdate.tsx
src/renderer/src/settings/update-view.ts
src/renderer/src/settings/update.css
scripts/update-manifest.mjs
tests/app-update.test.ts · tests/app-update-service.test.ts · tests/github-release-feed.test.ts · tests/update-downloader.test.ts
tests/mac-app-replacer.test.ts · tests/update-backup.test.ts · tests/register-app-update-ipc.test.ts · tests/update-manifest-script.test.ts · tests/settings-update.test.tsx
```

### 9.2 修改（最小触碰；标 ⚠ 的文件此刻在主工作树有其他 Agent 的未提交改动，合回 main 时会三方合并）

| 文件 | 触碰 | 备注 |
|---|---|---|
| ⚠ `src/main/index.ts` | import ×3、装配 `AppUpdateSettingsStore` / `AppUpdateService` / `registerAppUpdateIpc`（紧跟 `registerSessionHandoffIpc` 之后）、`before-quit` 两行、`reconcileGlobalChannelServers` 传 `appVersion` | 各自独立 hunk，避开 tray 以外的区域 |
| ⚠ `src/shared/desktop-api.ts` | `IPC` 加 13 个 invoke 键 + 1 个推送键；`SgDesktopApi` 加对应方法与 `onAppUpdateEvent` | 追加在 `cursorCdp*` 之后 |
| ⚠ `src/preload/index.ts` | 转发 13 个方法 + 一个 `ipcRenderer.on` 订阅 | 追加在 `saveCursorCdpSettings` 之后 |
| `src/infrastructure/cursor/global-mcp-registrar.ts` | `appVersion` 入参 + `SG_TEAM_APP_VERSION` | 干净文件 |
| `src/renderer/src/settings/SettingsPage.tsx`、`icons.tsx` | 加分组、加图标 | 干净文件 |
| `.github/workflows/release.yml` | publish job 加「生成更新清单」步骤 | 干净文件 |
| `docs/ARCHITECTURE.md` | 「Distribution boundary」加一段 + 末尾日期条目 | ⚠ 文件末尾此刻有其他 Agent 未提交的条目；并列即可 |
| `tests/global-mcp-registrar.test.ts` | 补 3 例 | 干净文件 |
| `.github/release-notes.md` | 首个带更新能力的版本要写「从 0.2.1 升级仍需手动替换一次」 | 发版时改 |

**不碰**：`App.tsx`、`DesktopShell.tsx`、`settings-view.ts`、`settings.css`、`SettingsMaintenance.tsx`（全部在途）。

### 9.3 实施顺序（每步全绿后单独提交）

1. **域 + 清单脚本 + CI**：`domain/app-update.ts`、`scripts/update-manifest.mjs`、`release.yml`。此步落地后下一次发版 Release 就会带清单——**阶段 0 客户端依赖它，先发一版带清单的 Release 才能实机验收**（或用 §11 的本地静态服务器）。
2. **阶段 0 服务 + IPC + 设置页**：feed、downloader、settings store、service（不含 stage/apply/rollback）、IPC、preload、`SettingsUpdate`。此步交付「检查 + 提示 + 下载到 Downloads + Finder 显示」。
3. **`SG_TEAM_APP_VERSION`**：registrar + 测试 + ARCHITECTURE 说明（独立小提交，便于单独回退）。
4. **阶段 1**：backup、replacer（stage / apply 脚本 / rollback 脚本）、service 补三条边、门禁接线、设置页补「安装并重启」「回滚」。
5. **实机验收 §11 → §12 记录 → 合回 main**（rebase 到最新 main，`merge-tree` 预检，与今天 groups 的流程相同）。

***

## 10. 测试（事件级；文件名为建议）

- `app-update.test.ts`：版本解析 / 比较矩阵（`v` 前缀、prerelease、非法串）；清单解析（缺 assets、sha512 非 128 hex、schemaVersion ≠ 1 全部拒绝并给出原因）；位置判定 5 种 kind（含 `/private/var/folders/…/AppTranslocation/…`、`…/release/mac-arm64/拾光.app`、`/Applications/拾光.app`、`~/Applications`、`~/Downloads`）；门禁 allow / confirm / block 每条原因；状态机每条边（纯 reducer）。
- `app-update-service.test.ts`（fake feed / downloader / clock / settings dir 用 `mkdtempSync`）：45 s 首检与周期；`autoCheck=false` 不自检；`skippedVersion` 同版不提示、更高版提示；`snoozedUntil` 只压自动不压手动；404 → `available_without_manifest`；网络错误 → `idle.lastError` 且不推 `available`；下载进度节流；sha512 不匹配 → `failed(verify)` 且 `.part` 已删；重入返回当前 state；`pending-result.json` 三种状态各推一次事件并删除文件。
- `github-release-feed.test.ts`：用本地 `http.createServer` 模拟 200 / 304 / 404 / 302 链 / 超时 / 非 JSON；条件请求头透传；`resolveLatestTag` 从 `location` 取 tag。
- `update-downloader.test.ts`：本地服务器给 100 KB 随机体：完整下载 + 哈希；中途断开一次后重试成功；`Range` 续传（服务器支持时）；取消删 `.part`；磁盘检查用注入的 `statfs`。
- `mac-app-replacer.test.ts`：`buildApplyScript` 对含空格 / 中文 / 单引号的路径正确转义（对生成文本 `sh -n` 语法检查）；**在临时目录真跑脚本**：PATH 前置 stub 的 `open` / `codesign` / `xattr`（记录调用参数），构造假 bundle 目录 → 正常路径：新在原位、旧在备份、`pending-result.json` 为 `applied`、`open` 被调一次；`codesign` stub 返回非零 → 旧包换回、结果 `apply_failed:codesign_failed`；`NEW` 不存在 → `staged_missing`；PID 不退出 → 超时分支（PID 用一个 `sleep` 子进程，超时阈值注入缩短）。`buildRollbackScript` 同样两条路径。
- `update-backup.test.ts`：对临时 SQLite（含 WAL 模式、几行数据）`VACUUM INTO` 后副本可独立打开且行数一致；目标已存在时报错不覆盖；`backup.json` 内容；只保留最近一份。
- `register-app-update-ipc.test.ts`：照 `register-cursor-storage-ipc.test.ts` 的 `vi.mock('electron')` 模式：每个键路由到服务方法、`assertTrustedSender` 被调、dispose 撤销全部处理器、推送在 `onChange` 时调用 `webContents.send`。
- `update-manifest-script.test.ts`：临时 `artifacts/` 放 3 个文件（正确 mac zip、正确 win exe、上一版残留 zip）→ 清单只含前两个且 sha512 / size 正确；版本名不匹配时残留文件被忽略；无 mac 产物时退出非零。
- `global-mcp-registrar.test.ts`：补版本 env 三例（§6.8）。
- `settings-update.test.tsx`：`renderToStaticMarkup` 每个 phase 的文案与按钮集合（§8 表）；位置为 `build-output` 时按钮是「下载」而非「下载并安装」；`confirm` 门禁文案含在线席位数。

***

## 11. 实机验收脚本（mac；沿用「一个空闲会话 + 只读观测」的方法）

前置：`npm run typecheck && npm run lint:dead && npm test && npm run build && npm run smoke:channel` 全绿。

**A. 阶段 0（用本地静态服务器，不依赖发新版）**
1. `npm run dist:mac` 得到 `release/ShiGuang-0.2.1-mac-arm64.zip`；用 `scripts/update-manifest.mjs --version 9.9.9 --tag v9.9.9 …` 生成一份假清单（`version` 手改为 `9.9.9`，`url` 指向 `http://127.0.0.1:8765/ShiGuang-0.2.1-mac-arm64.zip`），`python3 -m http.server 8765` 托管。
2. 在拾光「软件更新」把「自定义更新源」设为 `http://127.0.0.1:8765/update-manifest.json` → 立即检查 → 出现 9.9.9 → 下载 → 进度 → 校验通过 → 「在 Finder 中显示」定位到 `~/Downloads`。
3. 把清单 sha512 改错一位 → 重新下载 → 「校验失败」且 `~/Downloads` 里没有残留 `.part`。
4. 关掉静态服务器 → 立即检查 → 面板显示「上次检查失败」，**没有任何弹窗**；stderr 有 `[app-update]` 一行。
5. 从 `release/mac-arm64/` 运行时面板显示位置为「构建目录」，按钮是「下载」；把 `.app` 复制到 `/Applications` 后运行显示「应用程序」。

**B. 阶段 1（旧 → 新 → 回滚；全程另开一个 Cursor 独立会话在线，观察它的瞬断与续接）**
1. 把当前包复制到 `/Applications/拾光.app`，退出 `release/` 里的那份，启动 `/Applications` 这份（mcp.json 会被重写指向它；Cursor 重载一次——这是既有行为，顺带验证 §0.3-3）。
2. 本地把 `package.json` 版本改 `0.2.2-test.1`，`npm run pack:mac` 到副本目录（`electron-builder … --config.directories.output=/tmp/sg-next`）后 `node scripts/dist-mac.mjs /tmp/sg-next/mac-arm64/拾光.app /tmp/sg-next`；生成对应清单并本地托管。
3. 拾光里：检查 → 「下载并安装」→ 下载 → 就绪 → 门禁应为 `confirm`（有 1 个席位在线）→ 确认 → 拾光退出 → 数秒后新版自动打开，顶部「已更新到 0.2.2-test.1」。
   核对：`/Applications/拾光.app/Contents/Info.plist` 版本 = 新；`updates/backup/0.2.1-<ts>/` 内有 `拾光.app`、`task-pool.sqlite3`、`mcp.json`、`backup.json`；`~/.cursor/mcp.json` 的 `SG_TEAM_APP_VERSION` = 新且旁边多了一个 `.sg-team-backup-*`；`apply.log` 末行 `OK`。
   **验证项 A**：`relauncher` 是否等待退出（`apply.log` 第 1 步循环次数应为 0 或很小）。
   **验证项 B**：Cursor 是否在 mcp.json 重写后重载 SG Team（那个在线会话的 `check_messages` 报一次 transport closed 后 5 秒续接；`pgrep -fl 'Resources/mcp/index.mjs'` 的进程启动时间刷新，路径仍是 `/Applications/…`）。
4. 库：在新版里发一条用户消息给那个会话 → 落库。然后「回滚到 0.2.1」→ 确认 → 旧版打开，顶部「已回滚到 0.2.1」；`updates/rollback-<ts>/task-pool.sqlite3` 存在（含刚那条消息）；旧版正常打开库（无「版本不兼容」）。
5. 负面：把暂存的新包 `Contents/MacOS/拾光` 改一个字节再 `apply`（或让 stub 失败）→ `apply.log` 有 `codesign_failed`，`/Applications` 里仍是旧版且能启动，面板「更新失败，已恢复」。
6. 隔离运行：把 zip 里的 `.app` 解压到 `~/Downloads` 并用 `xattr -w com.apple.quarantine …` 加标记后双击运行 → 面板位置显示「已被系统隔离运行」，「下载并安装」不出现。

**C. 发布链**：推一个 `v0.2.2` tag（真实发版时）→ Release 资产里有 `update-manifest.json`，`curl -sIL https://github.com/lyr339/SG-Team-for-Mac/releases/latest/download/update-manifest.json` 最终 200，内容 sha512 与 zip 实算一致。

***

## 12. 进度日志（每完成一步追加，最新在下）

| 日期 | 步骤 | 内容 | 验证 |
|---|---|---|---|
| 09-15 14:31–14:55 | 可行性 | （CH-1）盘点打包 / CI / 签名 / MCP 接入；结论：检查层零风险，mac 全自动被 adhoc 签名卡住，两条路线；用户拍板不买证书、mac 先行 | — |
| 09-15 18:20–18:38 | 任务书 | （CH-4 接 CH-1）实测 GitHub 端点（REST 限额已耗尽、重定向端点可用、资产 133 MB）、adhoc 签名、mcp.json 重写即重载、库版本严格相等、Info.plist 无隔离标记、同卷；写成本文 | 全程只读 |
| 09-16 全天 | 重拍板 | 用户在真 Windows 上拍板：Windows 先行、允许 `electron-updater`、UAC 可接受、手动组件（只小提醒，使用中不打断） | 用户消息 |
| 09-16 下午–晚 | Windows 全链 | domain / service / port / IPC / 渲染层（SettingsUpdate + UpdateReminder）/ `SG_TEAM_APP_VERSION` / `release.yml` + `build.publish` / 测试 + 预览截图 | typecheck · knip · 1970 tests · build · smoke:channel |
| 09-16 晚 | 文档 | `docs/ARCHITECTURE.md` Self-update boundary + 日期条目；`docs/TASK-MCP.md` env；本文 §0.5–§0.7 · §12 | 与代码同步 |
| 09-16 21:10–21:40 | 接手复核 + 提交 | （CH-1 接 CH-2 中断处）复跑五步验证全绿；读代码发现一处缺陷并修：`SettingsUpdate` 用 `download` IPC 的 promise 占住 `busyAction`，而该 IPC 直到下载结束才返回 → 整个下载期间「取消下载」不可点。改为下载不占 busy、进度与终态由推送驱动；补一条「下载 IPC 挂起时取消仍可点」的用例（改前失败、改后通过）。提交到 `feat/app-auto-update` 并 rebase 到 main 最新（仅 `docs/ARCHITECTURE.md` 尾部追加冲突，两边保留） | typecheck · knip · 1972 tests（rebase 后含 main 新用例）· build · smoke:channel |
| 09-16 21:27 | 合回 + 发版 | 用户拍板「先合、可先发版、不影响当前使用」：`main` fast-forward 到 `92f05c4`；版本 0.3.2 → 0.3.3，发布说明补「界面」与「移除轮换」两条；`57bf8cd` + tag `v0.3.3` 推到 `lyr339/SG-Team`。Release 工作流 mac / windows / publish 三步全绿（约 2.5 分钟）；Release 资产 4 个：`ShiGuang-Setup-0.3.3.exe`（117,596,850 B）、`.exe.blockmap`、`latest.yml`（version 0.3.3、path 与 size 与 exe 一致、sha512、releaseDate）、mac zip。**这是第一个带更新 feed 的版本；本机仍是 0.3.2，未安装** | GitHub API + `releases/download/v0.3.3/latest.yml` 实取 |
| — | 真机验收 | §0.6.4：发带 feed 的 tag → 应用内升一级 → 观察 MCP 重载。**不发版也能验**：`pack:win` 打两个本地版本（0.3.3 / 0.3.4），装 0.3.3，把 `release/` 用本机静态 HTTP 服务起来，在 设置 › 软件更新 › 自定义更新源 填该目录 URL → 检查 → 下载 → 安装；安装会杀掉 Cursor 托管的 MCP（在线席位瞬断） | **待用户** |
| 09-16 23:00–09-17 00:10 | mac 路线 B 全链 | （CH-7，两段会话接力）§4–§7 全部落地，分支 `feat/app-update-mac`：`domain/app-update-manifest.ts`（清单 schema 解析、安装位置判定、磁盘估算）＋ 状态机扩展（`downloading.activity` transfer/verify、`rolling_back` 相位、`downloadable=false`、`applyResult`/`backupInfo` 类型与解析）；`github-manifest-feed.ts`（清单源；404 退化到 `releases/latest` 302 取 tag）、`update-downloader.ts`（流式 sha512 边写边算、断线重试、取消删 `.part`）、`update-backup.ts`（`VACUUM INTO` 库快照＋配置小文件＋`backup.json`，只留最近一份）、`mac-app-replacer.ts`（`ditto`/`plutil`/`codesign` 验收暂存；apply / rollback 两个 `/bin/sh` 脚本纯函数生成，参数全部内联转义）、`mac-updater-port.ts`（AppUpdaterPort 全实现：清单检查、暂存下载、退出替换、`pending-result.json` 回执、回滚含当前库另存）；service 加 `rollback` / `dismissApplyResult` / `backupInfo` 与 activity 透传；IPC（`app-update:rollback` / `dismiss-apply-result`）＋ preload ＋ 设置面板（回执横幅、校验态进度、回滚脚注与二次确认）；`scripts/update-manifest.mjs`（零依赖清单生成，测试直接 import 其纯函数）＋ `release.yml` publish 步生成清单。新测试 7 个文件、扩展 4 个文件（净增 ~70 用例） | typecheck · knip · 2039 tests / 206 文件（唯 `brand-migration` 为既有 Node22 环境问题，main 同样失败）· build · smoke:channel |
| — | mac 真机验收 | §11：真 mac 上过一遍支持矩阵 → 检查 → 下载校验 → 安装替换 → MCP 重载 → 回滚；`app.relaunch({ execPath: '/bin/sh' })` 语义、translocation 实况、「仅 env 变化是否触发 Cursor 重载」都只能真机验 | **待用户 / 待 mac 在手** |
| 09-17 00:11–00:30 · 14:40–15:10 | 真机首检复盘 → 网络失败分级 + 面板排版 + 镜像预设 | （CH-7 起、CH-2 接力，分支 `feat/app-update-mac`）用户贴出 0.3.3 真机截图：首检撞上 `net::ERR_CONNECTION_CLOSED`，红字钉在面板几小时，用户手动关掉自动检查。复盘出四个缺口并全部落地：① 失败分级 `classifyAppUpdateError`（Chromium `net::`、Node `E*`、undici `terminated`、超时、清单源包装 → `network`；`返回 HTTP ddd` 与其余 → `other`），网络类不记 `lastCheckedAt`、按 2 → 10 → 30 分钟短退避自动重试，成功或明确错误归零；② 失败呈现分级：网络类中性灰 + 人话（「连不上更新源…稍后会自动重试」），原始错误收进悬停 `title`，红色只留给明确错误；③ 排版对齐其他设置页：去掉 `.app-update` / `.app-update__settings` 与 `settings-section__body` 叠加的双层内边距、区块标题「软件更新 / 当前版本」与页头及状态卡重复 → 「版本状态」、检查间隔套 `settings-subgroup` 竖轨并随开关 `settings-collapse` 收起（与自动化页同手法）、隐藏 MenuSelect 无意义的灰色 swatch；④ 镜像档：`APP_UPDATE_MIRROR_FEED`（gh-proxy 前缀 + `releases/latest/download/`）作「自定义更新源」的一键预设胶囊——只填入输入框、仍要保存，已是当前源时点亮；mac 端口把目录形式的自定义源同时用于清单与安装包（`<dir>/update-manifest.json`、`<dir>/<asset.name>`），与 Windows `generic` 目录语义一致，镜像才能把检查与下载一起接走。预览加 `?update=offline` 与 `settings-update-advanced-*`（展开态排版探针） | typecheck · knip · update 相关 107 用例 · 全量见 ARCHITECTURE 条目 |
| 09-17 15:15–15:40 | 整支审查 + 两处修复 | （CH-2）对 `feat/app-update-mac` 相对 main 的全部改动做缺陷优先审查。**P1** 清单资产名未清洗即拼进 `updates/downloads/<name>`：第三方源一份 `name: "../../.cursor/mcp.json"` 的清单可覆盖再删除任意用户可写文件 → `parseUpdateManifest` 拒绝非纯文件名（`isPlainAssetFileName`），端口再兜 `basename` 一层。**P2** 回滚脚本先换包再复制库快照，`cp` 失败（磁盘不足）会让旧版包配新版库、结果文件还说「当前仍是新版」→ 快照复制挪到换包之前，换包后 `mv -f` 失败把两个包换回，`-wal/-shm` 在库换回之后才删。其余：`minimumVersion` 预留不用、`notesMarkdown` 取全文、downloader 注释「重新解析清单 URL」与实现不符——均按任务书意图不改。登记「更新源 = 代码执行授权」风险行 | typecheck · knip · 全量 vitest（见 ARCHITECTURE 条目）|
| 09-17 15:45–16:20 | 状态卡重做 | （CH-2）用户嫌「小圆点」不精致，要求参考其他页重来。状态卡改成存储清理页头部的读法：眉题「当前版本」+ 26px 数字，有目标时「→ 新版本 / 回滚到」第二个数字（当前降次要色、目标承接品牌色）；状态一句话 + 弱补充行；操作右对齐同一行。状态改由区块头的文字胶囊承担（`UpdatePanelView.badge`：已是最新 / 有新版本 / 已跳过 / 下载中 N% / 正在校验 / 待安装 / 正在安装 / 正在回滚 / 暂时连不上更新源 / 检查失败 / 下载失败 / 不支持应用内更新；忙态胶囊带细环），圆点与脉冲动画全部移除，卡片色调只落在目标数字。`headline` 不再重复版本号。顺带修 `settings-update-up-to-date-*` 场景名（`replace` 只换第一个 `_`，这两张一直没拍出来），矩阵 16 张全部加英雄行几何探针 | typecheck · knip · 2070 用例 · 24 个场景探针全过 |
| 09-17 16:20–17:55 | 版本状态改成一行设置 | （CH-2，两段会话接力）用户否掉英雄行（「这是软件开发，不是数据面板」）。去掉内卡、眉题、26px 数字与箭头：版本状态成为直接住在区块正文里的一条 `settings-row`（与 Cursor 维护页 / 自动化页同一结构）——标签是版本（无目标「拾光 0.3.2」，有目标「新版本 0.3.3」/「回滚到 0.3.1」，当前版本退到事实行「当前 0.3.2」），下面一两行说明（上次检查 / 发布日期 · 体积 · 当前 / 下一步会发生什么 / 错误原文），下载时说明之下一条 4px 进度 + 读数；操作在右列。发布说明从色块搬进 hairline 分隔的「更新内容」行（`groupReleaseNotes`：连续 `- ` 行合成真列表），mac 备份脚注成「旧版备份」行、按钮在右、确认块出现时收起。`UpdatePanelView.next` → `title`，`detail` 在标签为目标版本时带「当前 x」；区块头胶囊与色彩规则不变。窗口最小宽 1440 = 矩阵宽度，四个操作按钮并排装得下。探针：矩阵场景断言无内卡 / 英雄行 / 大号数字、行是 settings-row 且标签 ≤ 14px、操作不重叠不出正文不折行、分隔行不溢出；确认块在状态行之下；备份行几何 | typecheck · knip · 2071 用例 · 22 个更新场景探针全过 |
| 09-17 18:15–18:55 | rebase 到 main + 交接复核 | （CH-2，两段会话接力）分支落后 main 5 个提交，先 rebase：`docs/ARCHITECTURE.md` 五次尾部追加冲突逐个解；与 main `50e833c` 重复的钉时钟提交 `47a485d` 丢弃——两份叠加会让 `settings-stats` 的 `beforeEach` 连调两次 `useFakeTimers`，main 那份是超集。接手复核又查出 rebase 自身留下的两处伤并修掉：**① 冲突解错顺序**——main 的 Dock 条目（09-17）被放到分支 mac 条目（09-16）之前，而全文 40 条日期标题此前严格递增；按提交时间（mac `dde7463` 00:06 → Dock `541028e` 00:21 → 网络失败 `dcd1563` 14:55）把 Dock 挪到两者之间，恢复唯一被打破的不变量，改动由脚本断言为纯换序（行多重集不变）。**② 末行尾换行丢失**——删冲突标记时把尾部 LF 一并删了（同目录其余文档均以 LF 收尾），补回。合并正确性另用集合法证明：两个自动合并文件里分支侧与 main 侧的增删行在合并后逐行一致（`preview-shots.mjs` 92 / 132 行、`preview-main.tsx` 35 / 105 行，差异均为 0）；场景名集合 = 两侧并集减去分支有意改名的 `settings-update-up-to_date-*`，无重名；`git diff 5419c88 HEAD` 只含 main 改过的那 36 个文件，分支独有文件逐字节未变 | typecheck · knip · 2105 用例 / 210 文件（`brand-migration` 随 main 的 Node 修复转绿）· build · smoke:channel · 35 个场景探针（24 更新 + 11 dock/turn-files）全过 |
| 09-17 18:55–19:15 | 合回 main + 设计审查四修 | （CH-2）用户拍板合并：`main` fast-forward 到 `0d73eec`（主工作树 `E:\SG` 里另一位 Agent 的 9 个改动文件与本分支零重叠，未被触碰）；未推送。随后按「设计精致 / 用户友好 / 交互丝滑 / 不造屎山」四条标准复审已落地的面板，查出四处并全修：**①「重试」不重试**——下载失败后主按钮写「重试」，派发的却是 `dismiss`，reducer 只退回 `available`，用户还得再点一次「下载」；改为只有真能一键重来的才叫重试（`retry-download`：先 dismiss 再立刻重发），回滚 / 检查失败老实叫「知道了」。**② 确认块只是名义上的 alertdialog**——打开时行内按钮整组卸载、焦点掉回 `<body>`，键盘要从页首重新 Tab，且没有 Esc；改为打开即接管焦点、Esc 可取消、关闭后按 `data-action` 还焦。**③ 回滚与安装确认同色**——回滚要用旧库快照覆盖当前库，却和「装个新版」共用品牌橙；确认块与主按钮改走危险色，正文仍是炭色（色彩纪律不变）。**④ 明确失败把技术串当正文**——`sha512 checksum mismatch…` 直接当状态句；每个步骤给人话正文，原文退到弱行（能读懂也能照抄反馈，比塞进悬停强），并把检查路径已有的网络分级补到下载路径（`net::ERR_*` 中性「下载未完成」，`返回 HTTP 500` 照旧报红）。另修状态胶囊 20px → 18px（注释一直写着要跟清理页的 18px 风险胶囊同形）。确认块探针改在真浏览器里断言 `document.activeElement` 与两块确认的色调差异 | typecheck · knip · 2110 用例 / 210 文件 · build · smoke:channel · 24 个更新场景探针全过 |
| 09-18 15:20–15:29 | 发版 v0.3.4 | （CH-2）用户「直接开始发新版」：版本 0.3.3 → 0.3.4，发布说明按 v0.3.3 以来 main 的全部改动（48 个非合并提交：协作组运行时模型 / mac 应用内更新 / 回合文件栏等）重写；`e25321a` + tag `v0.3.4` 推到 `lyr339/SG-Team`，Release 工作流 mac / windows / publish 全绿（07:26:45Z → 07:29:12Z）。资产 5 个：`ShiGuang-Setup-0.3.4.exe`（117,603,337 B）、`.exe.blockmap`、`latest.yml`（version 0.3.4、path / size 与 exe 一致、sha512、releaseDate）、`ShiGuang-0.3.4-mac-arm64.zip`（133,904,338 B）、`update-manifest.json`（version 0.3.4——mac 清单首次随版本发出）。**这是第一个能被 0.3.3 应用内检查到的版本**，§0.6.4 现可在真机直接验。同日 main CI 两连红是 Windows 真实 PowerShell 用例的 5s 探测超时（慢 VM；`81d2151` 修——探测 20s、用例 90s、断言消息带每次调用诊断），Release 只跑 typecheck，产物不受影响 | GitHub API 实取 release / assets；`releases/download/v0.3.4/latest.yml` 与 `update-manifest.json` 实取 |

***

## 13. 风险登记与待用户拍板

### 13.1 风险

| 风险 | 影响 | 对策 / 验证 |
|---|---|---|
| Cursor 对「仅 env 变化」的 mcp.json 是否重载未实测（既有观察是整条目变化会重载） | 升级后旧 MCP 一直跑到 Cursor 重启 | §11-B 验证项 B；不重载则面板提示手动刷新，且可退化为在 `args` 后追加 `--app-version=<v>`（MCP 入口忽略未知参数） |
| `app.relaunch({ execPath })` 在 mac 上是否等待退出 | 两个实例竞争 / 脚本抢跑 | §11-B 验证项 A；脚本自带 PID 等待兜底 |
| `release-assets.githubusercontent.com` 签名 URL 1 小时过期 | 慢网续传 403 | 每次重试从清单 `url` 重新解析 |
| 国内直连 GitHub 不通 / 间歇可达 | 首检撞瞬断即红字钉住几小时（0.3.3 真机已发生） | 09-17 已处理：网络类失败不记「已检查」、2 → 10 → 30 分钟退避重试、中性呈现；设置页一键 gh-proxy 镜像预设（检查与下载同走）；公共镜像站可能失效，换站只改 `APP_UPDATE_MIRROR_FEED` |
| **更新源 = 代码执行授权**（U1 不买证书的推论） | mac 只做 `codesign --verify`（任何 adhoc 签名都过）、Windows 无 Authenticode：谁能改清单 / `latest.yml` 与安装包，谁就能让拾光装它的代码 | 默认源是 GitHub + HTTPS；**自定义源 / 镜像等于信任该站运营者**——gh-proxy 胶囊是便利不是背书。清单资产名已限定纯文件名（09-17 审查修复，防路径穿越）；日后若买证书，`stageMacBundle` 加 `codesign -dv` 的 TeamIdentifier 比对即可收口 |
| `/Applications` 不可写（标准用户） | 阶段 1 不可用 | `block` + 文案；提权路径后置 |
| 磁盘不足（zip 133 MB + 解压 299 MB + 库备份 90 MB） | 中途失败 | 预检 statfs；失败不动原包 |
| 用户在 `downloading` 时退出拾光 | `.part` 残留 | 下次启动清 `updates/downloads/*.part` |
| 旧 MCP 读新库（§7.6） | 四个仓储零影响；任务池 schema 若升版，旧 MCP 在重载前写入失败 | 本任务不加表列；阶段 2B 的 team-control v9 只在打开时校验，无影响；任何任务池升版的发版说明要提示确认 MCP 已重载 |
| 回滚恢复库 = 丢更新后数据 | 用户预期 | 确认框明说 + 当前库另存不删 |
| 发版时清单与 zip 上传非原子 | 客户端短暂 404 | 按「产物暂缺」提示重试，不报损坏 |

### 13.2 需要用户拍板（不拍板则按「建议」执行）

1. **席位在线时是否允许确认后继续安装**——建议：允许（`confirm`），文案写清瞬断 5 秒；否则改为 `block`。
2. **自动检查默认开、间隔 6 小时、启动后 45 秒首检**——建议：如此；可在设置里关。
3. **回滚是否总是连库一起回**——建议：是（§7.5 的理由）；替代方案是只在检测到 schema 前进时回库，但要跨五个仓储比对 meta 表，复杂度不值。
4. ~~**Windows 何时开工**~~ → **09-16 已落地**（§0.6）；真机应用内升级验收仍待 §0.6.4。

***

## 14. Windows 路线备忘（09-16 已落地，本节留作历史）

09-16 之前本节是设计备忘；实现见 §0.5–§0.6 与 `docs/ARCHITECTURE.md` Self-update boundary。要点：`electron-updater` + NSIS、`build.publish`、`latest.yml` + `.blockmap` 上传、`autoDownload=false`、`quitAndInstall(true, true)`、安装器按安装目录前缀杀进程（含 MCP）、门禁 confirm/block、手动组件 UI。
