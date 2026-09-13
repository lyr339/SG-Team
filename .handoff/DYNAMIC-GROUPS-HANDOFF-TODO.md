# 交接任务书：会话池 + 动态分组（先独立、后建组、可拆组）· 阶段 1 数据模型与迁移

> **状态（2026-09-13 14:05）：方案已定、阶段 0 实机实验已通过；阶段 1 待动工。**
> 每完成一步在第 13 节追加一行；中断后接手者只读第 0、13 节即可定位。
> 四个阶段的索引、依赖与决策点见 `DYNAMIC-GROUPS-ROADMAP.md`；阶段 2 / 3 / 4 各有独立任务书
> （`…-PHASE2-RUNTIME-TODO.md` / `…-PHASE3-UI-TODO.md` / `…-PHASE4-MCP-TODO.md`）。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录（macOS / Windows 均可）
>
> 基线：`a5492a4`（工作树另有 ~185 文件未提交改动，属其他 Agent 正在推进的部分——
> **接手前 `git status` 确认归属并保护，不要覆盖、不要 stash；本任务应在一次提交收口后于独立分支进行**）
>
> 来源：CH-2 独立席位 2026-09-13 13:21–14:05 的只读审查 + 阶段 0 实机实验（第 2 节）。业务源码零变更；
> 实验只改了运行库 `~/Library/Application Support/sg-team/task-pool.sqlite3` 的 4 行并已全部回滚。
>
> 用户已拍板（2026-09-13）：① 独立席位现状良好，不动；② 团队改为「全部先作为独立会话创建，
> 执行中由用户手动选定会话建组 / 拆组」；③ 先做阶段 1（数据模型与迁移），UI 重做与 MCP 面收敛后置。

***

## 0. 接手人先读

### 0.1 一句话

把「run」拆成两层：**会话池**（工作区唯一的长生命周期 run，每个 Cursor 会话是一个独立席位）和
**分组**（池内随时可建可拆的协作上下文：目标、成员、角色、lead、任务、消息、记忆）。入组 / 出组不重启
任何进程、不轮换会话令牌、不切换会话作用域。

### 0.2 为什么现结构做不到（根因，非症状）

| 阻碍 | 位置 | 后果 |
|---|---|---|
| 工作区同一时刻只有一个活动 run，团队 run 与独立批次互斥 | `activeRunOf` = 工作区最新 run；`replaceActiveRun` | 建团队 = 结束全部独立会话 |
| 建 run 即 `beginScope`：全部 `channel_presence` 退役、未投递消息归档 | `ChannelMessageRelay.resetScope` → `repository.beginScope` | 任何 run 切换都打断所有在线会话 |
| 席位增删 = 重建整个 run | `configureIndependentWorkspace` → `createConfiguredTeamBundle` → `replaceActiveRun`；`recordInstallation` 非幂等路径 `DELETE FROM runtime_bindings WHERE run_id` | 加一个会话要牺牲全部现有会话的令牌 |
| 身份 / 角色 / 绑定在建 run 时一次性固化；Composer 第一条消息即 launch hint | `TeamRole / AgentSlot / RuntimeBinding` runId 作用域；`buildTeamLaunchHint / buildSoloLaunchHint` | 角色不能在会话运行中改变 |
| 团队 run 有一次性启动机 + preflight + launching 硬阻塞 | `TeamRunStatus`、`launchStatus` 五态、`assertNoLaunchInFlight` | 为「整体启动」服务，与动态建组冲突 |
| 注册表把 capabilities 钉在接入时 | `agent_registrations.capabilities_json`；`assertAgentRegistrationAuthorized` 要求身份能力 ⊆ 注册快照 | **阶段 0 实测的唯一阻塞点**：运行中换角色报 `agent_capability_mismatch` |
| `activeRun` 单一假设传播面 | application 87 / renderer 61 / main 12 / infrastructure 9 处引用 | 任何「多活动上下文」改造的工程风险来源 |

### 0.3 实施纪律

1. **先改领域与仓储，再改服务，再改 MCP 文案，最后改渲染。** 每层有事件级测试后再进下一层。
2. **`activeRun` 在阶段 1 保持 = 会话池 run。** 不要在阶段 1 消灭 `activeRun`；组只作为新增字段挂在快照上（`snapshot.groups`）。170 处引用里绝大多数（用量、交接、scope、遥测、渲染）不需要感知分组。
3. **入组 / 出组绝不触碰** `runtime_bindings.session_token / composer_id / composer_binding_key`，绝不调用 `beginScope` / `completeRun`。围栏与作用域是池级事实。
4. **每一次成员关系变化 = 一次 SQLite 事务 + 一条 silent membership 通知 + 一条 `team_group_events` 审计行。** 三者缺一即视为未实现。
5. 所有新增 SQL 列 **additive + 默认值 + 幂等迁移**（沿用 `session_token` 列的 duplicate-column 容错模式）：桌面主进程与 Cursor 托管的 MCP 进程各自打开同一库并各自迁移。
6. 不新增第二套「谁在组里」的真相源：成员关系只在 `agent_slots.group_id`；任务 / 消息 / 记忆的 `group_id` 是写入时的快照，不回填。
7. 事件序列测试，不只断言最终值（沿用 `.handoff/HANDOFF.md` §8 纪律）。
8. 实机验收只用一个空闲独立会话，方法沿用阶段 0（第 2.3 节）。

