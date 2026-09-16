# 交接任务书：会话池 + 动态分组 · 阶段 3 渲染层「会话与分组」

> **状态（2026-09-13）：待动工；依赖阶段 1 的 IPC 与快照（`snapshot.groups`），可与阶段 2 并行。** 路线图见 `DYNAMIC-GROUPS-ROADMAP.md`。
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
2. `App.tsx` 里 `accountPanel` 的 props 面与设置页一字不改（沿用 `SETTINGS-PAGE-HANDOFF-TODO.md` 的纪律）。
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
