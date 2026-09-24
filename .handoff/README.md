# `.handoff/` 交接任务书索引

任务书是某一项工作的**自包含施工文档**（背景、决策、切片、验收、进度日志），接手的席位按书施工、每完成一步在书末追加一行。
决策与实现的**长期记录**不在这里——在 `docs/ARCHITECTURE-LOG.md` 的日期条目里（稳定架构在 `docs/ARCHITECTURE.md`）；一项工作合回 main 之后，任务书只剩历史价值。

## 进行中（接手先读）

| 文档 | 一句话 | 状态 |
|---|---|---|
| `DYNAMIC-GROUPS-ROADMAP.md` | 「团队 run → 会话池 + 动态分组」四阶段路线图与依赖图；各阶段任务书的索引 | 阶段 0/1/2/3 已合回 main，4 代码完成在分支上 |
| `DYNAMIC-GROUPS-HANDOFF-TODO.md` | 阶段 1：数据模型、身份授权、服务 API、编排按组、最小 UI | 已合回 main（v0.3.0）；§11 真机验收与阶段 3/4 一并做 |
| `DYNAMIC-GROUPS-PHASE2-RUNTIME-TODO.md` | 阶段 2：编排边界（D1）、团队 run 启动状态机退役、重建 / 交接与组、账本随 Composer、lease 按 presence（D3） | 已合回 main（`ae3d74f`）；真机验收待全部阶段完成后一次进行 |
| `DYNAMIC-GROUPS-PHASE3-UI-TODO.md` | 阶段 3：渲染层「会话与分组」——名册按组分区、多选建组、PoolPage、组卡片、ConfirmSheet、TransferMembershipDialog | 已合回 main（09-18 夜）；真机验收待全部阶段完成后一次进行 |
| `DYNAMIC-GROUPS-PHASE4-MCP-TODO.md` | 阶段 4：MCP 工具面收敛——按分组状态暴露工具、删死参数、团队消息内联投递、删探活 / renew（判别联合有意不做，见其 §9） | 代码完成，分支 `feat/dynamic-groups-phase4`（worktree `E:\SG-phase4`，4 个提交）；待实机验收（其 §7）后合回 main |
| `AUTO-UPDATE-TODO.md` | 应用自更新：Windows electron-updater（v0.3.3 已发）+ mac 静态清单自替换（已在 main） | 代码完成；待用户真机验收（§0.6.4、§11） |
| `STATS-PAGE-REFINE-TODO.md` | 设置页「统计」精致化：KPI 三卡、带坐标系与图例的趋势图（席位 / 模型 / 分组切分）、逐回合明细 + 导出 CSV、实底卡片与尺度收敛、本月 / 上月范围 | 09-22 动工；分支 `feat/stats-refine`（worktree `../SG-Team-stats`），进度看其 §7 |

## 已归档（`archive/`，只读历史）

工作已合回 main 并在 `docs/ARCHITECTURE-LOG.md` 有对应日期条目；保留原文供追溯当时的取舍，不再更新。

| 文档 | 覆盖内容 | 收口 |
|---|---|---|
| `archive/HANDOFF.md` | 会话过程流 P0 全链路修复（虚拟回合、过程帧契约、Bubble 级协议过滤、封口持久化、渲染 turn identity、渐进展示） | 09-02 起草，随 `PROCESS-STREAM-NATIVE-TODO` 完成；§8「事件序列级测试」纪律仍被后续任务书引用 |
| `archive/PROCESS-STREAM-NATIVE-TODO.md` | Cursor 原生过程流接入：hook、编辑流式尾窗、工程全量验证 | 09-11 阶段 A–D 完成 |
| `archive/TEAM-CONTEXT-HANDOFF-TODO.md` | 团队席位接入「会话上下文交接」 | 09-08 阶段 A–D 完成（其「职责迁移」后于阶段 2 · 2C 改为 `transferMembership`） |
| `archive/USAGE-REALTIME-TODO.md` | 用量实时采样（阶段 A/B/C） | 09-04 完成；结论被 V3 取代 |
| `archive/USAGE-ACCOUNTING-V3-HANDOFF-TODO.md` | Token / Cost 统计 V3：精确优先、实时估算、最终校准 | 09-05 完成；账本生命周期后于阶段 2 · 2E 改为随 Composer 绑定 |
| `archive/SETTINGS-PAGE-HANDOFF-TODO.md` | 设置页（账号与 Cursor）重构 | 09-08 完成并随 v0.2.x 发布 |