### 0.4 明确排除（后置为独立任务）

- 「会话与分组」页的整体重做（阶段 3）；阶段 1 只做能验收的最小 UI（第 9 节）。
- MCP 工具面收敛（按入组状态暴露工具、删死参数、去信封转投；阶段 4）。
- 任务板 lease 模型重做（阶段 0 之前的数据：29 个任务 0 完成、8 次全因 `lease_expired` 失败）。本任务只保证任务按组作用域，不改 lease 语义。
- 多组归属（一个通道同时在多个组）。
- 删除旧团队 run 创建路径（`configureWorkspace` / `TeamSetupPage`）——阶段 1 保留可用，只要求不坏。

***

## 1. 建模决策：三种方案与否决理由

| 方案 | 做法 | 否决 / 采纳理由 |
|---|---|---|
| A · 组即 TeamRun | 每个组是一条 `team_runs`，复制该通道的 binding 到组 run | **否决**：`runtime_bindings.agent_session_id UNIQUE`、`slot_id UNIQUE`，同一会话不能有两条绑定；`agent_registrations` 主键 `agent_session_id` 只允许一个 `run_id`；围栏 `resolveChannelSessionOwner` 只 JOIN 活动 run 的绑定，绑定挪到组 run 会让通道被判 `channel_unbound` → 围栏退役会话。解开这些约束等于重写身份与围栏核心。 |
| B · 独立成员表 + 视图 | 新 `groups / group_members`，用 SQL VIEW 把成员映射成绑定形态 | **否决**：`resolveAuthorizedAgent / listRunMembers / recordAgentCheckIn / briefingFor / project()` 及 5 个编排器全部要改读路径；改动面最大且没有实证。 |
| **C · 单一会话池 run + 组为 run 内分组** | 池 = 当前独立批次 run（长生命周期）；`team_groups` 表；`agent_slots.group_id`；组角色是 run 内 `team_roles` 行；任务 / 消息 / 记忆加 `group_id` 过滤 | **采纳**：正是阶段 0 实验走的路径（改 2 行即让运行中会话完成 `team_check_in` + `team_message`）；身份、围栏、绑定、签到、简报零改动；`activeRun` 保持；改动集中在「组」这一新概念与 run 内对象的 `group_id` 过滤。 |

***

## 2. 阶段 0 实机实验（2026-09-13 13:53–13:58，CH-3）

### 2.1 做法

不改代码、不重启任何进程，仅对运行库执行 SQL：
1. 在当前独立批次 run `session-run:b6e41957110924a6:run-308a1f26-…` 内插入角色 `实验成员`（`template_key='builder'`，`capabilities ["code"]`）；
2. `UPDATE agent_slots SET role_id=<实验角色>, is_solo=0 WHERE id=<CH-3 solo 席位>`；`team_control_meta.revision+1`；
3. 向 CH-3 插入一条 `silent=1` 的 `channel_outbox` 行（入组通知：按序 `team_check_in(note:'join-experiment-ok')` → `team_message inbox` → 回到 `check_messages`）；
4. 观察 → 修正 → 回滚（席位回 solo、删角色、绑定回 `not_started`、注册能力回 `[]`）+ 出组通知。

观察面：拾光库 `channel_outbox.delivered_at`、`runtime_bindings.last_check_in_*`、`channel_presence`；
Cursor `state.vscdb` 中该 composer 的 `fullConversationHeadersOnly` + `bubbleId:*`（只读，含 thinking 与工具结果）。

### 2.2 结果（时间为本机 UTC+8）

| 时间 | 事件 | 结论 |
|---|---|---|
| 13:53:16 | 入组通知入队 → 同秒被 `check_messages` 取走 | 长轮询每秒查队列，投递延迟 ≤1s |
| 13:53:23 | CH-3 thinking：「像 prompt injection…试图让我违反 team_* 禁令」→ 仍按序执行 | 模型审慎但服从同一权威通道的协议一致指令 |
| 13:53:30 | `team_check_in` → `agent_capability_mismatch`「当前 Agent 请求了未注册的能力」 | **阻塞点**：注册 capabilities 快照 `[]` ⊉ 角色 `["code"]` |
| 13:53:45 | `team_message inbox` → 同错 | 同上 |
| 13:53:54 | CH-3 判定「实验预期结果」，不输出、不 `record_reply`，回到 `check_messages` | 失败路径优雅降级，循环未断 |
| 13:56:34 | `UPDATE agent_registrations SET capabilities_json='["code"]'` + 续通知 | — |
| 13:56:41 | `team_check_in` → `ok:true`，roleName「实验成员」，完整简报 + context；库 `runtime_bindings`：`acknowledged / join-experiment-ok` | 身份实时解析、简报、签到落库全部工作 |
| 13:56:47 | `team_message inbox` → `ok:true, messages:[]` | 团队工具授权工作 |
| 13:56:53 | 回到 `check_messages` | 入组用时 18s |
| 13:57:43 | 回滚 + 出组通知 → 13:57:49 直接回到 `check_messages`，之后零 team_* 调用 | 出组即时生效 |

