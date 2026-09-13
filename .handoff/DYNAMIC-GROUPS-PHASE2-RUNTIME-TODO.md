# 交接任务书：会话池 + 动态分组 · 阶段 2 运行时语义收口

> **状态（2026-09-13）：待动工；依赖阶段 1（`DYNAMIC-GROUPS-HANDOFF-TODO.md`）落地。** 路线图见 `DYNAMIC-GROUPS-ROADMAP.md`。
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
