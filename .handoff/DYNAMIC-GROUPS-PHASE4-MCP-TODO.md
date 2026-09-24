# 交接任务书：会话池 + 动态分组 · 阶段 4 MCP 工具面收敛

> **状态（2026-09-24）：代码完成，待实机验收后合入 main。** 4D、4B、4C、4A 四片都已在分支 `feat/dynamic-groups-phase4`（worktree `E:\SG-phase4`）提交，全量测试、两个 smoke、度量脚本全绿（进度见第 9 节）；D5 按建议取 (a)，4E 不做。实机验收清单见第 7 节——其中第 1 步（Cursor 是否响应 `list_changed`）决定 4A 是否需要退化处理。路线图见 `DYNAMIC-GROUPS-ROADMAP.md`。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录（macOS / Windows 均可）
>
> 来源：CH-2 独立席位 2026-09-13 的度量（构建产物 `listTools` 实测 + 运行库 24 天使用数据 + MCP SDK v2 源码核对）。业务源码零变更。
>
> 需要用户拍板的一项决策见第 1 节；4A–4D 不依赖它，可先做。

***

## 0. 接手人先读

### 0.1 一句话

让 Cursor 每一轮只看到当前席位**用得上**的工具，并把协议约束从描述文字移进 schema 与服务端；
删掉已证明无用或有害的动作与参数；团队消息不再经 outbox 信封二次投递。

### 0.2 度量基线（2026-09-13，`out/mcp/index.mjs` 只读 `listTools`）

| 项 | 现值 |
|---|---|
| 工具数 / 动作路径数 / 参数槽 | 9 / 34 / ≈73 |
| 工具定义体积（Cursor 每轮吃进去） | 11.1K 字符 ≈ 3950 tokens |
| 服务器 instructions | 1443 字符 ≈ 813 tokens |
| 每席位每轮固定预付 | ≈ 4750 tokens |
| 独立席位为用不到的 7 个团队工具付出 | ≈ 3300 tokens / 轮（84%） |
| `team_check_in` 简报 | lead ≈ 1238 / builder ≈ 994 / reviewer ≈ 959 tokens |
| keepalive 单行 | ≈ 46 tokens；空闲 8h ≈ 480 次 ≈ 22k tokens + 480 个工具调用块 |
| 24 天使用 | 任务 29 个 0 完成；验收 0 次结论；`ping/pong/liveness` 4 行；outbox 757 条中 223 条（29%）是内部通知信封 |

### 0.3 目标（完成定义的量化部分）

| 项 | 目标 |
|---|---|
| 独立席位（工作区无分组）每轮预付 | ≤ 800 tokens（2 工具 + 精简 instructions） |
| 团队席位每轮预付 | ≤ 2000 tokens |
| 动作路径 | ≤ 24（4B/4C/4D 后）；若拍板 D5=合并形态则 ≤ 18 |
| 一次「分派任务给成员」的工具调用 | 从 8–9 次降到 ≤ 3 次（plan → 成员醒来即见任务 → claim） |
| 内部通知信封 | 0 条（团队消息随 `check_messages` 内联） |

### 0.4 实施纪律

1. 每一项改动先改 schema / 服务端约束，再删文字；不允许「描述里再加一句」式修补。
2. 工具面变更需要 Cursor 重载 MCP：所有在跑长轮询会断一次（协议已有「瞬断续接」）；**旧会话拿到的 `nextAction` / 后缀文本指向旧动作名**——选一个所有会话结束的窗口切换，或保留旧名一版 no-op 别名并在 ARCHITECTURE 记录（与「不提供别名」既有决策的例外）。
3. `verify-built-mcp.ts`（`EXPECTED_TOOLS` 断言）、`channel-mcp-server.integration.test.ts`、`channel-protocol-policy.test.ts` 与 `docs/TASK-MCP.md` 同步更新，缺一不合入。
4. 度量脚本（`listTools` 体积统计）进 `scripts/`（非 gitignored），CI 不跑，作为验收工具。

