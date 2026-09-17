# 交接任务书：会话池 + 动态分组 · 阶段 2 运行时语义收口

> **状态（2026-09-17）：阶段 2 全部落地——2A、2B（2B-1 + 2B-2）、2C、2D（continuity 按池模型整体退役，见 §5.1）、2E（账本随 Composer 与绑定走，统计页三层求和，见 §6.1）、2F（租约按 presence 自动续，见 §7.3）（分支 `feat/dynamic-groups-phase2`，worktree `E:\SG-phase2`；09-17 19:00 推送到 GitHub，随后按用户决定把 main `72396ae`（32 个提交）合回本分支——见 §8 末行与 ARCHITECTURE「Session pool phase 2 rebased on reality」）。** 路线图见 `DYNAMIC-GROUPS-ROADMAP.md`；真机验收按用户要求在此之后一次进行。
> 每完成一步在第 8 节追加一行；中断后接手者只读第 0、8、9 节即可定位。真机验收按用户要求合并到全部阶段完成后一次进行。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录（macOS / Windows 均可）
>
> 来源：CH-2 独立席位 2026-09-13 的只读审查（代码 + 运行库 24 天使用数据）。业务源码零变更。
>
> 需要用户拍板的三项决策见第 1 节；未拍板前 2A / 2F 不动工，其余模块可先做。

***

## 0. 接手人先读

### 0.1 一句话

阶段 1 让「组」存在并可用；阶段 2 让它成为**唯一**的团队语义：退役团队 run 的启动状态机与创建路径，
定稿编排器与 lead 的职责边界，让席位重建 / 交接 / 检查点 / 用量都认识「组」。

### 0.2 阶段 1 留下的、必须在这里收口的事

| 遗留 | 来自 | 本阶段动作 |
|---|---|---|
| `TeamRunStatus` 七态与 `launchStatus` 五态仍在 domain 里 | 阶段 1 只保证「不坏」 | 收敛为 `running \| completed`；`launchStatus` 退役（2B） |
| `configureWorkspace / createNextRun / beginLaunch / settleAgentSessionLaunch / ensureRunLaunching / reconcileLaunch` 仍可调用 | 同上 | 删除（2B） |
| 编排器按组迭代但 lead 简报仍要求 lead 调度 / 催办 | 阶段 1 §5.5 | 定稿边界（2A） |
| `prepareComposerRelaunch`（换席重建）不知道组 | 阶段 1 §5.8 明确不改 | 重建保留 `group_id / role_id`（2C） |
| `TeamContinuityService.restore` 不恢复组 | 阶段 1 §4.5 | 原计划恢复组结构（2D）；落地时查明 `restore` 从未有调用方，整个 continuity 模块按池模型退役（§5.1） |
| 用量按池累计不清零 | 阶段 1 R7 | 按组 / 按会话（2E） |
| 任务板 lease：29 个任务 0 完成、8 次失败全因 `lease_expired` | 阶段 0 前数据 | 可选模块（2F），需拍板 |

### 0.3 实施纪律

1. 每个子模块独立可合入；2B 是最大删除面，放在 2A 决策之后、2C–2E 之前做。
2. 删除旧团队 run 路径前，先确认运行库里没有 `software-core-v1` 且 `status ∉ {completed}` 的 run 仍在使用
   （09-13 数据：18 draft / 10 ready 从未启动，26 completed；可整体归档）。
3. `activeRun` 仍 = 池 run；本阶段不消灭它（阶段 3 结束后再评估）。
4. 事件序列测试；不允许「只改文案」式修补。

### 0.4 明确排除

- 渲染层（阶段 3）；MCP 工具面（阶段 4）；多组归属；Cursor 侧一切。

***

## 1. 决策点（拍板后填入第 8 节日志）

| # | 决策 | 选项 | 建议与依据 |
|---|---|---|---|
| D1 | 编排边界 | (a) 系统全自动：分派 / 催办 / 派验收 / 记忆审核调度由桌面编排器完成，lead 只 `plan` + 面向用户汇报；(b) 关闭编排器，lead 用 `team_message send directive` 调度；(c) 现状并存 | **(a)**。08-27 峰值日 31 条 directive 中 28 条来自 operator；lead Agent 自己只发过 3 条；并存导致 lead 成为「贵的信箱」 |
| D2 | 组是否必须有 lead | (a) 必须；(b) 可选 | **(b)**。无 lead 组 = 共享目标 + 消息 + 记忆；`plan` 权限在无 lead 组里授予用户（桌面侧建任务）或任一成员（配置项） |
| D3 | lease 语义 | (a) 服务端按 presence 自动续，Agent 不再 `renew`；(b) 维持显式 `renew`；(c) 取消 lease，只保留 assignee | **(a)**。唯一失败原因是过期；Agent 的工作节律（长命令 / 长推理不碰 MCP）与 5 分钟 TTL 天然冲突；presence 已有 processing 5 分钟宽限 + CDP `runtimeActiveAt` |

***

## 2. 模块 2A · 编排边界定稿（依赖 D1 / D2）

### 2A.1 目标（按 D1=a、D2=b 写；若拍板不同，接手人按第 1 节改写本节）

- 桌面编排器是唯一调度者：`TaskDispatcher`（分派执行与验收）、`TeamOrchestrator`（催办）、`MemoryReviewCoordinator`（审核调度）按组运行（阶段 1 已按组迭代），**不再**给 lead 发「请关注 / 请安排」类 notice；lead 只在以下三类事件收到 notice：任务 `done`、任务 `failed`（用尽重试）、成员 `attention`。
- lead 简报（`buildTeamRoleBriefing` lead 分支）改写：职责 = 把用户目标拆成任务（`team_task plan`）+ 处理用户的询问 + 汇总真实上报；**删除**「催办」「安排验收」「打回返工」句；保留「禁止代答」。
- 成员简报删除「关键节点主动向主控上报（team_message send）」——上报由 `reportTaskStatus` 自动生成的 `status` 消息完成（现状即如此），Agent 不需要再手写一条。
- 无 lead 组：`team_task plan` 对任一成员开放（`team_groups.plan_policy = 'lead_only' | 'any_member'`，默认 `lead_only`，无 lead 时自动 `any_member`）；桌面侧提供「在组内建任务」入口（阶段 3 UI，阶段 2 先加 IPC `teamControlPlanGroupTasks`）。

### 2A.2 落点

`team-control.ts#buildTeamRoleBriefing`、`team-collaboration-agent-service.ts#planTasks`（权限）、`team-orchestrator.ts`（去 lead 预警）、`task-dispatcher.ts`（done / failed 通知 lead）、`team_groups.plan_policy` 列（additive）。

### 2A.3 测试

- 简报快照：lead / 成员 / 无 lead 组三种文本不含被删句。
- `plan` 权限矩阵：lead_only 组的成员 → `lead_only_plan`；any_member 组的成员 → 通过。
- 任务 `done` → lead 收 1 条 notice；`progress` → lead 不收 notice（对比阶段 1 行为）。

### 2A.4 实现决策与偏差（09-16 落地，阶段 3 / 4 以此为准）