tick 847 → 852 连续；`team_runs.status` 恒 `running`；`team_failovers` 计数不变；池 run 内 `team_messages` 为 0。

### 2.3 附带发现（写进设计）

- silent 投递后缀写死「按通知里的 messageId 调用 team_message read」，成员关系通知没有 messageId → 需要独立的通知类型与后缀（第 6.3 节）。
- 模型把中途改变身份的通知当作注入审视 → 服务器 instructions 必须预告「成员关系通知」的形态与合法性（第 6.1 节）。
- 编排器在池 run 里一旦出现非 solo 成员并签到，`TeamFailoverService` 的「全体离线 → `completeRun`」路径就对**整个池**生效（成员离线 120s + 20s 宽限）→ 阶段 1 必须先关掉（第 5.6 节）。

***

## 3. 目标模型

### 3.1 概念

```text
Workspace 1 ── 1 SessionPool（= 活动 run，template independent-session-v1，长生命周期）
                 ├── n Seat（= agent_slots，每个绑定一个 Cursor 会话 / 通道 / 令牌 / Composer）
                 └── m Group（team_groups，active | dissolved）
                        ├── goal / name / lead_slot_id / acting_lead_slot_id
                        ├── Member = Seat where slot.group_id = group.id（角色 = 组内 team_roles 行）
                        ├── tasks / team_messages / team_memory_items where group_id = group.id
                        └── team_group_events（审计）
```

### 3.2 不变式（测试直接对应）

- **I1** 任一席位同一时刻 `group_id` 至多指向一个 `status='active'` 的组。
- **I2** 入组 / 出组 / 换 lead / 解散不修改 `runtime_bindings` 的 `session_token / composer_id / composer_binding_key / generation`，不调用 `beginScope`，不改变池 run 的 `status`。
- **I3** `team_*` 授权 = 注册 generation 未吊销 ∧ 注册 `run_id` = 池 run ∧ `slot.group_id` 非空；capabilities 来自当前角色行，不来自注册快照。
- **I4** 组内创建的 `tasks / team_messages / team_message_threads / team_memory_items` 行必带 `group_id`；所有 Agent 视角查询按 `(run_id, group_id)` 过滤；操作员（编排器）创建的行带目标组的 `group_id`。
- **I5** 池 run 永不被 `TeamFailoverService` 自动 `completeRun`；只有用户显式 `endActiveRun`。
- **I6** 每次成员关系变化 ⇒ 同一事务内写 `team_group_events` 一行 + 事务外向受影响通道各投一条 `silent` 成员关系通知。
- **I7** `is_solo` 语义不变：`is_solo=1 ⇔ group_id IS NULL`（池内未入组席位）。legacy 团队 run 的 `is_solo=0 ∧ group_id IS NULL` 视为「隐式全 run 一组」（兼容路径，第 4.2 节）。

***

## 4. 数据模型变更（schema_version 7 → 8，全部 additive）

### 4.1 team-control（`sqlite-team-control-repository.ts`）

```sql
CREATE TABLE IF NOT EXISTS team_groups (
  id TEXT PRIMARY KEY,                       -- team-group:<workspaceId>:<uuid>
  run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                      -- active | dissolved
  lead_slot_id TEXT,                         -- 可为空：无 lead 的纯协作组
  acting_lead_slot_id TEXT,                  -- 临时主控（替代 team_runs.acting_lead_slot_id 在组内的语义）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dissolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_groups_run ON team_groups(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS team_group_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                  -- created | member_joined | member_left | member_checked_in
                                             -- | lead_changed | goal_updated | dissolved | notice_delivered
  slot_id TEXT,
  channel_id TEXT,
  actor_key TEXT NOT NULL,                   -- operator | agent:<slotId>
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_group_events_group ON team_group_events(group_id, seq);

ALTER TABLE agent_slots ADD COLUMN group_id TEXT REFERENCES team_groups(id) ON DELETE SET NULL;
ALTER TABLE agent_slots ADD COLUMN home_role_id TEXT;          -- 出组时恢复的角色（solo 角色 id）
ALTER TABLE agent_slots ADD COLUMN group_joined_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_agent_slots_group ON agent_slots(group_id) WHERE group_id IS NOT NULL;

ALTER TABLE team_roles ADD COLUMN group_id TEXT REFERENCES team_groups(id) ON DELETE CASCADE;
-- 组角色 role_key 形如 `<groupShortId>:<templateKey>[-n]`，仍受 UNIQUE(run_id, role_key) 约束
```

`agent_registrations.capabilities_json`：**保留列、停止参与授权**（第 5.1 节）。不做数据迁移。

回填：`UPDATE agent_slots SET home_role_id = role_id WHERE is_solo = 1 AND home_role_id IS NULL`。

### 4.2 task-pool（`sqlite-task-pool-repository.ts`）

