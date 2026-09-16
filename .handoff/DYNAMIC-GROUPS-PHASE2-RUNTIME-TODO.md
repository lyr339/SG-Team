# 交接任务书：会话池 + 动态分组 · 阶段 2 运行时语义收口

> **状态（2026-09-16）：2A、2B-1 已落地（分支 `feat/dynamic-groups-phase2`，worktree `E:\SG-phase2`，基于 main `8e752ff`）；2B-2（状态枚举收敛）与 2C–2F 待动工。** 路线图见 `DYNAMIC-GROUPS-ROADMAP.md`。
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
| `TeamContinuityService.restore` 不恢复组 | 阶段 1 §4.5 | 恢复组结构（2D） |
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

***

## 5. 模块 2D · 检查点与恢复按组

- `TeamContinuityService.capture()`：payload 增加 `groups: [{ group, members: [{ slotId, roleKey, capabilities }], leadSlotId, actingLeadSlotId }]`（阶段 1 只加字段，此处补齐语义：内容去重哈希纳入 groups）。
- `restore(checkpointId)`：恢复组结构 = 对差异执行 `createGroup / addGroupMembers / removeGroupMember / setGroupLead`（复用阶段 1 API，走同一通知管线）；`createTakeoverCapsule` 按组生成胶囊（组目标、组内任务、组内未读）。
- 一键恢复的「完成」判定沿用现状（每个成员回应关联消息），范围改为「组内成员」。

测试：捕获 → 解散组 → 恢复 → 组与成员回到捕获时状态，成员各收一条 joined；未变化状态哈希去重仍成立。

***

## 6. 模块 2E · 用量按组 / 按会话

- 现状：`CursorUsageTracker` 以 `usageRunId` 为账本键，新 run 清零、`endActiveRun` 冻结。池 run 长生命周期后只增不清。
- 改动：账本键改为 `composerId`（会话生命周期 = Composer 生命周期），聚合视图按「席位 / 组 / 池」三层由渲染层求和；`cursor-usage.json` 存储按 `composerId` 分桶，`endActiveRun`（结束全部会话）冻结全部；席位重建（新 Composer）自然开新桶，旧桶只读保留 N 天。
- `cursorUsageRunDecision` 删除（无 run 切换语义）；`usageComposerIds` 仍来自池 run 绑定。

测试：同池两次席位重建 → 三个桶；组求和 = 成员桶之和；`endActiveRun` 后所有桶 `collecting=false`；重启回放幂等。

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

***

## 8. 进度日志（每完成一步追加，最新在下）

