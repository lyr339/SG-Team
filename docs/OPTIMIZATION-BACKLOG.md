# 拾光软件优化清单

> 2026-09-18 重写：只保留仍然开放的项，已完成项（08-25 审计的 P0/P1 全部 ✅、过程样式并块、文件大小格式化出口、
> ProcessBlocks ARIA、knip 接入、最小 CI、SessionWorkspace / App 组件测试等）见 git 历史与 `docs/ARCHITECTURE.md` 的日期条目。
>
> 复核基线（2026-09-18，main `16cf464`）：typecheck ✅、vitest 207 文件 / 2103 用例全绿、knip 干净。
> 产物体积（`npm run build`）：renderer 1.49 MB JS + 424 KB CSS；main 1.29 MB；mcp 1.12 MB
> （08-25 分别为 764 KB + 117 KB / 495 KB / 970 KB——三周翻倍，主要来自 app-update、账号自动化、统计页与预览场景）。
> 优先级：P1 近期 / P2 择机。成本：S ≤ 0.5 天，M 1–2 天，L ≥ 3 天。

## 1. 性能与体积

| # | 项 | 优先级 | 成本 | 依据 / 备注 |
|---|----|--------|------|------|
| 1.1 | 依赖与产物瘦身：MCP bundle 1.12 MB（zod v4 + MCP SDK v2 全量内联，`ssr.noExternal: true`）；renderer 1.49 MB 单 chunk，无按模块分包（设置页七组、统计页、运行页、检视器全在首屏 chunk；预览场景不在生产 bundle 内，`preview.html` 只由 `vite.preview.config.ts` 构建）。评估树摇、按需引入与 `manualChunks` | P2 | M | `out/` 实测 |
| 1.2 | 过程流重活外移：present / safePlain / diff 计算从 Cursor 页面内挪到 Node 侧。09-12 已完成节流 + 事实缓存三步（成本降 1–2 个数量级），外移只省 CPU 不省 O(回合) 读取，收益递减——动手前重新实测 | P2 | M–L | `cursor-stream-observer.ts` |
| 1.3 | `legacyPatch()` 扫描为找标记读整个 20 MB workbench bundle（尾部读取即可） | P2 | S | `cursor-storage-scanner.ts`（ARCHITECTURE 09-12「Not done, recorded」） |
| 1.4 | 桌面遥测每个变化 tick 都从 `state.vscdb` `json_extract` 整段 `composerData:*` blob（09-13 已把重算从 272–545 ms 降到 13 ms；blob 读取本身仍是 O(composer 体积)） | P2 | M | ARCHITECTURE 09-12 (b) |

## 2. 交互与视觉一致性

| # | 项 | 优先级 | 成本 | 依据 / 备注 |
|---|----|--------|------|------|
| 2.1 | 硬编码色值收敛：`styles.css` 274 处 hex（对照 1913 处 `var(--*)`），全部 CSS 355 处。其中相当一部分是 `:root` 里 `light-dark(#…, #…)` 的令牌定义（合法），真正该收敛的是令牌块之外、散落在过程 / 状态徽章 / 文件类型色里的字面量——统计前先把令牌块排除 | P1 | M | 2026-09-18 正则计数 |
| 2.2 | 错误态策略普查：`sendError` / `attachmentError` 常驻不消退（`role="alert"`），与更新面板「人话一句 + 弱化原文」的做法不一致；统一为自动消退或可关闭 | P2 | S | `ComposerWorkbench.tsx` / `SessionWorkspace.tsx` |
| 2.3 | 右栏审查行仍打印带零的 `+N −M`；转写文件条已改为只显示非零一侧（`describeLineCounts`）——两处应共用同一规则 | P2 | S | ARCHITECTURE 09-17「Not changed, recorded」 |
| 2.4 | 预览 mock 的 todo 场景内容仍写着已移除的「席位自动轮换」实施步骤（`preview-main.tsx` `?plan=long`）；只是示例文本，但会误导读截图的人 | P2 | S | `preview-main.tsx` 582–586 |

## 3. 可访问性

| # | 项 | 优先级 | 成本 | 依据 / 备注 |
|---|----|--------|------|------|
| 3.1 | `fs-10`（10 px）使用 253 处（08-25 为 110），辅助文字普遍偏小；配合 faint / muted 低对比色在浅色下有对比度风险。关键状态文本 ≥ 11 px 基线 + 对比度抽测 | P1 | M | 2026-09-18 正则计数 |
| 3.2 | 会话工作区 Escape 返回名册尚未实现（名册行漫游 ↑/↓/Home/End 已有；Escape 目前只用于弹窗 / 菜单 / 确认块） | P2 | S | grep `Escape` |

## 4. 代码健康度

| # | 项 | 优先级 | 成本 | 依据 / 备注 |
|---|----|--------|------|------|
| 4.1 | `docs/ARCHITECTURE.md` 251 KB：前 ~110 行是稳定架构，其后是 60 余条按日期追加的决策日志。考虑拆成 `ARCHITECTURE.md`（稳定部分）+ `docs/decisions/` 或 `ARCHITECTURE-LOG.md`（日志），并规定新条目只进日志。多席位并行时都往同一文件尾部追加，是合并冲突的常客 | P2 | S | 本轮审查 |
| 4.2 | 阶段 4 之前的已知死路径：`check_messages.reply`（与 `record_reply` 同效）、`record_reply.groupId / taskId / files`、`channel_presence.pendingGroupChat / pendingGroupId`（恒 false / null）、`team_run start / ping / pong / liveness`、`renew` no-op。全部归阶段 4（`.handoff/DYNAMIC-GROUPS-PHASE4-MCP-TODO.md` 4B / 4D），因为改工具面会让所有在跑的长轮询断一次，要选窗口一次做完 | — | — | 不在此处动 |
| 4.3 | 启动时不校验 Cursor 版本（全部逆向锚点针对 3.6.31）；应读取 Cursor 版本并在不匹配时给出提示 | P1 | S | ARCHITECTURE 09-13「candidate follow-up」 |
| 4.4 | 类型严格性保持：strict + `noUncheckedIndexedAccess` 已开，src 零 `: any` / `as any` ✅（守护即可） | — | — | 2026-09-18 复核 |

## 5. 测试与发布质量

| # | 项 | 优先级 | 成本 | 依据 / 备注 |
|---|----|--------|------|------|
| 5.1 | `release.yml` 只跑 typecheck + 打包，不跑 `smoke:mcp:packaged`（打包产物的三进程围栏冒烟只在本地 `verify:mac` / `verify:win` 里）；把它纳入发布 job | P2 | S | `.github/workflows/release.yml` |
| 5.2 | 本仓库大量 Windows 路径写的是「平台注入单测覆盖、未在 Windows 真机验证」（CDP 重启、taskkill、cmd 引号、保留端口、热切泵、NSIS 安装）；有 Windows 机器时按 ARCHITECTURE 各条目的「Still to be confirmed」清单过一遍 | P1 | M | ARCHITECTURE 09-12 / 09-13 |