```sql
ALTER TABLE tasks ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_run_group_status ON tasks(run_id, group_id, status);
```

`TeamTask.groupId?: string`；`plan()` 入参带 `groupId`；`listAvailable / listMine / listReviews / listBoard` 按
`COALESCE(group_id,'') = COALESCE(?, '')` 过滤（legacy 团队 run：identity 无 groupId → 只看 `group_id IS NULL` 行）。
`closeRun(runId)` 增加 `closeGroup(runId, groupId)` 变体（解散时用）。`recoverAgentWork` 限定同组。

### 4.3 team-collaboration（`sqlite-team-collaboration-repository.ts`）

```sql
ALTER TABLE team_messages ADD COLUMN group_id TEXT;
ALTER TABLE team_message_threads ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_team_messages_run_group ON team_messages(run_id, group_id, created_at);
```

`loadRun(runId)` → `loadScope(runId, groupId?)`；`listRunMembers(runId)` → `listGroupMembers(runId, groupId?)`
（groupId 为空时保留旧语义：run 内全部非 solo 席位）。`createMessage` 入参加 `groupId`；`listPendingNotifications(runId)`
不过滤组（投递只看接收席位）。`UNIQUE (run_id, sender_key, client_message_id)` 保持——幂等键已含 taskId / eventKey。

### 4.4 team-memory（`sqlite-team-memory-repository.ts`）

```sql
ALTER TABLE team_memory_items ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_team_memory_items_run_group ON team_memory_items(run_id, group_id, status);
```

`search / propose / review / contextBrief` 按 `(run_id, group_id)`；`scope='project'` 的项目级记忆不按组过滤（跨组共享，现状语义）。

### 4.5 team-continuity

不改表。`capture()` 的 payload 增加 `groups`（组 + 成员 + lead）；`restore()` 暂不恢复组结构（记录为阶段 2 待办）。

### 4.6 双进程并发与旧构建共库

- 每条 `ALTER` 用 `tableHasColumn` 守卫 + duplicate-column 容错（沿用 `session_token` 列的模式）；`CREATE TABLE / INDEX IF NOT EXISTS`。
- schema_version 7 → 8 只在 team-control 表；其余仓储用「列存在性」而非版本号（现状做法）。
- 旧构建（09-12 21:31）的 MCP 进程与新桌面短暂共库：旧进程不认识 `group_id`，其 `team_*` 查询不带组过滤——只影响 legacy 团队 run（池 run 现状无任务无消息）；旧进程对 `is_solo=0 ∧ group_id 非空` 的席位会按「run 内全体成员」返回 inbox。**部署顺序：先部署桌面 → 重载 MCP → 再允许建组**；建组入口在检测到旧 MCP 进程（`agent_registrations.generation` 早于新桌面首次启动）时置灰并提示。

***

## 5. 身份、授权、围栏与服务层

### 5.1 身份与授权（`sqlite-team-control-repository.ts`、`agent-registrations.ts`）

- `resolveChannelAgentIdentity(channelId)`：JOIN 不变；返回 `AgentAuthorizationIdentity` 新增 `groupId?: string`（来自 `agent_slots.group_id`）。
  - `is_solo=1`（等价 `group_id IS NULL` 且池 run）→ 抛 `TaskPoolError('not_in_group', 'CH-N 当前是独立席位，未加入任何协作组；请只用 check_messages / record_reply 与用户沟通。入组后拾光会投递成员关系通知。')`（替代 `solo_channel`；`index.ts` 的容忍名单同步改名，语义仍是「直接传播为工具结果」）。
  - legacy 团队 run（`is_solo=0 ∧ group_id IS NULL`）→ `groupId` 为 undefined，旧行为。
- `assertAgentRegistrationAuthorized`：删除 capabilities 子集校验（保留 generation 未吊销 + `run_id` 匹配）。`effectiveCapabilities(row)` 继续从角色行取。补一条测试锁定「注册能力快照不再参与授权」。
- `resolveAuthorizedAgent`：SELECT 追加 `s.group_id, g.lead_slot_id, g.acting_lead_slot_id`（LEFT JOIN `team_groups g ON g.id = s.group_id`）；`isEffectiveLead = g ? (acting ?? lead) === slotId : legacy`。`AuthorizedTeamAgent.groupId?`。
- `TeamAgentRuntimeIdentity` / `AgentIdentity` 增加 `groupId?`；`refreshIdentity` 的 `Object.assign` 自动带上。
- `resolveChannelSessionOwner`（围栏）：**不改**。
- `recordAgentCheckIn`：不改写入；额外在同事务写 `team_group_events(member_checked_in)`（当 `slot.group_id` 非空）。`totals` 统计改为 `WHERE b.run_id=? AND s.group_id IS NOT NULL` 且不再推进 `team_runs.status`（池 run 状态由用户控制）。

### 5.2 TeamControlService 新 API（全部返回 `TeamControlSnapshot`）

