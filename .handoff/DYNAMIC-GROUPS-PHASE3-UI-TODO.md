# 交接任务书：会话池 + 动态分组 · 阶段 3 渲染层「会话与分组」

> **状态（2026-09-18 夜）：已合回 main，待实机验收（§9，需要用户在真机上走一遍）。合并时与 main 同日新增的名册悬停操作层（置顶 / 清除）做了设计对齐：清除只对「独立」段的离线行开放（组内离线成员由组决定去留），拖拽 / 多选进行中悬停层整层撤下——见 §10 末行与 `docs/ARCHITECTURE-LOG.md` 当日条目。全部落地：名册按组分区、多选与建组 / 加入 / 移出（底部浮动条 + 确认面）、拖放改组（组头 / 「独立」头为放置目标）、`PoolPage` / `PoolHeader` / `GroupCard` / `GroupComposer` / `ConfirmSheet` / `TransferMembershipDialog`、删除清单（§6）核销、截图矩阵换代（§7，探针实跑全绿）。前提偏差（§2.3 PlanPanel 过滤、卡片未读与最近事件、§5 aria 口径与行菜单、§2.1 选中态视觉、§7 场景名与抽屉探针口径）见第 10 节 09-18 行与 `docs/ARCHITECTURE-LOG.md` 的阶段 3 条目。** 进度见第 10 节。路线图见 `DYNAMIC-GROUPS-ROADMAP.md`。
>
> **09-16 更新（阶段 2 · 2B-1 已落地，`feat/dynamic-groups-phase2` `7fb9a5f`）**：本书「删除清单」里的 `RunModeSwitch`、`RunTeamPanel`、`TeamSetupPage`、`team-setup.css`、`team-skill-defaults`、`App.tsx` 的 `teamSetup / runStartMode / onReconfigure / onLaunch / onNextRun`、`run-view.ts` 的团队分支与 `run-view.test.ts` 团队用例、`team-setup-page.test.tsx` 都已经不存在；`RunHeader` 已无模式切换（只剩批次概况与结束）。接手时按「已删」处理，`PoolHeader` 从现状 `RunHeader` 改造即可。`preview/mock-data.ts` 的基础快照仍是一个 legacy 团队 run（默认预览落在「旧团队运行已归档」开始页；池场景走 `?independent=`），换成池快照留给本阶段。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录（macOS / Windows 均可）
>
> 来源：CH-2 独立席位 2026-09-13 的只读审查（`src/renderer/src/run/*`、`session-rail-view.ts`、`handoff-entry.ts`、`App.tsx` 运行模块分支）。
>
> 需要用户拍板的一项决策见第 1 节。

***

## 0. 接手人先读

### 0.1 一句话

把运行页从「两种模式互斥 + 一次性团队启动流程」改成「一个会话池 + 若干可建可拆的组」：席位在左栏名册里
按组分区，多选即可建组；运行页只剩池级操作与组卡片。删除模式切换、团队面板、替换确认单、团队配置页。

### 0.2 现状结构（改动对象）

```text
App.tsx  activeModule === 'run'
  └─ RunPage（556 行）
       ├─ RunHeader（唯一的模式切换入口）+ RunModeSwitch
       ├─ ReplaceRunSheet（结束 / 切模式 / 新批次 / 新一轮的一次性确认）
       ├─ RunTeamPanel（目标、启动、preflight gates、teamFlowSteps）
       ├─ RunIndependentPanel（会话创建区、新批次；阶段 1 在此临时挂了建组与组卡片）
       └─ RunSeats / RunSlot（两种模式共用的席位区）
  └─ TeamSetupPage（541 行，团队角色 / 技能 / 模型配置，onReconfigure 进入）
run-view.ts（300 行）：RunView { mode, phase, presence, seats, liveSeatCount, pendingSeats, gates, state }
                     replaceRunConsequence / teamFlowSteps / teamPrimaryAction
handoff-entry.ts：三态（roles 迁移 / context 交接 / disabled），按 templateKey==='solo' 与离线判定
session-rail-view.ts：名册分组 执行中 / 需关注 / 待命 / 离线；标题 = 角色名 + CH-N
team/ManualHandoffDialog.tsx：离线职责迁移弹窗
```