- **IPC 命名归入 `team-group:*` 家族**：`team-group:plan-tasks`（`DesktopApi.planTeamGroupTasks`，返回 `TeamTask[]`）与 `team-group:set-plan-policy`（`setTeamGroupPlanPolicy`），不是任务书写的 `teamControlPlanGroupTasks`——组操作在阶段 1 已集中于 `TeamGroupService` / `register-team-group-ipc.ts`，任务池 IPC 保持只读。`plan-tasks` 不受一键建会话守卫阻塞（只入池，派单由编排器在成员就绪后做）。
- **策略语义**：有 lead 时 `plan_policy` 不生效（规划权始终归有效 lead，与「lead 与模板解耦」同口径），只在无 lead 时决定成员能否 `plan`；因此新增了 `setGroupPlanPolicy`，否则 `setGroupLead(null)` 之后的组会卡死在建组时的默认值。阶段 3 的建组抽屉按任务书「有 lead 时隐藏」即可，组卡片菜单可加「规划策略」切换。
- **权限实现走能力叠加而非新字段**：`effectiveCapabilities` 对「无 lead + any_member」组的每个成员叠加 `LEAD_ROLE_CAPABILITIES`，`TaskAgentService.ensureCoordinator` 原样放行（错误码仍是 `coordinator_only`，不是任务书写的 `lead_only_plan`）；`isEffectiveLead` 不变，directive / broadcast / collect 仍 lead 专用。副作用：`team_check_in` 的成员目录里这些成员显示带 coordination / planning。
- **lead 的第三类通知「成员 attention」落在 `TeamCollaborationSweeper.sweepMemberAttention`**（与主控失联广播同一处、同一证据口径、同一周期键模式），不在 failover 服务里。
- **`status` 上报保留**：成员的 claim / start / progress / submit / fail / review 仍由 `reportTaskStatus` 自动生成 `status` 消息给 lead（任务书原意）；本阶段只删「请关注 / 请介入」类 notice，不收敛 status 频次（那是阶段 4C 内联投递的事）。
- **旧行回填 `lead_only`**：升级前建好的无 lead 组不会因升级悄悄让成员拿到规划权；用户需要时在桌面切到 any_member。

***

## 3. 模块 2B · 团队 run 启动状态机与旧创建路径退役

### 3.1 删除清单

| 层 | 删除 | 替代 |
|---|---|---|
| domain `team-control.ts` | `TeamRunStatus` 中 `draft / ready / launching / attention / paused`；`TeamLaunchStatus`；`TeamMemberReadiness` 中 `launching`；`buildTeamLaunchHint`；`createDefaultTeamBundle`（仅测试用则迁入测试夹具）；`TeamPreflight.goalDefined / agentsWaiting / canLaunch` | `TeamRunStatus = 'running' \| 'completed'`；readiness 只剩 `unbound / mcp_missing / offline / not_waiting / ready / active`；组级 `attention` 布尔（阶段 1 已有） |
| infra `sqlite-team-control-repository.ts` | `beginLaunch / ensureRunLaunching`；`recordAgentCheckIn` 中的 run 状态自愈与 totals 推进；`recordInstallation` 的整批重装路径（保留 `registerSeat`）；`migrate()` 末尾的 `ready→draft` 修复 | 迁移 v8→v9：`UPDATE team_runs SET status='completed' WHERE status IN ('draft','ready','launching','attention','paused')`（历史 run 归档）；`runtime_bindings.launch_status` 列保留但恒 `'not_started'`（不删列，旧构建共库） |
| application `team-control-service.ts` | `configureWorkspace / createNextRun / launchTeam / settleAgentSessionLaunch / reconcileLaunch / assertNoLaunchInFlight / activeLaunch` | `configureIndependentWorkspace` 改名 `createSessionPool`（语义：新建池，替换旧池） |
| application `agent-session-launcher.ts` / `team-agent-launch-prompts.ts` | 团队 launch hint 分支 | 只剩 solo hint |
| application `team-failover-service.ts` | `reconcileAcknowledgements`（依赖 launching）；standby 自动接替全部（池无 standby） | 组级 attention（阶段 1）；lead failover 按组保留 |
| main `register-team-control-ipc.ts` / `desktop-api.ts` / `preload` | `teamControlCreateTeam / teamControlNextRun / teamControlLaunch / teamControlPrepareActiveSetup / teamControlUpdateGoal`（run 级目标） | 组级 `updateGroupGoal`（阶段 1 已有） |
| mcp `team-tools.ts` | `team_run action:'start'` | 返回 `not_applicable` 直至阶段 4 删除该 action |
| renderer | 依赖上述 IPC 的调用点先改为不可达（阶段 3 删除组件） | — |

### 3.2 数据归档

- 历史 `software-core-v1` run：状态归档为 `completed`，`detail='archived: legacy team run'`（`completeRun` 的 detail 参数）；其 tasks / messages / memory 保留只读。
- `TeamControlSnapshot.runs` 仍包含历史 run（渲染层历史视图用），但 `project()` 只投影池 run 的 roles / slots / bindings。

### 3.3 测试

- 迁移 v9：五种旧状态全部归档；池 run 不受影响；幂等。
- `recordAgentCheckIn` 对 `status='running'` 之外的 run 拒绝（只剩 `completed`）。
- `TeamControlService` 公开面快照测试：删除的方法不再导出（knip 同时守护）。
- `team_run start` → `not_applicable`。

### 3.4 实现决策与偏差（09-16 落地 2B-1 与 2B-2，模块 2B 完成）

2B 拆成两步：**2B-1「创建 / 启动路径退役」**（已提交 `7fb9a5f`）删除一切能*到达*团队 run 状态机的入口；**2B-2「状态枚举收敛」**（已提交 `4a9fa47`）再删状态机残留的类型与字段。

- **v9 迁移比任务书多做两件事**：① 归档的团队 run 各绑定标 `failed` 并写 `archived: legacy team run（升级归档，团队 run 已退役）`——围栏据此对仍持旧令牌的会话答 `run_completed`，这是升级后唯一能让旧团队会话停下的通道；② 同一工作区内被更新 run 取代的 `running` 独立 run（早期代码脏数据）一并归档。归档走 SQL 而非 `completeRun`，因此**不撤销** `agent_registrations`——旧会话由围栏退役、`team_*` 调用在 `recordAgentCheckIn` / run 状态处被拒；2B-2 若要补撤销，在迁移里对归档 run 调 `revokeWorkspaceAgentRegistrations` 即可。
- **`recordInstallation` 未拆**：任务书写「删整批重装路径、保留 `registerSeat`」，2B-1 保留了 `recordInstallation`（同拓扑幂等刷新、不轮换令牌、不改 run 状态，测试锁定），拆分留给 2B-2 / 阶段 3 的「不新建批次增删席位」一起做。
- **`team-failover-service.ts` 未动**：`reconcileAcknowledgements`（依赖 `launching`）与 standby 自动接替仍在，随 2B-2 的 `launchStatus` 退役一起删。
- **渲染层直接删组件而不是「改为不可达」**：`TeamSetupPage / RunModeSwitch / RunTeamPanel / team-setup.css / team-skill-defaults` 已删除（不可达组件会被 knip 拦），阶段 3 的 UI 任务书里对应的「替换」项按「已不存在」处理。`run-view` 仍保留 `RunView.archivedLegacyTeam`：工作区最新 run 是归档团队 run 时开始页多一句说明。
- **`createDefaultTeamBundle` 迁入 `tests/legacy-team-fixtures.ts`**：夹具直接写 `running`、可带 `goal`、按通道号升序分配 lead / builder / reviewer / specialist（与旧 domain 版本一致）。legacy 团队 run 的读路径（run 级 lead、无组作用域、归档历史）仍在，这些测试用它作为最省事的「lead + 成员」夹具；2B-2 收敛枚举时不必迁移它们。
- **`team_run start`** 对任何调用者恒返回 `not_applicable`（`tests/team-claim-lead.test.ts`），阶段 4 再从工具面删除该 action。
- **2B-2 清单（由本步剩余项组成）**：`TeamRunStatus → 'running' | 'completed'`；删 `TeamLaunchStatus` 类型（列保留）、`TeamMemberReadiness.launching`、`TeamPreflight.goalDefined / agentsWaiting / canLaunch`、`TeamRun.launchedAt`；`src/renderer/src/team/team-dashboard-view.ts`（2B-1 后只剩它自己的测试引用它——整个模块连测试一起删）；`team-failover-service` 的 `reconcileAcknowledgements` 与 standby 接替；`TeamRoleBriefing` 里 legacy run 级目标分支；仓储 `upsertWorkspaceTeam`（拓扑变化时重置为 `draft`）/ `recordInstallation`（`draft ↔ ready` 推进）中写旧状态的残留分支；`solo-routing` / `verify-agent-runtime` 等测试里的旧状态取值。