| 方法 | 事务内 | 事务外 |
|---|---|---|
| `createGroup({ name, goal, members: [{ slotId, roleTemplateKey, roleName?, capabilities? }], leadSlotId? })` | 校验：席位属池 run、`group_id IS NULL`、lead ∈ members；插 `team_groups`；为每个成员插组角色行（`team_roles.group_id`）；`UPDATE agent_slots SET group_id, role_id, home_role_id=COALESCE(home_role_id, role_id), is_solo=0, group_joined_at`；事件 `created` + 每人 `member_joined`；`bumpRevision` | 向每个成员投 `membership: joined` 通知 |
| `addGroupMembers(groupId, members[])` | 同上子集 | 同上 |
| `removeGroupMember(groupId, slotId)` | 若为有效 lead 且组内还有其他成员 → 抛 `lead_must_transfer_first`；释放其 lease（`tasks` 按 `assignee_session_id` 回 `queued`，attempt `cancelled`，事件 `lease.released_by_membership`）；其未回应的 directive/question 收件标记 `notification_detail='orphaned: member left'`；`UPDATE agent_slots SET group_id=NULL, role_id=home_role_id, is_solo=1, group_joined_at=NULL`；删除该成员专属角色行；事件 `member_left` | 投 `membership: left` 通知；若组内还有成员，向 lead 投 `notice`「成员已移出」 |
| `setGroupLead(groupId, slotId \| null)` | 校验成员；更新 `lead_slot_id`，清 `acting_lead_slot_id`；事件 `lead_changed` | 向新旧 lead 投 `membership: lead_changed` |
| `updateGroupGoal(groupId, goal)` | 事件 `goal_updated` | 向成员投 `notice`（复用 team_message，非 membership） |
| `dissolveGroup(groupId)` | `closeGroup` 取消未完成任务；消息 / 记忆保留只读；所有成员按 `removeGroupMember` 的席位恢复逻辑（跳过 lead 校验）；`status='dissolved', dissolved_at`；事件 `dissolved` | 向每个成员投 `membership: dissolved` |
| `addSeats(sessions: [{ modelSelection? }])` | 分配下一批空闲通道号（沿用 `resolveIndependentSessionMembers` 的分配规则），为每个新通道插 solo 角色 + 席位（`createConfiguredTeamBundle` 的单席位变体）+ `agent_slot_model_selections`；**不**动现有席位；`registerSeat`（第 5.3 节）；`bumpRevision` | 触发 `AgentSessionLauncher.launch([{ channelId, modelSelection }])`（现有一键建会话已支持按子集 + 每席模型） |
| `removeSeat(channelId)` | 若在组内先 `removeGroupMember`；`prepareComposerRelaunch` 的逆：撤销注册 generation、删绑定、删席位与 solo 角色 | 围栏在下一次轮询让旧会话退出（现有机制） |

`configureIndependentWorkspace`（新批次）保留：语义 = 新建池（旧池 `completeRun` + `beginScope`），用于「全部重来」。
`createNextRun` / `configureWorkspace`（旧团队 run）保留可用，不再是推荐路径；UI 阶段 3 移除。

### 5.3 增量注册 `registerSeat`（`recordInstallation` 的单席位变体）

现 `recordInstallation` 在拓扑不一致时 `DELETE FROM runtime_bindings WHERE run_id` 并重签全部令牌——对池是灾难。新增：

```text
registerSeat({ workspaceId, runId, channelId, generation })
  - agent_registrations：撤销该 (workspace, channel) 旧注册，插入新行（capabilities_json='[]'，仅兼容）
  - runtime_bindings：仅为该席位插一行（新 session_token、composer_binding_key=generation）
  - 不触碰其他席位；不改 team_runs.status
```

`register-mcp-installer-ipc.ts` 的「接入团队 MCP」对池 run 改走「逐席位对账」：缺注册的补 `registerSeat`，已有的不动。

### 5.4 成员关系通知（`channel-message-relay.ts` / `channel-delivery-policy.ts`）

- `SendMessageInput` 新增 `kind?: 'user' | 'internal' | 'membership'`（现 `silent` 对应 `internal`）。`membership` 也是 `silent=1`，但投递时用 `buildMembershipNoticeSuffix`（第 6.3 节）而非内部协作后缀。存储：`channel_outbox` 加列 `kind TEXT`（additive，默认 `user`）。
- 通知正文由 domain `buildMembershipNotice({ kind, group, role, channelId })` 生成（第 6.2 节），入组通知内联简报摘要（组名、目标、角色一句话、lead 是谁、首个动作）。

### 5.5 编排器改为按组迭代

| 服务 | 现状 | 改动 |
|---|---|---|
| `TaskDispatcher` | 遍历 `pool.taskOrder`，`executionMember(task, team, pool)` 从 `team.members` 选人 | 候选限定 `task.groupId` 的成员；`selectTaskReviewMember` 同 |
| `TeamOrchestrator.reconcileStaleTasks` | lead = run 的 lead | lead = `task.groupId` 所属组的有效 lead；无 lead 组只催办负责人 |
| `MemoryReviewCoordinator` | `selectMemoryReviewMember(item, team)` | 限定 `item.groupId` 成员；无合格审核者 → 升级给用户（现状路径） |
| `TeamMessageDispatcher` | 按接收席位找绑定通道 | 不变（席位 → 绑定是池级） |
| `TeamCollaborationSweeper` | 按 run | 按组迭代（未读催办、超时） |
| `TeamContinuityService` | 按 run 捕获 | payload 含 groups |