### 0.3 实施纪律

1. 先改投影（`run-view.ts` → `pool-view.ts`、`session-rail-view.ts` 的组分区），再改组件；渲染层只消费视图模型。
2. `App.tsx` 里 `accountPanel` 的 props 面与设置页一字不改（沿用 `archive/SETTINGS-PAGE-HANDOFF-TODO.md` 的纪律）。
3. 不新增 IPC：全部使用阶段 1 的 `teamControlCreateGroup / AddGroupMembers / RemoveGroupMember / SetGroupLead / UpdateGroupGoal / DissolveGroup / AddSeats / RemoveSeat` 与阶段 2 的 `transferMembership / PlanGroupTasks`。
4. 设计系统：`docs/DESIGN-SYSTEM.md`（浅色为主、SG green 只表品牌 / 待命 / 健康、蓝=执行、琥珀=需关注、红=错误与破坏性、边框优先、圆角 9–17、状态色不作装饰）；名册语言沿用 `docs/UI-STRUCTURE.md` §1a（hairline 分隔、7px 状态点、上下文环、状态行 pill）。
5. 每个交互有 SSR + 交互测试；每个新场景有浅 / 深 / 窄截图与几何探针（`scripts/preview-shots.mjs`）。
6. 删除清单（第 6 节）在功能对等后一次性删除，knip 必须干净。

### 0.4 明确排除

- 不改会话工作区（`SessionWorkspace`）、右栏 inspector、设置页。
- 不做拖拽跨组「合并组」；不做多组归属。
- 不做组级任务看板的完整重做（组卡片只显示计数与最近 3 条；任务详情仍在右栏 PlanPanel）。

***

## 1. 决策点

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D4 | 名册与运行页的关系 | (a) 名册即分组视图：左栏按组分区（组名为 sticky 组头，未入组席位在「独立」区），运行页只剩池级操作 + 组卡片；(b) 名册不变，运行页新增「分组」区做全部操作 | **(a)**。名册已是常驻导航（`UI-STRUCTURE.md`「session pane never disappears」），组是席位的属性，放在席位旁边最直接；运行页避免与名册重复渲染同一批席位 |

下文按 D4=a 写。

***

## 2. 信息架构

```text
左栏 SessionSidebar（名册）
  ├─ 组「验收组」 ▾   [lead 徽标][attention 徽标]        ← sticky 组头，可折叠；右侧「…」菜单：改目标 / 加人 / 换 lead / 解散
  │    ├─ 主控协调 · CH-1   ●  Thinking
  │    └─ 专项实现 · CH-3   ●  Reading foo.ts
  ├─ 组「文档组」 ▾
  │    └─ 研究分析 · CH-4   ●  Completed
  └─ 独立 ▾                                                 ← 未入组席位；多选后出现浮动条「建组 / 加入现有组」
       └─ 独立执行 2 · CH-2 ●  Planning next moves
  （状态分区 执行中 / 需关注 / 待命 / 离线 降级为行内状态点 + 组内排序键，不再作为一级分组）

运行页 RunPage → PoolPage
  ├─ PoolHeader：工作区名 / 路径、Cursor 工程一致性提示、席位计数、「新增会话」「结束全部会话」
  ├─ 会话创建区（现 RunIndependentPanel 的创建部分：模型选择 × N → addSeats）
  ├─ 组卡片网格（GroupCard × n）：名称、目标、成员头像列、lead、attention、任务计数（open / review）、未读、最近 3 条组事件；操作同组头菜单
  └─ 历史（折叠）：已解散的组（24h 内）与归档的旧团队 run（只读）
```

### 2.1 多选与建组