**2B-2 的实现决策（09-16 落地，`4a9fa47`；上表清单全部完成）**：

- **`acknowledged_at` 只写首次**（`COALESCE(acknowledged_at, ?)`）：domain 注释本就定义它为「首次 team_check_in 时间」，旧实现每次签到覆盖会把投影出的会话开始时间不断后移；重复签到只刷 `last_check_in_*`，回执里的 `acknowledgedAt` 仍是当次时间。
- **v9 在发货前修正**（生产库仍是 v8，迁移可原地改）：归档 = `completeRun` 的三件事——置 `completed`、**按 run 撤销 `agent_registrations`**（不用工作区级 helper，现役池不受波及）、绑定备注写归档说明；被取代的旧 running 池 run 也拿到自己的文案（`RUN_ARCHIVED_STALE_POOL_DETAIL`，2B-1 时是静默归档）。不撤销注册的话，归档 run 若仍是工作区最新 run，身份解析照常放行、随后每个 `team_*` 调用死在 run 门上。迁移收尾把全表 `launch_status` 归位 `'not_started'`、`launch_command_id` 清 `NULL`——2B-1 写的 `failed` 标记一并归位（围栏只认 `run_status`，从不读 `launch_status`）。
- **`completeRun` / `recordAgentCheckIn` 不再写 `launch_status`**：收尾原因仍写 `launch_detail`（审计备注，测试锁定）；`recordInstallation` 的默认插入保留 `'not_started'`（列 NOT NULL）。
- **`verifyAgentRuntime` 删 `requiresCursorEvidence`**：两态下恒真，连同「未启动可跳过 Cursor 证据」的不可达分支一起删。
- **`TeamHandoffService` 门面保留、`automatic()` 删除**：production 里 `options()` 对池恒 `handoff_pool_run`、对已结束 run 恒 `handoff_run_inactive`，2C 改 `transferMembership` 时一并重做；`rebindSlotToStandby` 等仓储方法暂留（唯一可达路径是 legacy 夹具）。
- **knip 连带死导出**：`ALL_TEAM_CAPABILITIES`（旧 failover 测试的夹具常量）、`hasOpenReplySync`（唯一调用方是被删的全员离线守门）删除；`CHANNEL_REPLY_SYNC_STALE_MS` 仍被 `check_messages` 自动放行使用，保留。
- **`recordInstallation` 仍未拆**（2B-1 的决定不变），留给阶段 3「不新建批次增删席位」一起做。
- **`team-failover.test.ts` 重写为 291 行 / 6 用例**：I5（任何离线组合都不收池）、用户结束后取消任务恰好一次、`start()` 订阅回放补启动、`onerror` 上报 + 下一快照重试、池内 / 已结束 run 拒绝交接。旧文件 1069 行里 standby / lead 自动转移 / 全员离线 / 遥测活性的用例随语义删除。

***

## 4. 模块 2C · 席位重建 / 会话交接与组

### 4.1 现状问题

- `prepareComposerRelaunch(runId, slotId, bindingKey)` 重置绑定并轮换令牌，但席位的 `group_id / role_id` 在阶段 1 已随席位保留——**新会话不会收到入组通知**（launch hint 是 solo 版），它会以独立席位的心智开始，却在 `team_*` 授权上是组成员。
- 手动职责迁移 `TeamHandoffService.manualHandoff`（`role_rebind / lead_authority`）把 AgentSlot 绑定改到另一通道并清 `composer_id`，这是「团队 run 一次性席位」的产物；池模型里通道就是席位，迁移语义应变为「组成员身份从席位 A 移到席位 B + 可选上下文交接」。

### 4.2 改动

- `prepareComposerRelaunch`：若 `slot.group_id` 非空，重建完成（`recordComposerBinding` 成功）后自动投递一条 `membership: joined` 通知（复用阶段 1 的通知管线），并写 `team_group_events(member_rejoined_after_rebuild)`。
- solo launch hint 不变（新会话仍先进入 `check_messages`，入组通知随首个轮询到达——这正是阶段 0 验证过的路径）。
- `TeamHandoffService.manualHandoff` 改为组语义：`transferMembership({ groupId, fromSlotId, toSlotId, includeContext })` = `removeGroupMember(from)` + `addGroupMembers([to], 同角色)` + （可选）`SessionHandoffService.deliver`；`lead_authority` 变体 = 上述 + `setGroupLead(to)`。`team_failovers` 表继续记录（`reason='manual_membership_transfer'`）。
- `manual-handoff-with-context.ts` 的编排（先解析上下文再迁移）保留，目标从「接手通道」改为「目标席位」。
- 自动接替（standby takeover）删除（2B 已列）。

### 4.3 测试

- 重建事件序列：`prepareComposerRelaunch → recordComposerBinding → outbox 出现 membership:joined（silent, kind=membership）→ 席位 group_id 不变 → 令牌已轮换`。
- `transferMembership`：A 的 lease 释放、B 收到 joined、上下文消息投递到 B、`team_failovers` 一行；`includeContext=false` 时无上下文消息。
- lead 转移变体：`team_groups.lead_slot_id` 更新，新旧 lead 各收 `lead_changed`。

### 4.4 实现决策与偏差（09-17 落地，模块 2C 完成）