### 0.5 明确排除

- Cursor 会话里工具调用块的可见性（keepalive 每分钟一条）——由 Cursor 客户端决定，非本仓库可控；只能靠拉长 keepalive（现 60s，`CHANNEL_KEEPALIVE_TIMEOUT_MS`）缓解，本阶段不改。
- 任务板业务语义（lease 决策在阶段 2）。

***

## 1. 决策点

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D5 | 工具面形态 | (a) 保留 9 个名字，做 4A–4D（最小改动，行为几乎不变）；(b) 合并为 5 个：`check_messages / record_reply / task / team / check_in`（`task` = tasks+task+review，`team` = message+memory+run 的低频动作） | 先做 (a)；(b) 待阶段 2 编排边界稳定、任务板是否保留在工具面（阶段 2 D1/D3）有结论后再评估。(b) 的收益主要在路径数（34→18），风险在所有简报 / 后缀 / 文档的名字全换 |

***

## 2. 模块 4A · 工具可见性按工作区分组状态

### 2.1 约束（先说清，避免误设计）

- 一个 MCP 进程 = 一个 Cursor 窗口 = 该窗口内**全部**通道；`tools/list` 不带通道信息，因此**做不到按通道**过滤工具。可做到的是**按工作区**：无活动分组 → 只暴露通信工具；有活动分组 → 暴露团队工具。
- MCP SDK v2（`@modelcontextprotocol/server` 2.0）已核对：`RegisteredTool.enable() / disable() / remove() / update()` 存在，且 `update` 自动发送 `notifications/tools/list_changed`（`mcp-*.mjs` 行 1719–1760、1814）。**Cursor 是否响应 `list_changed` 需实机验证**（第 7 节第 1 步）；若不响应，退化为「重载 MCP 才刷新」，此时改为在 instructions 里声明「团队工具仅在入组后有效」，并保持 4B–4D 的收益。

### 2.2 实现

> 实施结果（09-24，详见第 9 节）与下文两处不同：探测时机是「构造时一次 + 每次 `check_messages` 返回前一次」，没有定时器；切换封装在 `src/mcp/team-tool-visibility.ts`，不是 `setTeamToolsEnabled`。

- `unified-channel-server.ts`：`registerTeamTools` 返回 `RegisteredTool[]`；新增 `setTeamToolsEnabled(enabled)`。
- `index.ts`：轮询（与 `refreshIdentity` 同频，或独立 2s 定时器）读取 `team_groups WHERE run_id = 池 run AND status='active'` 的计数 → 变化时调用 `enable/disable`。首次 `listTools` 前按当前计数初始化。
- `check_messages` 的 membership 通知已含「先 `team_check_in`」；若 Cursor 不响应 `list_changed`，通知文案补一句「若当前工具列表里没有 team_*，请重载 SG Team MCP」——仅作退化提示。

### 2.3 测试

- 集成：无组 → `listTools` 只有 2 个；SQL 建组 → 收到 `list_changed` → 9 个；解散 → 2 个。
- `verify-built-mcp.ts` 增加两段：建组前 / 后的工具面断言。

***

## 3. 模块 4B · schema 判别联合 + 删死参数

### 3.1 判别联合

`team_task / team_review / team_message / team_memory / team_run` 的 `inputSchema` 改为 `z.discriminatedUnion('action', [...])`（`team_tasks` 用 `view`），每个分支只含该动作的字段并标必填；`required()` 运行时兜底保留（旧客户端）。description 只保留一句「做什么」；「X 必填 Y」「仅主控」类文字全部删除（仅主控由服务端错误码表达，现状已如此）。

预期：`team_task` 定义 2142 → ≈1500 字符；`team_memory` 1996 → ≈1400；总体 −20%～−25%。

### 3.2 删死参数（阶段 0 后审查发现）