- 名册行支持 ⌘/Ctrl+点击、Shift 范围、以及行首复选框（hover 出现，窄宽常显）；选中态 = 左侧 2px 品牌色条 + 淡色底（沿用选中语言，但与「当前打开会话」区分：当前会话用实心条，多选用虚线条）。
- 选中 ≥1 个「独立」席位 → 名册底部浮动条：`建组（N）`、`加入…`（下拉现有组）、`取消`。选中含已入组席位时浮动条只提供 `移出组`。
- 建组抽屉（右侧滑入，与 inspector 同一动效预算）：组名（必填，默认「组 N」）、目标（多行，可空）、成员表（每行：头像 + 角色名 CH-N + 角色模板下拉，默认 specialist）、lead 单选（可「无 lead」）、`plan_policy`（有 lead 时隐藏）。确认 → `createGroup`。抽屉内不可拖拽。
- 拖拽：名册行可拖入其他组头 / 「独立」区（`addGroupMembers` / `removeGroupMember`）；lead 行拖出组头时被拒绝并提示「先换 lead」。现有「状态组内拖动排序」保留为同组内排序。

### 2.2 破坏性操作确认

统一为一个 `ConfirmSheet`（替代 `ReplaceRunSheet`），文案由 `pool-view.ts#consequenceOf(action)` 生成，只在有后果时出现：

| 动作 | 后果文案要素 |
|---|---|
| 移出成员 | 其 leased/running 任务回池；未回应的指令标记孤儿；会话本身不中断 |
| 解散组 | N 个未完成任务取消；消息 / 记忆只读保留；成员回到独立 |
| 结束全部会话 | 所有会话被围栏终止；未投递消息归档（现 `endActiveRun` 文案） |
| 移除会话 | 该会话被围栏终止；若在组内先移出 |

加人、换 lead、改目标不确认（可撤销：再改回即可）。

### 2.3 组内状态与 attention

- 组头 attention 徽标 = `TeamGroupView.attention`（有成员确认离线）；点击展开显示离线成员与两个动作：「交接给…」（阶段 2 的 `transferMembership`，含「同时交接上下文」复选）、「移出」。
- 组卡片的任务计数来自 `counters`；点击进入右栏 PlanPanel 并按组过滤（PlanPanel 增加 `groupId` 过滤参数，不改其结构）。

### 2.4 会话工作区的联动

- 会话头部（`SessionOverview` / 工作区标题）显示「组名 · 角色」而不只是角色；点击组名 → 运行页对应卡片。
- `handoff-entry.ts` 三态改为：未入组 → context 交接（现 solo 分支）；入组在线 → context 交接；入组离线 → `transferMembership` 弹窗（替代 `ManualHandoffDialog`）。

***

## 3. 视图模型

### 3.1 `pool-view.ts`（替代 `run-view.ts`）

```ts
export interface PoolView {
  workspace?: TeamWorkspace
  pool?: TeamRun                       // activeRun
  seats: PoolSeat[]                    // 全部席位（含组内）
  groups: GroupView[]                  // active + 24h 内 dissolved
  independentSeats: PoolSeat[]         // group_id 为空
  liveSeatCount: number
  pendingSeats: PoolSeat[]             // 未待命：会话创建区对象
  cursorWorkspaceChanged: boolean
  state: RunStateChip                  // 池级：N 会话在线 / M 需关注 / 已结束
}
export interface GroupView { group: TeamGroup; members: PoolSeat[]; lead?: PoolSeat; attention: boolean; counters; recentEvents: TeamGroupEvent[] }
export type PoolAction = 'remove-member' | 'dissolve-group' | 'end-pool' | 'remove-seat'
export function consequenceOf(view: PoolView, action: PoolAction, target: { groupId?: string; slotId?: string }): ConfirmConsequence
```

`seatStateOf / runSeatOf` 沿用；`phaseOf / teamStateChip / teamFlowSteps / teamPrimaryAction / replaceRunConsequence` 删除。

### 3.2 `session-rail-view.ts`