- **重建通知挂在 `TeamControlService.recordComposerBinding`，不挂在 `prepareComposerRelaunch`**：任务书写「重建完成（recordComposerBinding 成功）后」，落地就以绑定成功为触发点。仓储只在 `composer_id IS NULL` 时写入（首绑即定，同一 Composer 重复上报 / 换绑尝试都返回 false），所以服务层 `changed === true` 就是席位「无 Composer → 有」的那一次，不需要读前后状态对比。席位在 active 组内才补投：写 `member_rejoined_after_rebuild`（actor `system`，detail = 组角色名，bump revision）+ 一条 `joined` 通知（lead 标签用抽到 domain 的 `groupLeadLabel`）；fail-soft，错误走 `TeamControlService` 新增的 `onerror` 选项。
- **接受一种重复投递**：席位在无会话期间入组、随后首次绑定，会先后收到入组时排队的 joined 和绑定时补投的 joined。通知幂等（都是「调 team_check_in」）、`check_messages` 顺序送达，因此不为区分「首绑」与「重建」引入持久化标记。
- **自动轮换仍只覆盖独立席位**（`seatRotationVerdict` → `not_solo`）：2C 让组内席位重建后能接上组身份，但是否把自动轮换放开到组内席位是另一项评估（任务租约 / team_check_in 状态），本模块不改。
- **迁移是一条仓储事务，不是 `removeGroupMember + addGroupMembers` 的服务层串接**：`transferGroupMembership` 在同一 `BEGIN IMMEDIATE` 里 `leaveMember(A)` → `joinMembers([B], A 的角色模板)`（B 拿到同一 `role_key`）→ 指向 A 的 `lead_slot_id / acting_lead_slot_id` 一并改指 B（各带审计事件）→ `team_failovers` 审计行（`reason='manual_membership_transfer'`，落库即 `completed`，没有「等待接替」一步）。任何一步被拒（目标已入组 / 不在池 / 与源相同、源不在本组、组已解散、池已结束）整体回滚——服务层串接做不到「A 已出组但 B 入组失败」不落地。绑定 / 令牌 / Composer / generation 全部不动（测试对比前后）。
- **`transferredLead` 按有效 lead 定义**：`effectiveGroupLeadSlotId(group) === fromSlotId`。名义 lead 另有临时主控时指针照样随迁（B 成为名义 lead，审计有记录），但 `transferredLead=false`、不发 `lead_changed`——组里的有效 lead 没有变，不能告诉 B「你已成为唯一有效主控」。`membershipTransferOptions.transfersLead` 同一口径。
- **偏差：`lead_changed` 只发给 B，不发给 A**。任务书写「新旧 lead 各收 `lead_changed`」，但 A 已出组，`lead_changed` 模板会让读者去 `team_check_in`（此时得到 `not_in_group`），与它刚收到的 `left` 通知（「不要再调用任何 team_* 工具」）矛盾；`left` 已经说明 A 不再持有任何组内权限。有效 lead 是 B 以外成员时，该 lead 收一条团队 `notice`（成员身份已迁移 + 任务回队 / 消息孤儿说明），与移出成员的 lead 通知同一段落（`departureFollowUp`）。
- **出组收尾抽成 `settleDeparture`**：移出成员与身份迁移共用「释放租约与验收（`releaseAgentWork`，reason `member_left`）+ 待回应消息标孤儿」两步与 lead 通知的收尾文案，不再各写一份。
- **候选 = 池内全部独立席位，不看在线**：离线目标同样合法，joined 通知与上下文文档都进它的通道队列，等新会话上线生效；弹窗只标「在线 / 离线」，不再有 eligible / blocker 门。源席位不在任何 active 组时拒绝（`transfer_source_not_grouped`）：独立席位的「交接」本来就是会话上下文交接。
- **删除清单**：`TeamHandoffService`（270 行）、仓储 `rebindSlotToStandby / rebindSlotFromMember / attachFailoverContext / updateFailoverStatus`（约 330 行）、`TeamFailoverRebindResult`、`TeamContinuityService.createTakeoverCapsule` + `TeamTakeoverCapsule`（`roleRestoreContent` 只剩恢复胶囊）、`TeamHandoffCandidate / TeamHandoffOptions / ManualTeamHandoff*` 类型（改为 `MembershipTransfer*`）。`TeamFailoverService` 构造只剩 team + tasks + onerror。`TeamFailoverStatus` 保留 `waiting_for_agent / failed` 以读旧行。
- **IPC 通道名不变**（`team-continuity:handoff-options` / `team-continuity:handoff`），入参改 `groupId / fromSlotId / toSlotId / includeContext`，处理器接 `TeamGroupService`；`manual-handoff-with-context.ts` 的「先解析上下文再迁移」顺序保留——不再是因为绑定会被改写，而是迁移失败时不能留下投递副作用、解析失败不能拦迁移。`ManualHandoffDialog` 文件名保留（阶段 3 重做 UI）。
- **2D 提示**：`createTakeoverCapsule` 已删，§5 里「`createTakeoverCapsule` 按组生成胶囊」应改为在 `restore` 的恢复胶囊里按组组织内容。

***

## 5. 模块 2D · 检查点与恢复按组

> 下面三条是 09-13 只读审查时的原任务；09-17 动工前通读发现前提不成立，模块改为**整体退役**，三条均未实现。原文保留作为决策依据，结果见 §5.1。

- `TeamContinuityService.capture()`：payload 增加 `groups: [{ group, members: [{ slotId, roleKey, capabilities }], leadSlotId, actingLeadSlotId }]`（阶段 1 只加字段，此处补齐语义：内容去重哈希纳入 groups）。
- `restore(checkpointId)`：恢复组结构 = 对差异执行 `createGroup / addGroupMembers / removeGroupMember / setGroupLead`（复用阶段 1 API，走同一通知管线）；`createTakeoverCapsule` 按组生成胶囊（组目标、组内任务、组内未读）。
- 一键恢复的「完成」判定沿用现状（每个成员回应关联消息），范围改为「组内成员」。

测试：捕获 → 解散组 → 恢复 → 组与成员回到捕获时状态，成员各收一条 joined；未变化状态哈希去重仍成立。

### 5.1 实现决策与偏差（09-17 落地，模块 2D 完成：continuity 按池模型整体退役）

- **事实：`TeamContinuityService.restore()` 在生产里没有任何调用方。** 全库与 git 历史均无 IPC / MCP / 主进程路径调用它：初始提交只有只读的 `team-continuity:get / snapshot` IPC，08-30 删除时注释写「快照读取由恢复流程在主进程内部完成」，但该流程从未接过入口；检查点在生产里唯一的读者是旧 failover 的 `createTakeoverCapsule`，已随 2C 删除。剩下的是一条只写日志：`capture()` 由 watcher 在每次任务 / 消息 / 记忆变化后写（650ms 去抖、内容哈希去重、每 run 上限 100 条、每条 ≤512KB），没有任何东西读它。任务书 §5 默认「一键恢复」存在，前提不成立。
- **池模型下「团队快照恢复」没有使用场景**：池不会整体意外结束，故障单位是单个会话；单席恢复 = 换席重建（令牌轮换、组身份保留）+ 转录上下文交接文档 + 2C 补投的入组通知 + `team_check_in` 实时简报。恢复胶囊里的每一项（组目标、组内成员与 lead、任务、待回应消息、共享记忆、工作文件）都是这条链上的实时状态；组结构历史另有 `team_group_events` 审计。
- **三选一交用户拍板**：A 退役整个模块；B 只删恢复、保留只写检查点并补组结构字段；C 按任务书实现并新加恢复入口（入口属阶段 3 UI 范围）。用户选 A。
- **删除清单**（约 1000 行）：`TeamContinuityService`（332）、`TeamContinuityRepository` + `SqliteTeamContinuityRepository`（31 + 247）、`domain/team-continuity.ts`（113）、`registerTeamContinuityIpc`（51）、`tests/team-continuity.test.ts`（201，2 例）、preview `continuitySnapshot` mock；`main/index.ts` 不再构造 / 释放第四个仓储与 capture watcher；`desktop-api.ts` 里 `TeamContinuitySnapshot` 的 import 本就无人使用，一并删。
- **四张表在 `SqliteTeamControlRepository.migrate()` 末尾按存在性 DROP**（`team_restore_members → team_restore_operations → team_checkpoints → team_continuity_meta`，自子向父以满足外键；`sqlite_master` 存在性守卫 + `DROP TABLE IF EXISTS`，桌面 / MCP 双进程各自迁移也幂等，从未建过表的库无操作）。不升 schema 版本——与附加列同一规则：共用文件的旧构建打开时会 `CREATE IF NOT EXISTS` 建回来，新构建下次打开再删，双向幂等。测试用旧表结构（含外键与行）播种后验证四表删除、现役 run / 绑定与数据不变、再次打开无操作。
- **IPC 归位**：成员身份迁移的两条通道只是因为旧手动交接住在 continuity IPC 文件里才在那里。改为 `team-group:transfer-options` / `team-group:transfer-membership`，由 `registerTeamGroupIpc` 注册（新增位置参数 `transferContext`：`team` 快照 + `handoff` 端口），入参校验复用该文件的 `requiredString / objectOf`（错误文案随之变为「席位 id无效」等），`transfer-membership` 与其他成员关系变更一样受 `assertNoSessionLaunch` 阻塞，`transfer-options` 是读不阻塞。**与 §4.4「IPC 通道名不变」的记录相比是一次有意的变更**：通道名里的 `team-continuity` 在模块退役后已无所指。`manual-handoff-with-context.ts` → `membership-transfer-with-context.ts`（文件名跟上 2C 的改名，内容不变）。README 不再宣称「自动检查点 / 一键恢复」。
- **不动的**：`docs/ARCHITECTURE.md` 历史条目与本任务书 §4.4 里对 `createTakeoverCapsule` / `team-continuity:*` 的叙述作为历史保留；`.handoff/AUTO-UPDATE-TODO.md` 是 08 月的调查基线（枚举「五个仓储」含 continuity），实现自动更新时按当时代码重新盘点即可。