`OrchestrationSource<TeamControlSnapshot>` 的快照新增 `groups: TeamGroupView[]`（第 5.7 节）。

### 5.6 TeamFailoverService（阶段 1 必做的收敛）

- `reconcile()`：若 `activeRun` 是池（`workspaceRunMode(run) === 'independent'`）→ **跳过**「全体离线 → `completeRun`」分支与 standby 自动接替（池没有 standby 概念：所有注册通道都有席位）。保留 `reconcileAcknowledgements / recoverIncompleteFailover`。
- 组内成员离线（`hasConfirmedRuntimeStop`）超过宽限 → 组 `status` 不变，`TeamGroupView.attention=true`，向有效 lead 投 `notice`「成员 X 疑似离线」；由用户决定移出 / 交接（手动语义，与用户偏好一致）。
- `reconcileLeadFailover` 按组：有效 lead 确认停止且组内有其他在线成员 → 设 `acting_lead_slot_id`（现逻辑迁到组）。
- `manualHandoff`（职责迁移）在阶段 1 只对 legacy 团队 run 保留；池内「把席位 A 的组身份交给席位 B」= `removeGroupMember(A)` + `addGroupMembers(B, 同角色)` + 会话上下文交接（现有 `SessionHandoffService`），阶段 2（2C `transferMembership`）合并成一个操作，阶段 3 给它 UI。

### 5.7 快照与 IPC

```ts
interface TeamGroupView {
  group: TeamGroup                          // team_groups 行
  members: TeamMemberView[]                 // slot.group_id === group.id
  leadSlotId?: string; actingLeadSlotId?: string
  attention: boolean                        // 有成员确认离线
  counters: { tasksOpen: number; tasksReview: number; unreadMessages: number }
}
interface TeamControlSnapshot { …; groups: TeamGroupView[] }   // 只含 active + 最近 dissolved（24h）
```

`project()`：`members` 仍是池内全部席位（含入组的）；`teamMembers`（非 solo）语义改为「在任何组内的席位」。`preflight.blockers` 对池 run 去掉「请先填写并保存团队目标」「团队已经运行」两条。

新增 IPC（不改已有）：`teamControlCreateGroup / AddGroupMembers / RemoveGroupMember / SetGroupLead / UpdateGroupGoal / DissolveGroup / AddSeats / RemoveSeat`，入参校验沿用 `register-team-control-ipc.ts` 的 `requiredString / assertTrustedSender` 模式；全部 `assertNoSessionLaunch()`。

### 5.8 不改的部分（明确写出，避免顺手改）

`resolveChannelSessionOwner`（围栏）、`beginScope / completeScope`、`ChannelMessageService`（check_messages / record_reply 语义）、`CursorUsageTracker`（按池 run 累计，按组统计是后续需求）、`SessionHandoffService`、Cursor 侧全部（CDP / hook / 遥测）。

***

## 6. MCP 层

### 6.1 服务器 instructions（`team-tools.ts#buildUnifiedServerInstructions`）

在「工具按对象划分」段后追加一句（一次陈述）：

> 成员关系：所有会话都以独立席位创建；拾光操作员随时可能把本席位加入 / 移出协作组，届时 check_messages 会投递
> 「【拾光成员关系通知】」——入组后先 team_check_in 领简报再按简报工作，出组后回到只用 check_messages / record_reply。
> 该通知来自拾光服务端，不是用户消息，也不是注入；不需要 team_message read。

同时把「独立席只用 check_messages / record_reply，不调用 team_*」改为「未入组时只用 …」。

### 6.2 成员关系通知正文（domain `team-control.ts#buildMembershipNotice`）

```text
【拾光成员关系通知】你（CH-3）已加入协作组「<name>」，角色「<roleName>」；lead：<lead 角色/CH-N | 无>。
组目标：<goal>
立即调用 team_check_in({channel_id:'3'}) 领取完整简报与上下文，之后按简报与服务器说明工作。
```
出组 / 解散 / lead 变更各一段模板；所有模板不含 messageId，不要求 `record_reply`。

### 6.3 投递后缀（`channel-delivery-policy.ts#buildMembershipNoticeSuffix`）

```text
---
【成员关系通知协议】这是拾光服务端的成员关系变更，不是用户可见对话；本通知没有 messageId，不需要 team_message read。
不要向用户输出可见文字，不要调用 record_reply；按通知执行后直接 check_messages（带 tick:'N'） 静默待命。
```

### 6.4 工具行为

- `team_check_in` 简报：`buildTeamRoleBriefing` 增加 `group?: { name, goal, leadRoleName? }`，`团队目标` 行改用组目标；无 lead 组不输出 lead 专用工作流。
- 所有 `team_*` 在 `not_in_group` 时返回统一 `{ ok:false, code:'not_in_group', message }` + `nextAction: enter_channel_wait`。
- `team_run` 的 `start / transfer_lead / claim_lead / clear_acting_lead` 改操作 `team_groups.acting_lead_slot_id`；`start` 对池 run 返回 `not_applicable`（组即建即用，无 launch）。