- 分区键从状态改为 `groupId ?? 'independent'`；组头视图 `RailGroupHeader { id, name, lead?, attention, collapsed, memberCount }`；组内排序 = 状态（执行中 → 需关注 → 待命 → 离线）再 slot_order；用户拖动排序仍持久化（key 加组前缀）。
- 标题 `角色名 · CH-N` 不变；未入组席位角色名恒「独立执行 N」。
- 头部摘要改为 `2 组 · 4 会话 · 1 需关注`。
- **09-18 落地口径**（与上文的偏差）：组头视图就是 `SessionRailSection { id, kind, label, state, attention, leadChannelId?, sessions }`，来源 `RailGroupSource { id, name, channelIds, leadChannelId?, attention }` 由 `App` 从 `teamControl.groups` 的 active 组投影一次（统计页的组求和共用）；名册只认通道号。`state` = 分区内最紧要一行的状态，落在书签左脊上（main 09-16 的书签组条把脊色留给状态，分区改成组之后脊色不能没有含义——折叠后它是这一段唯一的状态提示）。拖动排序不加组前缀：仍是一份全局顺序，只在**同状态段**内重排（指示线与落点都夹在段内，越过它落下的行会被状态排序拉回，指示线不该在那里说谎）；折叠键升到 `shiguang.sessionGroups.collapsed.v2`（值是组 id / `independent`，v1 首次读取时清掉）。attention 徽标文字是「成员离线」而不是「需关注」——头部摘要里的「需关注」数的是待回答 / 待拍板 / 待验收的**行**，两个词指两件事。

***

## 4. 组件清单

| 新增 / 改造 | 文件 | 说明 |
|---|---|---|
| `PoolPage`（改造自 `RunPage`） | `run/PoolPage.tsx` | 结构见 §2；`RunSeats / RunSlot` 复用 |
| `PoolHeader`（改造自 `RunHeader`） | `run/PoolHeader.tsx` | 删模式切换；加「新增会话」「结束全部会话」 |
| `GroupCard` | `run/GroupCard.tsx` | 卡片 + 「…」菜单（复用 `lobby/MenuSelect` 的菜单语言） |
| `GroupComposer`（建组抽屉） | `run/GroupComposer.tsx` | 复用 `inspector/InspectorShell` 的滑入容器与 `lobby/ToggleSwitch / MenuSelect` |
| `ConfirmSheet`（改造自 `ReplaceRunSheet`） | `run/ConfirmSheet.tsx` | 文案来自 `consequenceOf` |
| `RailGroupHeader` | `SessionSidebar.tsx` 内 | sticky 组头 + 折叠 + 菜单 + 拖放目标 |
| 多选浮动条 | `SessionSidebar.tsx` 内 | `RailSelectionBar` |
| `TransferMembershipDialog`（改造自 `team/ManualHandoffDialog`） | `team/TransferMembershipDialog.tsx` | 目标席位、含上下文复选 |
| `SessionOverview` 头部 | 组名 · 角色 | — |
| `inspector/PlanPanel` | `groupId` 过滤 | — |

***

## 5. 交互细则与可访问性

- 多选：`aria-multiselectable` 名册；行 `aria-selected`；浮动条 `role="toolbar"`；Esc 清除选择。
- 拖放：键盘替代 = 行「…」菜单里的「移到组…」；拖放目标高亮用 1px 品牌色描边 + 淡底，不用阴影。
- 组头折叠状态持久化（`storage-migration.ts` 增键）；折叠组内若有 attention，组头徽标仍可见。
- 动效预算：抽屉 220ms、组头折叠 200ms、浮动条 120ms；`prefers-reduced-motion` 全关。
- 每个状态色都伴随文字（attention 徽标带 tooltip 与 `aria-label`）。

***

## 6. 删除清单（功能对等后一次删除）

`run/RunModeSwitch.tsx`、`run/RunTeamPanel.tsx`、`run/ReplaceRunSheet.tsx`（改造为 `ConfirmSheet` 后删原名）、`team/TeamSetupPage.tsx`、`team/ManualHandoffDialog.tsx`（改造后删原名）、`team-setup.css`、`run-view.ts` 中的团队分支函数、`App.tsx` 中 `teamSetup / runStartMode / onReconfigure / onLaunch / onNextRun` 状态与回调、`preview/mock-data.ts` 的团队 run 场景、对应测试（`run-view.test.ts` 团队分支、`team-setup-page.test.tsx`、`manual-handoff-dialog.test.tsx` → 改为新组件测试）。

***

## 7. 预览与截图矩阵