***

## 6. 模块 2E · 用量按组 / 按会话

- 现状：`CursorUsageTracker` 以 `usageRunId` 为账本键，新 run 清零、`endActiveRun` 冻结。池 run 长生命周期后只增不清。
- 改动：账本键改为 `composerId`（会话生命周期 = Composer 生命周期），聚合视图按「席位 / 组 / 池」三层由渲染层求和；`cursor-usage.json` 存储按 `composerId` 分桶，`endActiveRun`（结束全部会话）冻结全部；席位重建（新 Composer）自然开新桶，旧桶只读保留 N 天。
- `cursorUsageRunDecision` 删除（无 run 切换语义）；`usageComposerIds` 仍来自池 run 绑定。

测试：同池两次席位重建 → 三个桶；组求和 = 成员桶之和；`endActiveRun` 后所有桶 `collecting=false`；重启回放幂等。

### 6.1 实现决策与偏差（09-17 落地，模块 2E 完成）

- **账本的开与关跟「绑定」走，不跟 run**：`reset(runId)` / `cursorUsageRunDecision` / 随行 `runId` / `usageBelongsToRun` 全删，换成 `setBoundComposers(bound)`——出绑即封口（`frozenAt`，显示值固定、迟到事件不再入账）、在绑且采集中即解冻续记（同一 Composer 重新绑定时账本连续、不双计）、封口且超窗的裁掉。池长生命周期下「run 切换」本就不再是账本事件：新池的 Composer 都是新的，旧池的账随出绑封口。`collecting` 只剩一个来源——用户显式结束（`onRunEnded` → `setCollecting(false)`，补收最后一笔后全部封口）与新池出现（`nextRunId !== usageRunId` → `setCollecting(status === 'running')`），在线状态变化仍不影响计数。
- **偏差：`usageComposerIds` 不再存在于主进程**。任务书写「`usageComposerIds` 仍来自池 run 绑定」，来源确实没变（`team.members[].binding.composerId`），但那个 `Set<string>` 连同三处调用点的过滤（write hook 回调、`onUsageEvent` / `onUsageSample`、`onRunEnded` 补收）一起删了，改为 `boundComposersOf(snapshot)` 把 `{composerId, slotId}` 交给 tracker，入账资格由 `observe()` 一处把关。理由：过滤条件与账本生命周期是同一件事（在绑才入账、出绑就封口），分散在四处只会让两者失步；且席位标签必须与入账同一时刻取，否则重建瞬间会把账打到新席位上。
- **`slotId` 随行标签 = 入账时所绑席位**，与原先 `runId` 同样只是 passenger（`projectUsage` / `reduceUsage` / `upgradeUsageEstimate` 透传，`tagSlot` 只在绑定变化时改写）。席位 id 形如 `agent-slot:<workspaceId>:<runKey>:<roleKey>`，`runKey` 每个池新生成，因此**同池重建的旧 Composer 归回本席位，换池后的旧账席位号不再匹配任何在册席位、落回「历史会话」**——这正是「席位 / 组 / 池」三层需要的粒度，不需要再存一层 run。
- **启动对齐（`reconcileLedgers`）**：落盘的账与当前「绑定 × 采集」可能不一致（旧构建重建席位不封口、结束后进程被杀来不及封口），构造函数里先对齐再裁旧，不给渲染层留「已出绑却仍开放」的账。
- **存储不升版本**：`STORE_VERSION` 仍是 4，行上 `runId` 改 `slotId`，文件顶层 `runId` 去掉；读入时旧 `runId`（V4 行与 V2/V3 顶层）一律忽略。共用文件的旧构建读到无 `runId` 的行按「不限定」处理（徽章照显），不互相强迫升级。
- **徽章口径收紧**：`App` 不再回退到 `telemetryChannelComposerId`，只认 `session.composerId`（= 绑定的 Composer）。既然只有在绑的 Composer 入账，回退只会在席位重建后、新会话绑定前把旧账顶在新席位上。统计页仍保留该回退（归属而非计数，且指向的是同一席位）。
- **渲染层三层求和**：席位层沿用光谱带 / 每席位构成 / 明细（明细对「按 `slotId` 归回本席位」的旧 Composer 标「· 旧会话」）；**新增「分组」卡**（组 = 成员席位之和，条宽 = 占池份额，不随席位筛选收窄，没有 active 组不出卡）；池层 = 账本行与 `spectrumTotals`。§0.4 把渲染层留给阶段 3，但 §6 明确要求三层求和落在渲染层，故只做这一张最小卡片、样式与「模型分布」共用同一套行式布局，不动页面结构。组来源取活动 run 的 active 组（`App` 投影 `StatsGroupSource`），历史会话不属于任何组，所以 `池 = 组之和 + 历史会话`。
- **preview `?stats=1`** 补两个 active 组与一个带席位标签的重建前 Composer，新卡片与「旧会话」标注可走查。

***

## 7. 模块 2F（可选，依赖 D3）· 任务板 lease 语义修正

### 7.1 D3=a 的实现

- `TaskPoolService.startSweeper` 的过期判定改为：`leaseExpiresAt` 到期 **且** assignee 通道 `isPresenceOnline === false` 持续 ≥ `CHANNEL_PROCESSING_STALE_MS`（5 分钟）；在线的 assignee 自动续到 `now + DEFAULT_LEASE_TTL_MS`（服务端写，不需要 Agent 调用）。
- `team_task action:'renew'` 保留一版为 no-op 兼容（返回新的 `leaseExpiresAt`），阶段 4 从工具面删除。
- `progress / submit / fail` 任一调用同样续租（现状不续）。
- 移出成员 / 解散组时的释放规则沿用阶段 1 §7。

### 7.2 测试

- 事件序列：`claim → 6 分钟无 MCP 调用但 presence 在线（CDP runtimeActiveAt 刷新）→ 不过期`；`claim → assignee 离线 5 分钟 → lease 释放 → task 回 queued → 重新分派`。
- `renew` no-op 仍返回合法 `leaseExpiresAt`。

### 7.3 实现决策与偏差（09-17 落地，模块 2F 完成）