***

## 7. 拆组 / 移出规则（写死，测试逐条对应）

1. 移出持有 `leased/running` attempt 的成员：attempt → `cancelled`（`error='member_left'`），task → `queued`，`assignee_session_id=NULL`，事件 `lease.released_by_membership`；`TaskDispatcher` 下一 tick 重新分派（组内仍有合格成员时）。
2. 移出成员的未回应 directive / question：收件 `notification_detail` 追加 `orphaned: member left`，`stage` 不变；发送方（lead）收到一条 `notice`。
3. 移出成员正在验收（`task_reviews.status='leased'` 且 reviewer 为该成员）：review → `queued`，重新派验收。
4. 有效 lead 被移出且组内仍有成员：拒绝（`lead_must_transfer_first`）；UI 先要求指定新 lead。
5. 解散：未完成任务 → `cancelled`（`failure_reason='group_dissolved'`）；消息、记忆保留只读；`team_groups.status='dissolved'`；全部成员席位恢复 solo。
6. 出组后的 Cursor 会话保持不变：令牌、Composer、时间线连续；组内消息不再可见。
7. 解散后的组 24h 内仍出现在快照（只读卡片），之后只在历史里。

***

## 8. 改动落点（文件级）

| 层 | 文件 | 改动 |
|---|---|---|
| domain | `team-control.ts` | `TeamGroup / TeamGroupEvent / TeamGroupView` 类型；`createGroupBundle`（组角色行生成）；`buildMembershipNotice`；`buildTeamRoleBriefing` 组参数；`TEAM_ROLE_TEMPLATES` 不动 |
| domain | `team-collaboration.ts`、`task-pool.ts`、`team-memory.ts` | 实体加 `groupId?`；`PlanTaskInput`/`CreateTeamMessageInput` 加 `groupId?` |
| domain | `channel-delivery-policy.ts`、`channel-message.ts` | `buildMembershipNoticeSuffix`；`ChannelOutboundMessage.kind` |
| infra | `sqlite-team-control-repository.ts` | 迁移 v8；组 CRUD；`registerSeat`；身份解析加 `groupId` / `not_in_group`；签到事件 |
| infra | `agent-registrations.ts` | 去 capability 校验；`registerSeat` 的注册替换 |
| infra | `sqlite-task-pool-repository.ts`、`sqlite-team-collaboration-repository.ts`、`sqlite-team-memory-repository.ts` | `group_id` 列 + 过滤 + `closeGroup` |
| infra | `sqlite-channel-message-repository.ts` | `channel_outbox.kind` |
| application | `team-control-service.ts` | 5.2 的 API；`project()` 增 `groups`；preflight 调整 |
| application | `task-agent-service.ts`、`team-collaboration-agent-service.ts`、`team-memory-agent-service.ts` | identity `groupId` 贯穿；`listRunMembers` → `listGroupMembers` |
| application | `task-dispatcher.ts`、`team-orchestrator.ts`、`memory-review-coordinator.ts`、`team-collaboration-sweeper.ts`、`team-failover-service.ts`、`team-continuity-service.ts` | 按组迭代；失效接管收敛 |
| application | `channel-message-relay.ts` | `kind: 'membership'` 投递 |
| mcp | `team-tools.ts`、`channel-communication-tools.ts`、`index.ts` | instructions；`not_in_group`；后缀分流；`team_run` 语义 |
| main | `register-team-control-ipc.ts`、`register-mcp-installer-ipc.ts`、`desktop-api.ts`、`preload/index.ts` | 新 IPC；逐席位对账 |
| renderer（最小） | `run/RunIndependentPanel.tsx`、`run/run-view.ts`、`run/run.css`、`preview/mock-data.ts` | 第 9 节 |
| docs | `docs/ARCHITECTURE.md`（运行模式一节重写为「会话池与分组」）、`docs/TASK-MCP.md`（成员关系通知、`not_in_group`） | — |

***

## 9. 阶段 1 的最小 UI（只为实机验收，阶段 3 重做）

在 `RunIndependentPanel` 内：
- 席位行多选 → 「建组」抽屉：组名、目标、每人角色模板下拉（默认 specialist）、lead 单选（可无）→ `createGroup`。
- 组卡片：名称 / 目标 / 成员（角色 + CH-N + 状态点）/ lead 标记 / `attention` 徽标；操作：加人（多选未入组席位）、移出、换 lead、解散；每个破坏性操作一次确认（复用 `ReplaceRunSheet` 的文案结构，但不是替换 run）。
- 会话名册（`session-rail-view.ts`）：角色名已随 `roleTemplateKey` 变化（阶段 0 实测），无需改。
- 预览场景 `?groups=1`（`preview-shots` 增 `run-independent-groups-{light,dark}`）。

***

## 10. 测试（事件级；文件名为建议）