场景（`preview-main.tsx` query）：`?pool=groups`（2 组 + 2 独立）、`?pool=empty`（无会话）、`?pool=attention`（组内离线）、`?pool=composer`（建组抽屉打开）、`?pool=confirm`（解散确认）、`?rail=groups`（名册分区 + 多选浮动条）。
截图：每个场景浅 / 深 × 宽 / 窄（900px）；几何探针：组头 sticky、浮动条不遮挡最后一行、卡片网格不溢出、抽屉与 inspector 不重叠。

***

## 8. 测试

1. `pool-view.test.ts`：分区、计数、`consequenceOf` 四种动作文案、独立席位与组成员互斥。
2. `session-rail-view.test.ts`：组分区与组内排序、折叠持久化、attention 上浮。
3. `session-sidebar-groups.test.tsx`：多选（⌘、Shift、复选框）、浮动条出现 / 消失、Esc 清选、键盘「移到组…」。
4. `group-composer.test.tsx`：必填校验、lead ∈ members、无 lead 时 `plan_policy` 显示、确认调用 `createGroup` 入参快照。
5. `group-card.test.tsx`：菜单动作路由到对应 IPC；attention 展开；计数。
6. `confirm-sheet.test.tsx`：四种后果文案；无后果动作不弹。
7. `app-handoff-entry.test.tsx`（改）：三态新规则。
8. 截图矩阵 + 探针脚本通过；`npm run lint:dead` 干净。

***

## 9. 实机验收

1. 三个独立会话 → 名册「独立」区三行；多选两行 → 建组「验收组」（一人 lead）→ 名册出现组头，两行移入；对应 Cursor 会话收到入组通知并 `team_check_in`（观测法沿用阶段 0）。
2. 拖第三行进组头 → 加入；拖 lead 行出组 → 被拒绝并提示。
3. 组头菜单「解散」→ 确认单文案含任务与消息后果 → 三行回「独立」区；会话未中断。
4. 900px 窄窗、暗色主题、reduced-motion 下重复 1–3。

***

## 10. 进度日志（每完成一步追加，最新在下）