- **判定必须下沉到 domain，只改清扫器是假修**：`reclaimExpired()` 不止被 `TaskPoolService.startSweeper` 调用，`leaseNext / leaseTask / leaseReview` 内部也各调一次——而这三条跑在 **MCP 进程**里。只改主进程清扫器的话，任何 Agent 领一次任务就会按旧规则把别人正在跑的在岗租约回收掉。因此在岗判定做成 `TaskPoolDependencies.holderOnline` 注入聚合，两个进程各注入一次同口径的实现：主进程用席位 `runtime.online`（relay 已按 presence 算好），MCP 进程用 `bindings` 找到通道再 `isPresenceOnline(getPresence(channelId))`。**缺省 `() => false`**，保持 2F 之前「到期即回收」的行为——漏接线要暴露成回收，不能悄悄变成永不过期。
- **偏差：没有在 `isPresenceOnline` 之外再叠一层「离线持续 ≥ `CHANNEL_PROCESSING_STALE_MS`」**。任务书 §7.1 这么写，但 `isPresenceOnline` 本身已经是三段窗口（processing / need_reply_sync 给 5 分钟宽限，其余 120s，证据取 MCP 心跳与 CDP `runtimeActiveAt` 的较新者），再叠 5 分钟等于让一个证据确凿已死的席位继续扣着任务约 10 分钟。回收条件定为「**到期且 presence 判离线**」：在岗期间服务端续租、永不过期（这才是 D3=a 要解决的 29 任务 0 完成 / 8 次 `lease_expired`），一旦判离线就立刻回队让别人接手，恢复更快而不是更慢。
- **续租发生在「到期那一刻」，不是每轮清扫**：清扫器 5s 一跳，但只改写**已经到期**的租约，续一次再管一个 TTL，所以每条在途任务最多每 5 分钟写一次盘、推一次 IPC。续租**不写事件**（自动续租是常态，写进事件流只会把 2000 条上限里的真实历史挤出去）、**不动 `task.updatedAt`**（它不是任务进展，不该把任务顶到列表最前）；只 `bumpRevision` 让事务落盘。
- **`activeLease` / `activeReviewLease` 在岗即续**，这就是任务书要的「`progress / submit / fail` 同样续租」，顺带消掉清扫间隙的竞态：租约刚到期、清扫器还没跑到，持有者自己来写时不该被 `lease_expired` 拦住——但仍以 presence 为准，离线持有者拿着合法 token 也写不进去。
- **`renew` 退化为兼容 no-op**：`renewLease / renewReview` 仍校验归属并返回当前到期时刻，不再接受自定义 ttl（`ttlSeconds` schema 描述改为「已废弃且不再生效」，两个 handler 不再解构它），阶段 4 从工具面删除；`docs/TASK-MCP.md` 的工作流链路去掉 `renew*`，改为说明租约自动续。
- **一个有意的后果**：在岗但卡住的 Agent 不再被租约超时「自动解救」，任务会一直挂在它名下。这正是 D3=a 的取舍——presence 是真相，超时不是。卡死是另一种故障，走 2A 的 `sweepMemberAttention`（席位确认离线通知 lead）与用户随时可取消任务，不该由租约超时兼职。

***

## 8. 进度日志（每完成一步追加，最新在下）