| 参数 | 证据 | 动作 |
|---|---|---|
| `check_messages.reply` | 与 `record_reply` 同效（`channel-message-service.ts` 「顺带提交回复」路径），协议只该陈述一次 | 删；服务端 `inlineReply` 分支删 |
| `record_reply.groupId / taskId / files` | relay / 渲染层零引用；`pendingGroupChat` 恒 `false`；`buildReplySyncRequiredMessage(groupChat)` 群聊分支不可达 | 删参数与 `pendingGroupChat / pendingGroupId` 相关代码路径（列保留，旧构建共库） |
| `record_reply.title` | 渲染层 1 处引用 | 保留 |
| `team_check_in.note` | 只落 `last_check_in_note` | 保留（阶段 0 用它做了观测锚点） |

### 3.3 测试

- `channel-protocol-policy.test.ts`：schema JSON 体积上限断言（防回退）；每个 action 分支缺字段 → zod 报错而非 `invalid_arguments`。
- `channel-message-service.test.ts`：`reply` 路径删除后 need_reply_sync 守门行为不变。

***

## 4. 模块 4C · 团队消息随 `check_messages` 内联，删除信封转投

### 4.1 现状路径

`team_messages` 新行 → `TeamMessageDispatcher`（750ms）把 6 行信封写进 `channel_outbox`（silent）→ Agent `check_messages` 收信封 → `team_message read` → 正文 → （`respond`）。29% 的 Agent 唤醒是信封。

### 4.2 改动

- `ChannelMessageService.checkMessages`：取队首用户消息（或 keepalive）时，**同时**查询该通道席位的未读团队消息（`team_message_receipts.read_at IS NULL`，按 `group_id` 过滤，最多 N=10 条），把正文内联进返回体的结构化区块 `team: { messages: [{ id, kind, sender, subject, content, createdAt }] }`，并**原子标记 read**（`markRead` 与 `markOutboundDelivered` 同事务；现状 `read` 是 Agent 显式动作，改为「投递即已读」，`acknowledged / responded` 语义不变）。
- 唤醒：`TeamMessageDispatcher` 保留为「唤醒信号」——不再写信封正文，只在 `channel_presence` 上写 `wake_requested_at`（additive 列）或向 outbox 写一条**空文本** `kind='wake'` 行（长轮询循环看到即返回）；两者选其一，推荐 presence 列（不产生出站行）。
- `team_message action:'read'` 保留一版为「按 id 重读全文」，不再是必经步骤；`inbox` 保留（列摘要）。
- 内部协作通知后缀 `buildSilentDeliverySuffix` 删除；membership 后缀保留（阶段 1）。
- 无用户消息、仅有团队消息时的返回体：`type='delivered'`、`message.silent=true`、`user` 为空、`team.messages` 非空，后缀用一句：「以上为团队消息；处理后 directive/question 用 `team_message respond` 回应；不要 `record_reply`；然后 `check_messages`」。

### 4.3 影响

- `TeamMessage.receipt.notificationState` 的 `sending / notified / uncertain / failed` 退化为 `queued → notified(读取即)`；`teamMessageReceiptStage` 保持兼容。
- 桌面「协作」面板的投递状态列改为「已送达（随轮询）」。

### 4.4 测试

- 集成：lead `plan` → dispatcher 建 directive → 成员 `check_messages` 返回体含该 directive 正文且 receipt 已 read → 成员 `respond` → lead `check_messages` 返回体含 response。全程 outbox 无信封行。
- 并发：用户消息与团队消息同时到达 → 一次返回同时含 `user` 与 `team.messages`；回复守门只对 `user` 开。
- 唤醒延迟：团队消息写入 → 成员长轮询在 ≤1s 内返回。

***

## 5. 模块 4D · 删探活动作与 renew

- 删 `team_run action: ping / pong / liveness`；`channel_liveness` 表与 `recordLiveness / checkLiveness` 代码删除（24 天 4 行）；`claim_lead` 只看 `channel_presence`（`hasInFlightExecution / isExplicitlyStoppedPhase`）。
- 删 `team_run action: start`（阶段 2B 已 no-op）；`transfer_lead / claim_lead / clear_acting_lead` 保留并作用于 `team_groups`。
- `team_task action: renew` / `team_review action: renew`：按阶段 2 D3 结论——D3=a 则删除（服务端自动续）；D3=b 则保留。
- 简报与 instructions 中所有涉及 ping / renew 的句子同步删除（`rg -n "ping|renew" src/domain src/mcp` 归零）。