| 时间 | 模块 | 完成内容 | 验证 |
|---|---|---|---|
| 09-13 | 文档 | 建立本任务书；三项决策点待用户拍板 | 只读，无代码改动 |
| 09-14 | 决策 | 用户拍板 D1 = a（系统全自动）、D2 = b（lead 可选）、D3 = a（lease 服务端自动续）——见 ROADMAP | — |
| 09-16 14:50–15:30 | 2A | （CH-1）四个提交：① `plan_policy` 列（additive + 默认 lead_only，列存在性守卫，不升 schema）、`TeamGroup.planPolicy`、`defaultGroupPlanPolicy` / `groupMembersMayPlan`、身份解析对「无 lead + any_member」组的每个成员叠加主控能力、`setGroupPlanPolicy`（事件 `plan_policy_updated`）+ 服务层（只在成员规划权真的变化时发 notice）+ IPC `team-group:set-plan-policy`、`CreateTeamGroupInput.planPolicy`；② 编排边界：`TeamOrchestrator` 删 lead【系统预警】、`TeamCollaborationSweeper.sweepUnanswered` 删 lead【清扫提醒】抄送、新增 `TaskDispatcher.notifyOutcome`（done / failed → lead，`taskId:status:attemptCount` 幂等）与 `sweepMemberAttention`（成员确认离线 → lead，按离线周期一次）；③ 简报重写（lead 只规划 / 答用户 / 汇总上报；成员不再手写上报；无 lead 组按 `membersMayPlan` 说明谁能规划）、`team_task` 描述去掉「plan（主控专用）」；④ 桌面建任务入口 `TeamGroupService.planGroupTasks` → `TaskPoolService.planTasks` → 同一 `pool.plan`，校验口径同 Agent 侧，IPC `team-group:plan-tasks`。文档：`docs/ARCHITECTURE.md`（依赖规则、会话池一节、09-16 条目）、`docs/TASK-MCP.md`（Who plans / 唯一调度者） | 新增 / 改写测试见 ARCHITECTURE 09-16 条目「Verification」；全量 193 文件 / 1930 用例（`brand-migration` 在本机 Node 22 下因 vitest 无法打包 `node:sqlite` 失败，属环境问题，CI Node 24 不受影响）、typecheck 全绿 |
| 09-16 16:00–20:50 | 2B-1 | （CH-1 起、CH-3 接手收尾）提交 `7fb9a5f`：团队 run 的创建 / 启动路径退役。① 仓储 schema v8→v9：归档全部未结束的 legacy 团队 run（绑定标 failed + `archived: legacy team run` 文案，围栏据此 `run_completed`）与被取代的旧 running 独立 run，兜底把 `draft / ready / launching / attention / paused` 全部改 completed，幂等；删 `updateRunGoal / beginLaunch / ensureRunLaunching / recordLaunchDelivery`、`migrate()` 末尾 `ready→draft` 修复、`recordAgentCheckIn` 内的自愈 / 全员签到推进（非 running 一律 `run_completed`）；`completeRun / setActingLead` 只作用于 running。② 服务层 `configureIndependentWorkspace → createSessionPool`（替换当前任意 run），删 `ensureWorkspace / configureWorkspace / createNextRun / updateGoal / launch / ensureRunLaunched / settleAgentSessionLaunch / transferLead / clearActingLead` 与启动在途守卫。③ 启动提示只剩 solo 一种（删 `buildTeamLaunchHint`）。④ IPC / API / preload 删 `prepare-detected-workspace / choose-workspace / create-team / next-run / prepare-active-setup / update-goal / launch` 与 `TeamSetupDraft / CreateTeamInput / ChooseTeamWorkspaceResult`；`resolveTeamSetupMembers` 删除。⑤ MCP `team_run start` 恒 `not_applicable`；`transfer_lead` 要求 running。⑥ 渲染层删 `TeamSetupPage / RunModeSwitch / RunTeamPanel / team-setup.css / team-skill-defaults / TeamIcon / SoloIcon`，`run-view / RunPage / RunHeader / RunSeats` 池化（三个 phase，归档团队 run → 开始页 + `.run-start__note`），清理死 CSS；preview 与两份 smoke 改为「池 + 组」。⑦ `createDefaultTeamBundle` 迁入 `tests/legacy-team-fixtures.ts`。偏差与 2B-2 清单见 §3.4。文档：`docs/ARCHITECTURE.md`（运行模式一节、围栏、运行页、09-16 2B-1 条目）、`docs/TASK-MCP.md`（`team_run start`、会话池一节）、ROADMAP 状态 | 全量 190 文件 / 1885 用例（1884 通过 + 1 skipped；`brand-migration` 同上环境问题），typecheck、knip、`npm run build`、`smoke:mcp`（sessionPool / groupScoped / 围栏 / 重启续接全 true）、`smoke:channel`（九工具、回复门、围栏、入组简报全 true）全绿；新增 `team_run start → not_applicable` 测试 |
| 09-16 21:20–23:55 | 2B-2 | （CH-2 起、本席接手收尾）提交 `4a9fa47`：状态枚举收敛，模块 2B 完成。① domain：`TeamRunStatus = 'running' \| 'completed'`；删 `TeamLaunchStatus`、`RuntimeBinding.launchStatus / launchCommandId`、`TeamRun.launchedAt`、readiness `launching / attention`、preflight `goalDefined / agentsWaiting / canLaunch`；`acknowledgedAt` = 首次签到（COALESCE，重复签到只刷 `last_check_in_*`）；删死导出 `ALL_TEAM_CAPABILITIES` / `hasOpenReplySync`。② v9 修正（发货前）：归档 run 按 completeRun 语义撤销注册 + 写归档备注（stale pool 拿到 `RUN_ARCHIVED_STALE_POOL_DETAIL`）；全表 `launch_status` 归位 `not_started`、`launch_command_id` 清 NULL。③ `team-failover-service` 345→89 行：只剩「活动 run completed → closeRun 一次（订阅回放补启动、onerror 上报 + 重试）」+ 手动交接门面；删全员离线收尾 / standby 接替 / lead 自动转移 / `reconcileAcknowledgements`；`TeamHandoffService.automatic` 删除。④ 消费端两态化：`readinessOf` 认 `acknowledgedAt`、`verifyAgentRuntime` 删 `requiresCursorEvidence`、usage collecting = running、协作 / 任务写门只拒 completed、`upsertWorkspaceTeam` / `recordInstallation` 不再改 run 状态、MCP 简报仅组席位（`buildTeamRoleBriefing.group` 必填）。⑤ 渲染层：删 `team-dashboard-view`（连测试）、App.tsx `reviving` 映射、`handoff-entry` / `team-collaboration-view` / preview 场景两态化。⑥ 测试：`team-failover.test.ts` 重写 1069→291 行；v9 用例断言撤销注册 + 归一化（raw SQL 核对）；约 30 个夹具删旧字段与旧状态取值。决策与偏差见 §3.4。文档：`docs/ARCHITECTURE.md`（2B-2 条目）、`docs/TASK-MCP.md`（签到语义、legacy run 围栏、launch hint、session 令牌措辞）、ROADMAP 状态 | 全量 189 文件 / 1859 用例（1858 通过 + 1 skipped；`brand-migration` 同上环境问题）；typecheck、knip、`npm run build`、`smoke:channel`、`smoke:mcp` 全绿 |