| 时间 | 模块 | 完成内容 | 验证 |
|---|---|---|---|
| 09-13 | 文档 | 建立本任务书；三项决策点待用户拍板 | 只读，无代码改动 |
| 09-14 | 决策 | 用户拍板 D1 = a（系统全自动）、D2 = b（lead 可选）、D3 = a（lease 服务端自动续）——见 ROADMAP | — |
| 09-16 14:50–15:30 | 2A | （CH-1）四个提交：① `plan_policy` 列（additive + 默认 lead_only，列存在性守卫，不升 schema）、`TeamGroup.planPolicy`、`defaultGroupPlanPolicy` / `groupMembersMayPlan`、身份解析对「无 lead + any_member」组的每个成员叠加主控能力、`setGroupPlanPolicy`（事件 `plan_policy_updated`）+ 服务层（只在成员规划权真的变化时发 notice）+ IPC `team-group:set-plan-policy`、`CreateTeamGroupInput.planPolicy`；② 编排边界：`TeamOrchestrator` 删 lead【系统预警】、`TeamCollaborationSweeper.sweepUnanswered` 删 lead【清扫提醒】抄送、新增 `TaskDispatcher.notifyOutcome`（done / failed → lead，`taskId:status:attemptCount` 幂等）与 `sweepMemberAttention`（成员确认离线 → lead，按离线周期一次）；③ 简报重写（lead 只规划 / 答用户 / 汇总上报；成员不再手写上报；无 lead 组按 `membersMayPlan` 说明谁能规划）、`team_task` 描述去掉「plan（主控专用）」；④ 桌面建任务入口 `TeamGroupService.planGroupTasks` → `TaskPoolService.planTasks` → 同一 `pool.plan`，校验口径同 Agent 侧，IPC `team-group:plan-tasks`。文档：`docs/ARCHITECTURE.md`（依赖规则、会话池一节、09-16 条目）、`docs/TASK-MCP.md`（Who plans / 唯一调度者） | 新增 / 改写测试见 ARCHITECTURE 09-16 条目「Verification」；全量 193 文件 / 1930 用例（`brand-migration` 在本机 Node 22 下因 vitest 无法打包 `node:sqlite` 失败，属环境问题，CI Node 24 不受影响）、typecheck 全绿 |
| 09-16 16:00–20:50 | 2B-1 | （CH-1 起、CH-3 接手收尾）提交 `7fb9a5f`：团队 run 的创建 / 启动路径退役。① 仓储 schema v8→v9：归档全部未结束的 legacy 团队 run（绑定标 failed + `archived: legacy team run` 文案，围栏据此 `run_completed`）与被取代的旧 running 独立 run，兜底把 `draft / ready / launching / attention / paused` 全部改 completed，幂等；删 `updateRunGoal / beginLaunch / ensureRunLaunching / recordLaunchDelivery`、`migrate()` 末尾 `ready→draft` 修复、`recordAgentCheckIn` 内的自愈 / 全员签到推进（非 running 一律 `run_completed`）；`completeRun / setActingLead` 只作用于 running。② 服务层 `configureIndependentWorkspace → createSessionPool`（替换当前任意 run），删 `ensureWorkspace / configureWorkspace / createNextRun / updateGoal / launch / ensureRunLaunched / settleAgentSessionLaunch / transferLead / clearActingLead` 与启动在途守卫。③ 启动提示只剩 solo 一种（删 `buildTeamLaunchHint`）。④ IPC / API / preload 删 `prepare-detected-workspace / choose-workspace / create-team / next-run / prepare-active-setup / update-goal / launch` 与 `TeamSetupDraft / CreateTeamInput / ChooseTeamWorkspaceResult`；`resolveTeamSetupMembers` 删除。⑤ MCP `team_run start` 恒 `not_applicable`；`transfer_lead` 要求 running。⑥ 渲染层删 `TeamSetupPage / RunModeSwitch / RunTeamPanel / team-setup.css / team-skill-defaults / TeamIcon / SoloIcon`，`run-view / RunPage / RunHeader / RunSeats` 池化（三个 phase，归档团队 run → 开始页 + `.run-start__note`），清理死 CSS；preview 与两份 smoke 改为「池 + 组」。⑦ `createDefaultTeamBundle` 迁入 `tests/legacy-team-fixtures.ts`。偏差与 2B-2 清单见 §3.4。文档：`docs/ARCHITECTURE.md`（运行模式一节、围栏、运行页、09-16 2B-1 条目）、`docs/TASK-MCP.md`（`team_run start`、会话池一节）、ROADMAP 状态 | 全量 190 文件 / 1885 用例（1884 通过 + 1 skipped；`brand-migration` 同上环境问题），typecheck、knip、`npm run build`、`smoke:mcp`（sessionPool / groupScoped / 围栏 / 重启续接全 true）、`smoke:channel`（九工具、回复门、围栏、入组简报全 true）全绿；新增 `team_run start → not_applicable` 测试 |
| 09-16 21:20–23:55 | 2B-2 | （CH-2 起、本席接手收尾）提交 `4a9fa47`：状态枚举收敛，模块 2B 完成。① domain：`TeamRunStatus = 'running' \| 'completed'`；删 `TeamLaunchStatus`、`RuntimeBinding.launchStatus / launchCommandId`、`TeamRun.launchedAt`、readiness `launching / attention`、preflight `goalDefined / agentsWaiting / canLaunch`；`acknowledgedAt` = 首次签到（COALESCE，重复签到只刷 `last_check_in_*`）；删死导出 `ALL_TEAM_CAPABILITIES` / `hasOpenReplySync`。② v9 修正（发货前）：归档 run 按 completeRun 语义撤销注册 + 写归档备注（stale pool 拿到 `RUN_ARCHIVED_STALE_POOL_DETAIL`）；全表 `launch_status` 归位 `not_started`、`launch_command_id` 清 NULL。③ `team-failover-service` 345→89 行：只剩「活动 run completed → closeRun 一次（订阅回放补启动、onerror 上报 + 重试）」+ 手动交接门面；删全员离线收尾 / standby 接替 / lead 自动转移 / `reconcileAcknowledgements`；`TeamHandoffService.automatic` 删除。④ 消费端两态化：`readinessOf` 认 `acknowledgedAt`、`verifyAgentRuntime` 删 `requiresCursorEvidence`、usage collecting = running、协作 / 任务写门只拒 completed、`upsertWorkspaceTeam` / `recordInstallation` 不再改 run 状态、MCP 简报仅组席位（`buildTeamRoleBriefing.group` 必填）。⑤ 渲染层：删 `team-dashboard-view`（连测试）、App.tsx `reviving` 映射、`handoff-entry` / `team-collaboration-view` / preview 场景两态化。⑥ 测试：`team-failover.test.ts` 重写 1069→291 行；v9 用例断言撤销注册 + 归一化（raw SQL 核对）；约 30 个夹具删旧字段与旧状态取值。决策与偏差见 §3.4。文档：`docs/ARCHITECTURE.md`（2B-2 条目）、`docs/TASK-MCP.md`（签到语义、legacy run 围栏、launch hint、session 令牌措辞）、ROADMAP 状态 | 全量 189 文件 / 1859 用例（1858 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip、`npm run build`、`smoke:channel`、`smoke:mcp` 全绿 |
| 09-16 23:47–09-17 15:00 | 2C | （本席起、席位重建后新会话接手收尾）提交 `b141c05`：席位重建 / 会话交接与组，模块 2C 完成。① 重建通知：`TeamControlService.recordComposerBinding` 在 changed（仓储只在 `composer_id IS NULL` 时写入，即「无 Composer → 有」）且席位在 active 组内时写 `member_rejoined_after_rebuild`（`recordGroupMemberRebuilt`，actor `system`）+ 补投 `joined` 通知；`groupLeadLabel` 抽到 domain；服务新增 `onerror` 选项。② 成员身份迁移：仓储 `transferGroupMembership`（一条事务：`leaveMember(A)` → `joinMembers([B], 同角色模板)` → 指向 A 的 lead / acting lead 指针改指 B → `team_failovers` 审计行 `manual_membership_transfer` / completed；`transferredLead` = 有效 lead 曾是 A）；`TeamGroupService.transferMembership`（与移出成员共用 `settleDeparture`：释放租约与验收、待回应消息标孤儿；通知 A left、B joined、有效 lead 随迁时 B 再收 lead_changed；第三方有效 lead 收团队 notice）与 `membershipTransferOptions`（源须在 active 组内，候选 = 全部独立席位，不看在线）。③ 删除：`TeamHandoffService`、仓储 `rebindSlotToStandby / rebindSlotFromMember / attachFailoverContext / updateFailoverStatus`、`TeamFailoverRebindResult`、`createTakeoverCapsule` / `TeamTakeoverCapsule`、`ManualTeamHandoff*` 类型；`TeamFailoverService` 只剩 run 收尾。④ `manualHandoffWithContext → transferMembershipWithContext`（顺序不变）；IPC 通道名不变、入参改 `groupId / fromSlotId / toSlotId`、接 `TeamGroupService`；API / preload `getMembershipTransferOptions / transferMembership`；`ManualHandoffDialog` 改成员身份迁移语义（候选全部可选、在线 / 离线标签、结果页含角色 / 目标通道 / lead 随迁 / 释放任务）；`handoff-entry` roles 措辞；preview `?handoff=1` mock 重写。决策与偏差见 §4.4。文档：`docs/ARCHITECTURE.md`（会话池一节、围栏一节、2C 条目）、ROADMAP 状态 | `team-control-service` +1（重建事件序列：首绑静默、重建后恰一条 joined + 审计事件、group_id 不变、令牌已轮换、重复上报 / 换绑返回 false 不再投递、独立席位静默）、`team-groups-repository` +4（事务全貌 + 绑定前后一致、lead / acting lead 随迁含「名义 lead 另有临时主控 → transferredLead=false」、拒绝原子性、`recordGroupMemberRebuilt`）、`team-group-service` +3（租约释放 / 任务回队 / 身份切换 / 通知 / lead notice；lead 随迁通知序列 left / joined / lead_changed(B)；选项与池结束拒绝）、`manual-handoff-with-context` 重写 5 例、`manual-handoff-dialog` / `app-handoff-entry` 适配、`team-failover` 删门面用例；全量 189 文件 / 1866 用例（1865 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip、`npm run build`、`smoke:channel`、`smoke:mcp` 全绿 |
| 09-17 14:52–17:15 | 2D | （本席起、席位重建后新会话接手收尾）提交 `125daee`：continuity 按池模型整体退役，模块 2D 完成。① 动工前通读查明 `TeamContinuityService.restore()` 从未有生产调用方（初始提交只有只读 `team-continuity:get / snapshot` IPC，08-30 删除；唯一读者 `createTakeoverCapsule` 已随 2C 删），`capture()` 是无人读的只写日志；池模型下单席恢复 = 换席重建 + 上下文交接 + 入组通知 + `team_check_in` 实时简报，团队快照没有使用场景。三选一（A 退役 / B 保留只写检查点 / C 按任务书实现 + 新入口）报用户，用户选 A。② 删除 `TeamContinuityService`、`TeamContinuityRepository` / `SqliteTeamContinuityRepository`、`domain/team-continuity.ts`、`registerTeamContinuityIpc`、`tests/team-continuity.test.ts`、preview `continuitySnapshot`（约 1000 行）；`main/index.ts` 不再构造第四个仓储与 capture watcher。③ `SqliteTeamControlRepository.migrate()` 末尾按存在性 DROP `team_restore_members / team_restore_operations / team_checkpoints / team_continuity_meta`（自子向父、`IF EXISTS` 幂等、不升 schema 版本）。④ 成员身份迁移 IPC 归位：`team-continuity:handoff-options / handoff` → `team-group:transfer-options / transfer-membership`，由 `registerTeamGroupIpc` 注册（新增 `transferContext` 端口参数），校验复用 `requiredString / objectOf`，迁移受一键创建守卫、候选查询不受；`manual-handoff-with-context.ts` → `membership-transfer-with-context.ts`。⑤ README 去掉「自动检查点 / 一键恢复」。决策与偏差见 §5.1。文档：`docs/ARCHITECTURE.md`（「Team continuity」一节改写为「Recovery in the pool model」、会话池一节的 deferred 列表、2D 条目）、ROADMAP 状态 | `register-team-group-ipc`（迁移候选归一化、带 / 不带上下文的迁移与回包、上下文解析失败以 `contextHandoff.ok=false` 报告、形状拒绝、一键创建守卫、dispose）、`sqlite-team-control-repository` +1（旧表含外键与行播种 → 四表删除、现役 run / 绑定与数据不变、再次打开无操作）；全量 188 文件 / 1865 用例（1864 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip、`npm run build`、`smoke:channel`、`smoke:mcp` 全绿 |
| 09-17 17:43–18:55 | 2E | （CH-3 起、席位重建后两次接手收尾）用量按组 / 按会话，模块 2E 完成。① 账本生命周期改由「席位 ↔ Composer 绑定」驱动：删 `cursorUsageRunDecision` / `CursorUsageRunState` / `reset(runId)` / `stamp` / 随行 `runId` / `usageBelongsToRun`，新增 `setBoundComposers({composerId, slotId}[])`——出绑封口（`frozenAt`，迟到事件不再入账）、在绑且采集中解冻续记（账本连续不双计）、封口且超 `USAGE_HISTORY_RETENTION_MS` 的裁掉、在绑的不裁；构造函数 `reconcileLedgers()` 先把落盘账与当前「绑定 × 采集」对齐再裁旧。② 入账资格收进 tracker 一处（`observe` 的 `isBound`）：主进程删 `usageComposerIds` 与三处过滤，改 `boundComposersOf(snapshot)`；`collecting` 只由显式结束（`onRunEnded` 补收最后一笔后 `setCollecting(false)`）与新池出现驱动。③ `slotId` 取代 `runId` 成为随行标签（`projectUsage` / `reduceUsage` / `upgradeUsageEstimate` 透传），席位 id 含每池新生成的 `runKey`，故同池重建的旧账归回本席位、换池的落「历史会话」；`cursor-usage-store` 行上 `runId → slotId`、文件顶层 `runId` 去掉、旧 `runId` 读入忽略，`STORE_VERSION` 仍 4（不强迫新旧构建互升）。④ 渲染层三层求和：`App` 徽章只认 `session.composerId`（不再回退 `telemetryChannelComposerId`），投影 `statsSeats.slotId` 与 `statsGroups`；`stats-view` 归属链 = 当前 composer → 账上 `slotId` → 历史会话（后者在明细标「· 旧会话」），新增 `StatsGroupSource / StatsGroupRow` 与组求和（不随席位筛选收窄、按成本降序）；`SettingsStats` 新增「分组」卡（条宽 = 占池份额，无 active 组不出卡），CSS 与「模型分布」共用行式布局；preview `?stats=1` 补两个 active 组 + 一个带席位标签的重建前 Composer。决策与偏差见 §6.1。文档：`docs/ARCHITECTURE.md`（2E 条目、会话池一节 deferred 列表）、任务书状态头 + §6.1、ROADMAP 状态 | `cursor-usage-tracker` 重写 run 相关 6 例为绑定语义（同池两次重建 → 三个桶且旧桶封口 / 迟到不入账、只有在绑入账与「不给绑定集合 = 不限定」、显式结束全部封口且重推同一绑定不解冻、出绑再入绑解冻续记、启动对齐补封 / 解冻、保留窗口裁旧与在绑不裁）、`cursor-usage` 席位标签随行、`cursor-usage-store` 3 例改 `slotId` 往返与旧 `runId` 忽略、`cursor-usage-pipeline` 改绑定驱动；新增 `stats-view` +3（`slotId` 归属与「旧会话」标注、组 = 成员席位之和且不随筛选收窄、池 = 组之和 + 历史、无组来源时组层为空）、`settings-stats` +2（分组卡排序 / 席数 / 份额条 / 无组不出卡、度量切换）；全量 188 文件 / 1873 用例（1872 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip（`lint:dead`）、`npm run build`、`smoke:mcp`、`smoke:channel` 全绿 |
| 09-17 18:57–19:40 | 2F | （CH-3）任务板 lease 语义修正，模块 2F 完成，阶段 2 收口。① 在岗判定下沉到 domain：新增 `TaskPoolDependencies.holderOnline`，`reclaimExpired()` 只在「到期 **且** 持有者已判离线」时回收，在岗则由服务端续到 `now + DEFAULT_LEASE_TTL_MS`；实现与验收租约同一口径。只改清扫器是假修——`leaseNext / leaseTask / leaseReview` 内部也调 `reclaimExpired()`，而这三条跑在 MCP 进程。② 两处注入同口径：主进程 `TaskPoolService(repository, teamControlService, holderOnline)` 用席位 `runtime.online`，MCP `src/mcp/index.ts` 用 `bindings → getPresence(channelId) → isPresenceOnline`；缺省 `() => false` 保持旧行为。两个服务的写事务统一走各自的 `transact()` 帮手带上依赖。③ `activeLease / activeReviewLease` 在岗即续（这就是「progress / submit / fail 同样续租」，并消掉清扫间隙竞态），离线持有者拿合法 token 也写不进。④ `renewLease / renewReview` 退化为兼容 no-op（仍校验归属、回当前到期时刻，不再接受自定义 ttl），`team_task` / `team_review` 的 `ttlSeconds` schema 标注「已废弃且不再生效」，阶段 4 从工具面删。⑤ 续租不写事件、不动 `task.updatedAt`，只 bumpRevision——每条在途任务最多每 TTL 落一次盘。决策与偏差（含「不再叠第二层 5 分钟离线窗口」）见 §7.3。文档：`docs/TASK-MCP.md`（工作流链路去掉 renew*、补租约自动续一段）、`docs/ARCHITECTURE.md`（2F 条目）、任务书状态头 + §7.3、ROADMAP 状态 | `task-pool` +5（在岗到期只续不回收且不写事件 / 不顶 task.updatedAt、再清扫是纯读；持有者自写顺手续租 + renew no-op；离线到期回收 → 回队 → 另一席位重新领取、旧 token 写不进；验收租约同一口径；未注入端口时仍「到期即回收」）、`task-pool-service` +1（清扫器续租 / 回收的服务级接线，含快照推送）；全量 188 文件 / 1879 用例（1878 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip（`lint:dead`）、`npm run build`、`smoke:mcp`（含完整 claim→done 生命周期）、`smoke:channel` 全绿 |
| 09-17 19:05–翌日 00:20 | 合并基线 | （CH-3 起、席位重建后新会话接手收尾）阶段 2 推送后发现 main 自 `8e752ff` 以来前进 32 个提交且正压在阶段 3 要改的文件上（`SessionSidebar` / `RunPage` / `RunSeats` / `run.css`）；用户拍板「先把 main 合进 phase2、再合进 phase3，名册分区切片对齐后重做」。`git merge main`（`72396ae`）：146 文件 +12659/−2850，12 处冲突按同一规则解——main 往阶段 2 已删的结构上加的功能，移植到阶段 2 的结构上（`RunPage` 批次会话配置 / 「和上一批一样再来一批」全量保留，去掉 `view.mode` 守卫；`RunSeats` 光晕与「单独配置」保留、删已退役的 `guided` refs）；两边各删一半的，两边的删除都成立（`main/index.ts` 的 `onAllTriggered` 同时去掉 `plan.origin` 守卫与 `onFinished`；`prepareComposerRelaunch` 的 `allowIdleOnline` 随席位自动轮换退役）。测试按同一规则改写（`run-page` 沿用数量断言改为 2 / 1，`startMode` 渲染去参，「团队切独立」改为「归档旧团队 run 不作为上一批」；`team-control-service` 用 `poolFixture` / `patchSession` 表达 main 的离线专属语义）。合并孤儿 `lobby/FlowStatusIcon.tsx`（两边各删一个消费者）连同 CSS / keyframes 删除，`.run-seats__guide` 死 CSS 删除。worktree 补装 `electron-updater`（lockfile 未变）。 | typecheck、knip、build、`smoke:mcp`、`smoke:channel`；全量 206 文件 / 2085 用例（2083 通过 + 2 skipped；`brand-migration` 因 main `851f092` 改在 node 下跑而转绿） |