测试：`team_run` 枚举只剩三项；`claim_lead` 在 lead `processing` 相位下仍返回 `lead_busy`；`rg` 守护测试。

***

## 6. 模块 4E（依赖 D5=b）· 合并为 5 工具

只在 D5 选 (b) 时实施；此处只记录形态，供评估：

```text
check_messages({channel_id, session?, tick?})            → 返回 { user?, team: {...}, tasks?: { assigned, reviews }, briefing?(首次入组后), tick }
record_reply({channel_id, session?, content, title?, to?: 'user' | messageId})   → 合并 respond
task({channel_id, op: view|claim|start|progress|submit|fail|plan|review_claim|review_submit, ...})
team({channel_id, op: send|broadcast|collect|memory_search|memory_propose|memory_review|transfer_lead|claim_lead|clear_acting_lead, ...})
team_check_in（可并入首次 check_messages；保留为显式刷新入口）
```

迁移代价：全部简报 / 后缀 / 文档 / 测试改名；旧会话 `nextAction` 文本失效窗口；`verify-built-mcp` 重写。

***

## 7. 实机验收

> 2026-09-24：以下 1–3 在自动化里都已锁定（`smoke:channel`、`channel-mcp-stdio-groups.integration.test.ts`、`team-three-channel.e2e.test.ts`），实机要确认的是 **Cursor 这一端**的行为——模型在下一轮是否真的看到 / 看不到团队工具，以及会话里的观感。第 4 项的目标值未达成，原因与选项见下。

1. **`list_changed` 验证**（决定 4A 是否需要退化处理）：桌面建组 → 观察 Cursor MCP 面板工具数是否从 2 变 9，不重载；入组席位读到成员关系通知后的下一轮能否直接调用 `team_check_in`；解散 → 回 2。Cursor 3.6.31 的 bundle 里已读到它对 `notifications/tools/list_changed` 的处理（失效工具缓存 + 刷新 offerings），但模型可见的工具列表是否随之更新未实测。若不刷新：入组通知末句已让 Agent 请用户重载「SG Team」，这是当前唯一的退化路径；再进一步只能改成「建组即写 mcp.json 触发 Cursor 重载」（会打断该窗口所有长轮询一次），先看实测再定。记录结论到第 9 节。
2. 独立席位：`listTools` 只见 2 个；一次用户消息往返；keepalive 正常。
3. 团队席位：lead `plan` 一个任务 → 成员下一次 `check_messages` 返回体含 directive 正文与任务摘要 → `claim → progress → submit` → 验收席 `check_messages` 含验收调度 → `review submit accept`；全程 outbox 无信封行；工具调用计数 ≤ 3 次 / 跳（e2e 里派单 → claim 是 2 次）。
4. 度量脚本（`npm run measure:mcp`，2026-09-24 实测）：独立席 ≈ **1 237** tokens / 轮（2 工具 ≈ 421 + instructions ≈ 816；基线 ≈ 4 750），团队席 ≈ **3 860**（9 工具 ≈ 3 044 + 816；基线 ≈ 4 750）。目标 ≤ 800 / ≤ 2 000 **未达成**：两个目标都预设了「精简 instructions」，团队席目标还预设了 D5=(b) 合并为 5 工具；两者都没做。剩余可选项：(a) instructions 按连接时的分组状态选短版（未入组不发团队工具段，约省 200 tokens，代价是两份协议文本要同步维护——本阶段有意不做）；(b) D5=(b)（路径 27 → 18，代价见第 6 节）；(c) 继续压缩 `team_task`（≈ 632 tokens）与 `team_memory`（≈ 562）的描述与参数说明。是否推进由用户拍板。

***

## 8. 落点