1. `tests/sqlite-team-control-repository.test.ts`（扩）：v7→v8 迁移幂等；双连接并发迁移（一个先加列一个后加列）；`createGroup / addGroupMembers / removeGroupMember / setGroupLead / dissolveGroup` 每步后的不变式 I1/I2/I6；`home_role_id` 回填；`registerSeat` 不动其他席位的 `session_token`。
2. `tests/agent-registrations.test.ts`（新）：注册能力快照 `[]` + 角色 `["code"]` → 授权通过（阶段 0 阻塞点回归）；generation 吊销仍拒绝。
3. `tests/team-control-identity.test.ts`（新）：solo → `not_in_group`；入组 → `groupId`；legacy 团队 run → `groupId` undefined；lead / acting lead 解析。
4. `tests/channel-mcp-server.integration.test.ts`（扩）：真实 stdio：solo 席位 `team_check_in` → `not_in_group`；SQL 入组 → `team_check_in ok`（简报含组名 / 目标）→ `team_message inbox []` → `team_task plan`（lead）→ 成员 `team_tasks available` 只见本组任务 → 出组 → `not_in_group`；全程 `check_messages` 围栏结果不变。
5. `tests/task-pool-group-scope.test.ts`（新）：两组各 plan 任务，成员 `listAvailable / listMine / listBoard` 互不可见；`closeGroup` 只取消本组；移出成员 → lease 释放 → task 回 queued。
6. `tests/team-failover-service.test.ts`（扩）：池 run + 入组成员离线 120s+20s → run 仍 `running`、无 `completeRun`、组 `attention=true`、lead 收 notice；legacy 团队 run 行为不变。
7. `tests/task-dispatcher.test.ts` / `team-orchestrator.test.ts` / `memory-review-coordinator.test.ts`（扩）：按组选人；跨组不分派。
8. `tests/channel-protocol-policy.test.ts`（扩）：`membership` 后缀不含 messageId 指引、含 tick；`buildMembershipNotice` 四种模板。
9. `tests/channel-message-relay.test.ts`（扩）：`kind:'membership'` 入队 `silent=1`、不进时间线、不开回复守门。
10. `tests/run-view.test.ts` / 新 `run-groups-panel.test.tsx`：建组抽屉校验（lead ∈ members）、组卡片操作与确认。

***

## 11. 实机验收脚本（沿用阶段 0 方法）

前置：`npm run typecheck && npm test && npm run build && npm run smoke:channel`；打包并部署桌面；Cursor 重载 MCP；确认 `agent_registrations` 的 generation 为新桌面签发。

1. 独立批次创建 3 个会话（CH-A/B/C），全部待命。
2. 选 A、B 建组「验收组」，A 为 lead（角色 lead），B 为 specialist；目标一句话。
   - 观察 A、B 的 Cursor 气泡（`state.vscdb` 只读脚本，见阶段 0）：收到成员关系通知 → `team_check_in ok` → 回到待命；库 `team_group_events` 有 `created / member_joined×2 / member_checked_in×2`。
3. 向 A 发用户消息「拆一个任务给 B」：A `team_task plan(targetSlotId=B)` → `TaskDispatcher` 向 B 发 directive → B `claim` → `progress` → `submit`；C 全程无任何 team 相关投递。
4. 把 B 移出：B 收到出组通知并回到待命；B 的任务回 `queued`；A 收到 notice。
5. 解散：A 收到通知；任务 `cancelled(group_dissolved)`；A、B 名册角色回「独立执行」。
6. 全程：`channel_presence` 三席持续在线；`team_runs.status` 恒 `running`；`session_token` 三席不变；重启拾光桌面端后组卡片与历史一致。

***

## 12. 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `activeRun` 170 处引用 | 阶段 1 不动 `activeRun` 语义；组是附加投影；`workspaceRunMode(run)==='independent'` 作为「池」判定 |
| R2 | 中途入组的模型行为（注入怀疑） | instructions 预告 + 独立通知类型；兜底「入组时重建会话」选项（`prepareComposerRelaunch`）留到阶段 3 |
| R3 | 旧 MCP 构建与新桌面共库 | 部署顺序 + 建组入口对旧 generation 置灰（4.6） |
| R4 | 池 run 被 failover 收尾 | 5.6 首先落地并有测试 6 锁定 |
| R5 | 组角色 `role_key` 与 `UNIQUE(run_id, role_key)` 冲突 | 前缀组短 id |
| R6 | 模型 / 技能不可事后改变 | 角色只是职责说明；文档明示 |
| R7 | 用量按池累计不清零 | 记录为阶段 2 需求（按组 / 按会话） |
| R8 | 工作树 185 文件未提交 | 独立分支；先收口 |
| R9 | 任务板本身未跑通（0 完成 / lease 过期） | 不在本任务范围；V1 建议组只用消息 + 记忆，任务板可选 |

***

## 13. 进度日志（每完成一步追加，最新在下）

| 时间 | 阶段 | 完成内容 | 验证 |
|---|---|---|---|
| 09-13 14:05 | 文档 | 建立本任务书；阶段 0 实机实验（CH-3 入组 / 出组）通过并回滚；确认阻塞点 `agent_capability_mismatch` 与失效接管风险 | 只读 + 4 行运行库改动已回滚；无代码变更 |