| 时间 | 模块 | 完成内容 | 验证 |
|---|---|---|---|
| 09-13 | 文档 | 建立本任务书；D4 待用户拍板 | 只读，无代码改动 |
| 09-17 19:00–19:15 · 09-18 00:25–01:10 | 名册分区 | （CH-3）名册从「状态分区」改为「组即一级分区」（D4=a）；第一版落在阶段 2 旧基线上（`523d410`），main 同期把名册改成了书签组条 + 折叠锚定 + 光刃选中，按用户决定对齐基线（main → phase2 → phase3）后在新名册上重做。① `session-rail-view.ts`：`RailGroupSource`（组 → 成员通道号 + lead 通道 + attention）、`SessionRailSection`（`state` = 段内最紧要一行的状态）与 `buildSessionRailSections`：active 组按来源顺序成段、空组不出段、未入组席位统一落「独立」段并殿后；组内先按状态紧要度（执行中 → 需关注 → 待命 → 离线）排，同状态保留传入顺序（= 手动排序，`sort` 稳定）；席位同时出现在两个组时归先声明的那个。`SESSION_RAIL_GROUPS` 删除，`sessionRailGroupOf` 仍是唯一那个函数（组内次序、行状态点、书签脊色三者同源）。② `sessionRailSummary` 改口径 `2 组 · 4 会话 · 1 需关注 · 排队 3`（无组不报「0 组」）。③ `SessionSidebar` 消费分区：书签组条沿用 main 的几何（32px、旗 + 尾线 + chevron、脊色 = `is-<state>`），`data-section` 标 id；组头挂「成员离线」琥珀 pill（带 `aria-label`，位于 Collapsible 之外所以折叠后仍可见）；`aria-label` 区分组会话 / 独立会话；折叠键 `shiguang.sessionGroups.collapsed.v2`，v1 首次读取清掉；折叠锚定（`anchorCollapse` / `session-group-collapse.ts`）与 `keepMounted` 原样保留。④ 拖拽：只在同状态段内重排——`rankBandOf` 算出被拖行所在的连续同状态段，`dragover` 的指示线与 `drop` 的落点都夹进段内（`moveSessionWithinGroup` 只映射段内槽位），独占一段状态的行不可拖；被拖行状态变化不再中止手势（分区不随状态变），被移出组才中止。⑤ `App`：`activeGroups` 投影一次，名册与统计页 `statsGroups` 共用。⑥ 预览 `?sessions=many` 带两个组（「验收」attention）+ 独立段 5 行；`preview-shots.mjs` 的名册探针改用 `[data-section=…]` 选段，浏览器里实跑折叠几何探针（组条 32px 不变、未滚动时不动）与滚动锚定探针（418 → 368 → 360 → 358，组条钉在 0，徽标折叠后仍可见）均通过。 | typecheck、knip、`npm run build`；`session-rail-view.test.ts` +2（分区 / 排序 / 空组 / 重叠归属 / 书签状态；摘要口径）、`session-sidebar-drag.test.tsx` 重写 5 例 +1（分区与徽标与 title、v2 折叠键与 keepMounted、锚定折叠改选 `data-section`、方向键漫游按组、跨段拖放拒绝与状态变化不中止、同状态段夹取指示线与落点、可拖判定按段）；全量 206 文件 / 2089 用例（2087 通过 + 2 skipped） |
| 09-18 17:00–17:36（CH-4 / CH-3 交接的未提交改动） · 19:10–22:00（CH-2 接续） | 池页 + 多选 + 拖放 + 矩阵 | ① 交接的未提交改动先做检查点提交（`a84105d`）并 rebase 到 main `679594d`，随后深度审查一轮（`363ed38`）：未入组候选面与默认组名收成单一来源（`ungroupedSeatsOf` / `nextGroupName`）、新建批次与结束同级确认、`ConfirmSheet` / `GroupComposer` 焦点保持与归还、组目标 ⌘/Ctrl+Enter 保存、theme 契约测试改到新类名。这两笔覆盖 §2 的 `PoolPage` / `PoolHeader` / `GroupCard` / `GroupComposer` / `ConfirmSheet` / `TransferMembershipDialog` 与 §6 删除清单（全部核销；`preview/mock-data.ts` 的 legacy 团队 run 故意保留——它就是「旧团队运行已归档」开始页的预览，池场景走 `?independent=`）。② 名册多选（`8a9bc3c`）：⌘/Ctrl 点击、Shift 同区范围、头像位 44px 复选圆盘（悬停 / 聚焦 / 选择中 / 已选 / ≤300px 常显；slot 建立堆叠上下文，圆盘不越过吸顶组头）、⌘/Ctrl+空格与 Shift+空格（keydown+keyup 双取消防误开会话）；底部浮动条是 `session-pane` 网格第三行（名册收缩让位，从不遮挡最后一行）——全独立 → `建组（N）` + `加入…`（MenuSelect，两条路都进抽屉预勾通道、角色在抽屉里确认），含组内 → 只 `移出组（M）`（复用 `removeMembersConsequence` 确认面，在条内展开，取消后焦点还给重新挂载的移出钮）；lead 带队友时禁用并写明先换 lead；Esc 一次收一层（MenuSelect 的 Escape 不再冒泡穿透菜单）；`App.selectionActions`：建组 / 加人开抽屉，移出逐通道解析 slot + active 组顺序走 `removeTeamGroupMember`（确认与执行之间离组的席位跳过）。③ 拖放改组（`49ae048`）：可多选时行全部可拖，放置目标 = 组头 / 「独立」头；独立 → 组头进抽屉预勾（角色必选，不静默 specialist）、组内 → 独立头走同一张移出确认面、lead 带队友与组间直拖落下即拒并在浮动条说明（悬停时目标先红调预警）；同状态段内重排与无 actions 的旧可拖判定不变。④ 截图矩阵换代（`aa41860`）：删模式切换时代场景，池场景 + 五档宽度网格溢出探针 + 抽屉视口/背板探针 + 解散/移出/交接/改目标面 + `run-sheet-opening` 改由结束批次触发；名册加 `sessions-rail-multiselect-{light,dark,mixed}` 与 `sessions-rail-remove-sheet`（浮动条不遮挡最后一行探针）。实跑暴露并修掉两个真缺陷：圆盘未对齐头像中心（行高随文本行数变，改 `top: calc(50% − 38px)`，由固定的 padding 8 + gap 10 + 状态行 22 推出）、浮动条里 MenuSelect 被块级 100% 拉满整行。`?plan=long` 夹具从已退役的席位轮换叙事改为本阶段自身步骤。**前提偏差（记录不硬做）**：§2.3 PlanPanel `groupId` 过滤——右栏 `PlanPanel` 是所选会话的 Cursor Todos，不存在团队任务面板，组计数保持信息展示；§2 卡片「未读、最近 3 条组事件」——`TeamGroupEvent` 只在存储层，快照不携带且本阶段不新增 IPC；§5 `aria-multiselectable`/`aria-selected`——名册是 nav+button 不是 listbox，用真复选框 + aria-label + 行标签「已选中」后缀；§5 键盘「移到组…」行菜单——由复选框 + 浮动条一套选择模型替代；§2.1 多选选中态「品牌色虚线条」——09-16 光刃改版后侧栏橙=「你在这」，改用建组抽屉同款 accent-wash 平涂 + 复选框；§7 `?pool=` 场景名——沿用既有 `?independent=` / `?sessions=`；§7「抽屉与 inspector 不重叠」——抽屉是带背板的模态面，探针改为抽屉在视口内 + 背板全覆盖。 | typecheck、knip、全量 208 文件 / 2135 通过 + 2 跳过（`session-sidebar-groups.test.tsx` 新 20 例：选择 / 范围 / 复选框 / 浮动条动作 / lead 拦截 / 移出流含失败与焦点归还 / Esc 分层 / 键盘 / 选集收缩 / 无 actions 回退 / 拖放判定矩阵；`tests/drag-event.ts` 抽为两套侧栏测试共用）；25 个新 / 改场景对预览服务实跑，探针全绿（浮动条与名册底齐平 584/584、末行 572；网格 1180→600 五档无溢出；名册确认面在面板内）；`npm run build`、`smoke:channel`、`smoke:mcp` 全绿（Windows 10 本机） |
| 09-18 23:30–00:00（CH-3） | 合回 main | 把 main（`679594d..f91bfad`，3 提交：composer 附件贴图回归场景、开场占位「正在规划下一步」、名册悬停置顶 / 清除层）合入分支，解掉三处冲突（`SessionSidebar.tsx` 导入 / 状态 / nav 类名；`ARCHITECTURE-LOG.md` 双侧条目按时序并置；`preview-shots.mjs` 两侧场景都保留），并把两套悬停交互设计对齐进新名册：① 清除只对「独立」段的离线行开放——组内离线成员由组决定去留（交接 / 移出），`session-rail-hidden.ts` 注入判定改名 `isOffline` → `isClearable`，`isClearableSession`（离线 ∧ 未入组）同时决定清除钮与已清除 id 的隐藏，已清除席位入组与复活同样自愈；② 拖拽（重排 / 改组）或多选进行中悬停层整层撤下（`.is-reordering` / `.is-picking`），批量动作归浮动条；③ 几何不相扰：操作层右上、多选圆盘头像位，同在 slot 堆叠上下文内、吸顶组头之下；恢复行拖拽时对指针透明，名册尾部落点无死区。随后 merge 回 main。 | typecheck（tsc 直跑 0 错误）、全量 210 文件 / 2163 通过 + 2 跳过（`session-rail-actions.test.tsx` +3：组内离线成员无清除钮、已清除席位入组自愈且名单收敛、拖拽 / 多选撤层）、knip 干净、`npm run build`；截图矩阵全量 221 场景对合并树实跑全绿（含 `sessions-rail-hover-row` 真悬停：组内行只出置顶不出清除）；浏览器实测（preview.html?sessions=many）：静止 hidden / 聚焦 visible、勾选后 `is-picking` 下层 display none、Esc 恢复、清除 CH-11 → 恢复行出现 → 一键恢复名单收敛为 `[]` |