`src/mcp/team-tools.ts`（schema、枚举、instructions）、`src/mcp/channel-communication-tools.ts`（删 `reply` 与死参数、返回体结构）、`src/mcp/unified-channel-server.ts` / `index.ts`（enable/disable 轮询）、`src/application/channel-message-service.ts`（内联团队消息 + 原子 read）、`src/application/team-message-dispatcher.ts`（唤醒信号）、`src/infrastructure/channel-messages/sqlite-channel-message-repository.ts`（`wake_requested_at`）、`src/infrastructure/team-collaboration/sqlite-team-collaboration-repository.ts`（`listUnreadForSlot` + `markReadBatch`）、`src/domain/channel-delivery-policy.ts`（删内部通知后缀、加团队消息后缀）、`src/domain/team-control.ts`（简报删句）、`scripts/verify-built-mcp.ts`、`scripts/verify-channel-mcp.ts`、`scripts/measure-mcp-surface.mjs`（新）、`docs/TASK-MCP.md`、`docs/ARCHITECTURE.md`（工具面规则）与 `docs/ARCHITECTURE-LOG.md`（日期条目）。

***

## 9. 进度日志（每完成一步追加，最新在下）

| 时间 | 模块 | 完成内容 | 验证 |
|---|---|---|---|
| 09-13 | 文档 | 建立本任务书；度量基线入档；SDK v2 `enable/disable/list_changed` 能力已核对源码；Cursor 是否响应 `list_changed` 待实机 | 只读，无代码改动 |
| 09-23 | 4D | 分支 `feat/dynamic-groups-phase4`（worktree `E:\SG-phase4`，从 `09b3cf7` 起）。删 `team_run` 的 `start / ping / pong / liveness`，只剩 `transfer_lead / claim_lead / clear_acting_lead`；`claim_lead` 只看 lead 的 presence（in-flight → `lead_busy`；Cursor 明确终止 → 接管；在线 → `lead_still_active`；静默无终止 → `lead_liveness_unproven`），不再发探测消息、不等 8 s；删 `team_task / team_review` 的 `renew` 与 `ttlSeconds`（D3=a，服务端按 presence 自动续）；`channel_liveness` 表与 `recordLiveness / checkLiveness` 删除（打开仓储时幂等 drop）；简报删 renew 句。新增 `scripts/measure-mcp-surface.ts`（`npm run measure:mcp`）。提交 `cd5438e` | 全量测试绿；两个 smoke 通过；度量：动作路径 33 → 27，参数槽 65 → 60，工具定义 ≈ 3625 → 3317 tokens |
| 09-23 | 4B | 删 `check_messages.reply`（含服务端 `inlineReply` 分支）与 `record_reply.groupId / taskId / files`；删恒为 `false / null` 的 presence 字段 `pendingGroupChat / pendingGroupId`（列保留，旧构建共库）；工具描述里的「TeamRun / 上一个团队」措辞改为组。**判别联合有意不做**：zod 会把 `discriminatedUnion` 输出成顶层 `oneOf / anyOf`，Anthropic API 拒收这种工具 schema，一个坏工具会让整轮请求 400——改用 `tests/mcp-tool-surface.test.ts` 锁住每个工具的扁平 object 形态、参数集合、动作枚举与定义总体积预算（9 700 字符）。提交 `31277b8` | 全量测试绿；两个 smoke 通过；度量：参数槽 60 → 56，工具定义 ≈ 3317 → 3057 tokens |
| 09-24 | 4C | 团队消息随 `check_messages` 内联投递：`ChannelMessageService` 每轮先看出站队列（用户消息 / 成员关系通知），队列空时查本席位在当前组内的未读团队消息（`listUnreadForRecipient`，≤ 10 条，按插入顺序），整批返回新结果类型 `team`（正文内联、标出「需回应」、单条 > 4 000 字截断并指向 `team_message read`），并在同一事务里 `markDelivered`（`notified + read`，事件 `message.read` / `delivered_by_check_messages`）；不开回复守门。**与任务书 §4.2 的两处偏离**：(1) `TeamMessageDispatcher` 整个删除而非保留为唤醒信号——长轮询本来每 1 s 查一次 SQLite，MCP 进程直接读协作库即可，桌面端关着团队消息也照样送达，不需要 `wake_requested_at` 列；(2) 用户消息与团队消息同时到达时不合并进一次返回，而是用户消息先投、团队批次在 record_reply 之后的下一轮送达——一次返回只承载一种协议，守门语义不变。阶段 4 之前的信封行（`kind = internal`）遇到即 `retireOutbound`，不再投递；`buildSilentDeliverySuffix`、`commandReceipts`、`SendMessageInput.silent` 与 `kind = internal` 的生产路径一并删除。`teamMessageNeedsAgentResponse`：只有成员发来的 directive / question 需要 `respond`，拾光系统（operator）的调度按正文执行即是回应（`TaskDispatcher` / `MemoryReviewCoordinator` 指令文本同步改写，成员拿到派单直接 `claim`）。`resolveChannelSessionOwner` 增返回 `slotId / groupId`（团队消息按它收件）。`team_message` 描述改写并缩短；`inbox` 的 `unreadOnly` 默认改为 `false`（投递即已读后「只列未读」几乎恒空）。新增 `tests/channel-team-inbox.test.ts`；`team-three-channel.e2e.test.ts` 重写为会话池协作组全程（全程无信封行、无 `team_message` 调用）；`verify-channel-mcp.ts` 增内联投递段。提交 `59db86e` | 全量测试绿（213 文件 / 2197 用例）；两个 smoke 通过；度量：工具定义 ≈ 3057 → 3044 tokens，每轮固定预付 ≈ 3853 |
| 09-24 | 4A | 工具面按工作区分组状态启停。`SqliteTeamControlRepository.hasActiveGroup()`（活动工作区最新 run 正在运行且 ≥ 1 个活动组，与 `resolveChannelSessionOwner` 同口径的一条 SQL）；`registerTeamTools` 返回 7 个 `RegisteredTool` 句柄；新 `src/mcp/team-tool-visibility.ts`：直接写 `enabled` 后只发**一次** `list_changed`（逐个 `enable()` 会发七次），构造时静默套用一次（首个 `tools/list` 即正确），之后**每次 `check_messages` 返回前**重新探测（`ChannelCommunicationDeps.refreshToolSurface`）——建组 / 解散与成员关系通知同源，正在长轮询的成员立刻返回，list_changed 在通知正文之前到达；**不用定时器**（任务书 §2.2 的 2 s 轮询没有必要），探测抛错保持现状（偏向可见）。`joined` 通知末句加退化提示（工具列表里没有 team_* 时请用户重载「SG Team」）；instructions 首句改为「团队工具只在工作区有协作组时出现」。**不做**：按连接时状态选短版 instructions（两份协议文本的维护代价 > 约 200 tokens/轮的收益，记入 §7.4 备选）。`verify-channel-mcp.ts` 改为双席位（CH-1 入组、CH-2 不入组）：无组 2 工具 → 硬调 team_check_in 被 SDK 拒绝 → 建组 + 成员关系通知 → 客户端经 list_changed 重拉到 9 个 → CH-2 得 not_in_group（presence 仍刷新）→ 内联团队消息；`channel-mcp-stdio-groups.integration.test.ts` 增首尾断言（隐藏 → 入组通知时出现 → 最后一个组解散后收回）；新增 `tests/team-tool-visibility.test.ts`。`docs/TASK-MCP.md`、`docs/ARCHITECTURE.md`、`docs/ARCHITECTURE-LOG.md` 同步（阶段 4 整体一条日志） | 全量测试绿（214 文件 / 2203 用例）；两个 smoke 通过；度量：独立席 2 工具 / 7 参数槽 / ≈ 1 237 tokens 每轮（基线 ≈ 4 750），团队席 ≈ 3 860；Cursor 端 `list_changed` 的模型可见效果待实机（§7.1） |
