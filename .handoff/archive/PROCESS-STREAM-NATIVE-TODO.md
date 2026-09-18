# 待办任务书：会话过程流对齐 Cursor 原生块状结构

> **状态（2026-09-11 23:19）：阶段 A–D、编辑流式尾窗与工程全量验证已完成（工作树，未提交）；仅保留用户安排时机的单会话实机验收。** 进度日志见第 9 节，每完成一步在那里追加一行；
> 中断后接手者只读第 0、9 节即可定位。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录（macOS / Windows 均可）
>
> 基线：`a5492a4`（工作树另有 ~80 文件未提交改动——问卷作答 / 热切换 / 指纹窗口绑定 / 托盘图标——
> **属其他 Agent 正在推进的部分，接手前 `git status` 确认归属并保护，不要覆盖、不要 stash**）
>
> 调研来源：CH-1 独立席位 2026-09-11 19:47–20:05 的只读调研（反查 Cursor 3.6.31 workbench bundle 分组算法、
> 只读 CDP 探针抓运行中/已完成气泡内存形态），CH-2 接手后于 20:20–20:40 逐条复核 bundle 函数（第 2 节即复核结果）。
>
> 用户已拍板（2026-09-11 20:05）：① 默认分组策略跟 Cursor **detailed**（shell 独立、探索折叠）；
> ② 持久化 shell 输出只留**尾部 4k**；③ **阶段 E（子 Agent 嵌套）本轮不做**。
> 环境约束：其他 Agent 同时在改别的部分；**不重启 Cursor、不重启 MCP**。

***

## 0. 接手人先读

### 0.1 任务一句话

把拾光会话页里的 Cursor 原生过程流（`ProcessTurnCard compact` → `.cursor-native-*`）从「逐块平铺的同款 44px 卡片」
改成 Cursor 自己那种块状结构：探索类调用折叠成 `Explored N files` 组头、shell 独立卡内联实时输出、
编辑卡带红绿 `+N −M` 与按行着色 diff、去掉每行伪耗时。

### 0.2 结论先行（为什么可行）

差距主要不在数据层：hook v26 已把标题 / 命令 / 路径 / 行范围 / 增删行数 / 输出 / 错误 / todo / 问卷带到渲染层。
缺的是 **投影层没有分组**、**渲染层把所有东西折叠进同一种卡**，外加两个现存缺陷（第 3 节）。
阶段 A–C 不改 hook、不改持久化 schema（只加可选字段）；只有阶段 D 需要 hook v27。

### 0.3 实施纪律（沿用仓库既有纪律）

1. 先改领域 / 投影，再改渲染；分组是 `process-turn-view.ts` 的纯函数，渲染层只消费视图模型。
2. **稳定 identity**：step id 仍是 `block:<blockId>`；组 id 取首步 id（`group:<firstStepId>`）；不得因分组变化让
   React 重挂已在播放的 Thinking（阶段 G 打字机的 `hydratedBlockIds` 判据基于 `blockId`，不受影响）。
3. **分组必须在 transport 噪音过滤之后**（过滤在 hook `processSnapshot` + `parseProcessStream` 已完成，
   投影层拿到的 blocks 已无 check_messages/record_reply；不要再在投影层做第二套过滤）。
4. 事件序列测试：`running(无输出) → running(部分输出) → completed`、`[read, thinking]` vs `[thinking, read]` 的分组差异、
   组 id 在块增长时不变；不要只断言最终 class。
5. `getSnapshot()` 零写入的纪律不变：4k 尾部裁剪放在封口写库前（`sealChannelVirtualProcess` 的 `settled` 步骤），
   实时层保持 12k。
6. 每阶段结束：`npm run typecheck && npx vitest run <相关文件>`，再 `npm run preview:ui` 走查 / `preview:shots --only session-process-*`；
   通过后更新第 9 节日志再进下一阶段。
7. 不引入 UI 库、不改 IPC、不改 MCP 工具面、不碰 `App.tsx` 的 `accountPanel`。

### 0.4 明确排除

- 阶段 E 子 Agent 嵌套（用户决定不做）。
- 新增「密度」设置项（默认即 detailed；`groupProcessSteps(blocks, options)` 保留 options 入口以便将来接设置，本轮不做 UI）。
- 非 compact 的 `process-turn` 旧大卡（`ProcessBlocks.tsx` 兼容入口 / 预览）：只要求不坏，不做同等改造。
- Cursor 3.6.x 以外版本的字段兼容（presenter 已按 `toolCase` 回退，沿用即可）。

***

## 1. 用户看到的差距（两张截图）

| 维度 | Cursor 原生 | 拾光现状 | 差在哪层 |
|---|---|---|---|
| 分组 | `Explored 1 file` / `Ran 2 commands` / `Edited 3 files +12 −3` 折叠头，展开见明细行 | 无分组，逐块平铺 | 投影层 |
| Shell | 独立卡：标题 = description，副标 = 程序名（`cd, 4+`），正文 = 输出预览（5 行定高、顶部渐隐、跟随尾部），失败显 exit code | 输出藏在展开后的「输出」`<pre>`，默认折叠 | 渲染层 + 状态判定 |
| 每行元信息 | 无耗时；只有状态动词 | 每行 `~0.1s · 完成 · ⌄`，耗时是采样估算（所以全是 0.1s） | 投影层 |
| Edit | 文件名 + 绿 `+N` 红 `−M`，展开为按行着色 diff | `+18 −4` 单色；diff 原文塞代码块 | hook 小改 + 渲染 |
| grep | `Grepped pattern` + 匹配数 / 文件数 | 只显示 pattern + 文件名 | hook 小改 |
| await | `Monitoring background tasks` 组 | 「子任务完成 837682」+ 人形图标 | presenter 映射错 |
| Thinking | `Thinking` → `Thought for Ns` 流式 | 已对齐（阶段 G 打字机） | — |

***

## 2. Cursor 3.6.31 原生规则（bundle 复核结果，实施时按此移植）

以下函数名是 `workbench.desktop.main.js` 里的压缩名，供再次核对时 `rg -o 'function Jmd\(' …`。

### 2.1 步骤类型与分组主循环 `Jmd(steps, options)`

步骤三类：`thinking` / `assistant-message`（正文片段）/ `tool-call`（`toolCall.tool.case` 为工具 case 名）。

密度设置：`cursor.composer.editorConversationDensity`（编辑器内 Agent 面板）默认 **`detailed`**；
`cursor.composer.conversationDensity`（独立 Glass 窗口）默认 `compact-all-grouped`。用户截图 = 编辑器面板 = detailed。

UI 调用（`Z11`）实际传入：`groupThinking:true, groupText:true, textMaxLength:groupedTextMaxLength(默认 100),
isCompleted, minGroupSize: compact 模式为 2 / detailed 为 1, conversationDensity, separateShellGroups:false,
isToolGroupable(case): shell 且 compact→true；edit 且客户端 EDIT_FILE→false；否则 B3n(case, density)`。

```text
状态：out=[]，pending d=[]（活动组），browser m=[]，waiting h=[]
flushAll = h→qmd(h)，m→Umd(m)，d→Nei(d, minGroupSize)

for step b (index g):
  if shouldSkip(b)（工具调用正阻塞用户决策，如待答 ask_question）或 shouldDrop(b)（见 2.5）: continue
  if h 非空:
     b 是 assistant-message → flush h
     else if ttv(b)（thinking | await | read | grep(仅 terminals/*.txt 路径) | shell | mcp，且不是 edit/delete）→ h.push(b); continue
     else flush h
  if b 是 awaitToolCall (BAh):
     flush m；若 d 尾部是 thinking 则 pop 出来放进 h；flush d；h.push(popped?, b); continue
  if isCompleted && g 是最后一步 && b 是 assistant-message: flushAll; out.push(single b); continue
  k = Fmd(b)（浏览器 MCP：providerIdentifier 含 cursor-ide-browser / cursor-browser-extension，或 toolName 以 browser_ 开头）
  E = m 非空 && b 是 thinking
  if k || E: flush d；m.push(b)
  else:
     flush m
     A = d 非空
     if jev(b, A, opts):
        if d 非空 && Xev(d, b, separateShellGroups, density): flush d
        d.push(b)
     else: flush d；out.push(single b)
flushAll
```

谓词：

- `jev(b, hasPending, opts)`：thinking → `hasPending && groupThinking`；assistant-message → `hasPending && groupText && Omd(text)`；
  tool-call → 待审批 edit/delete 为 false，否则 `isToolGroupable(case)`。**thinking / 短正文只能加入已有组，不能开组**。
- `Omd(text, 100, 2)`：`length ≤ 100 && 行数 ≤ 2 && 不含 ``` / 标题 # / 列表 -* / 表格 |` 才可归组。
- `B3n(case, density)`（detailed 下）：`ZUv` 集合 → true；shell / delete / edit → **false**（仅 compact 为 true；edit 还要有 result 或 path）。
- `ZUv`（任何密度可归组的「探索类」）= `readToolCall, grepToolCall, globToolCall, lsToolCall, semSearchToolCall, readLintsToolCall,
  readTodosToolCall, fetchToolCall, webFetchToolCall, webSearchToolCall, getMcpToolsToolCall`。
- `XUv`（「轻探索」）= `readToolCall, lsToolCall`。
- `Xev(d, b, separateShell=false, density)`：b 非 tool-call → false；非 `compact-all-grouped` 时，组内已有 tool 与 b 的
  「是否 edit/delete」不同 → 切组；「是否 shell」不同 → 切组（detailed 下 shell/edit 本就不入组，此规则几乎不触发，仍原样移植）。

### 2.2 组的成型阈值

- `Nei(d, minGroupSize)`：`hasThinking = 有 thinking`；`allLight = !hasThinking && 每步是 assistant-message 或 XUv 工具`；
  `toolCount`；`singleShell = toolCount==1 && 含 shell`；`threshold = allLight ? max(min,3) : min`；
  `count = singleShell ? toolCount : hasThinking ? d.length : toolCount`；`count < threshold → 逐条 single`，否则一个 group。
  ⇒ detailed 下：`[read]` 单条；`[read, read, read]` 才折叠；`[read, thinking]` → 组（count 2 ≥ 1）；`[thinking, read]` → thinking 单条 + read 单条
  （thinking 不能开组）。
- `Umd(m)`：tool 数 < 2 → 逐条；否则 browser-group。
- `qmd(h)`：tool 数 < 2（`QUv=2`）→ 逐条；否则 waiting-group。

### 2.3 组摘要 `FAh` 与组头文案 `HAh`

摘要：`files`（read 路径 basename）、`directories`（ls）、`searches`（glob/grep/semSearch/webSearch/getMcpTools）、
`fetches`（fetch/webFetch）、`lints`、`commands`（shell）、`edits/deletes + fileChangeFiles + fileChangeStats{additions,deletions}`、
`taskCalls`、`thinkingDurationMs`（求和）、`hasText`。

组头 = `ltv ?? ctv ?? utv ?? ptv`：

| 条件 | loading | completed | details |
|---|---|---|---|
| 组内无 tool（纯 thinking/文本） | `Thinking` | `Thought`（thinking 首行是标题时用标题） | `for Ns` / `for 1.2s` / `briefly`（<500ms） |
| 含浏览器 MCP | `Running` | `Ran` | `N browser action(s)` |
| waitingActions>0 | `Monitoring background task(s)` | `Monitored background task(s)` | `N complete, M active` |
| commands>0 且全是 shell | `Running` | `Ran` | `N command(s)` |
| edits>0 | `Editing` | `Edited` | `htv`：单文件且 basename ≤ 20 字符 → 文件名，否则 `N file(s)`；再拼探索计数 |
| deletes>0 | `Deleting` | `Deleted` | 同上 |
| 全是 edit/delete 且无成功 | `Deleting` | `Delete` | `attempted` |
| 其余 | `Exploring` | `Explored` | `UAh`：`N director(y/ies)`, `N file(s)`, `N search(es)`, `N fetch(es)`, `lints`；再 `ran N command(s)`、`N agent(s)`；`, ` 连接 |

`fileChangeStats` 追加 `+a -b`，CSS：`[data-kind=additions]` 绿 `--cursor-text-green-primary`，`[data-kind=deletions]` 红 `--cursor-text-red-primary`。
有 edit 时探索计数首项加前缀 `explored `（如 `Edited 2 files, explored 1 file, ran 1 command +12 -3`）。

### 2.4 工具动词三态表 `zJv`（loading / completed / error）

```text
shell: Running/Ran/Run          read: Reading/Read/Read           ls: Listing/Listed/List
grep: Grepping/Grepped/Grep     glob: Searching files/Searched files/Search files
semSearch: Searching/Searched/Search        webSearch: Searching web/Searched web/Search web
fetch: Fetching/Fetched/Fetch   readLints: Reading lints/Read lints/Read lints
edit: Editing/Edited/Edit       delete: Deleting/Deleted/Delete   applyAgentDiff: Applying diff/Applied diff/Apply diff
updateTodos: Updating todos/Updated todos/Update todos   readTodos: Reading todos/Read todos/Read todos
mcp: Running MCP/Ran MCP/Run MCP            getMcpTools: Exploring tools/Explored tools/Explore tools
task: Working on task/Completed task/Work on task        await: Waiting/Waited/Wait
askQuestion: Asking question/Asked question/Ask question switchMode: Switching mode/Switched mode/Switch mode
```

Cursor **不显示单个工具的耗时**，只显示 Thought 时长。拾光行内保留中文动词（既有约定与测试），组头用 Cursor 英文原文
（与已有 `Thinking / Thought for Ns` 头一致）——若用户要求行内也切英文，只改 `TOOL_VERBS` 一张表。

### 2.5 `shouldDrop`（失败重试折叠）

同一工具连续两次调用、前一次 `status==='error'` 且 `modelCallId` 不同（模型重试）→ 前一次不渲染（TASK_V2 除外）。
本轮作为阶段 C 的可选项：块上没有 modelCallId，只能按「前一 failed、后一同名 tool、相邻」近似；先不做，记录在此。

### 2.6 Shell 卡（`ui-shell-tool-call`）实证

- 行文案：`Running`/`Ran` + description（去掉开头 `run `，首字母大写，缺省 `command`）+ line-summary（程序名列表）。
- 输出预览：`display:flex; flex-direction:column-reverse`（天然显示尾部）；`max-height: calc(5 * 18px + spacing)`；
  顶部 16px 渐隐 `::before` 线性渐变；点击展开为 `maxHeight 200` 的滚动区并 `autoScrollToBottom`（仅运行中）。
- 命令行以 `$ ` 前缀 + token 着色（command / flag / string / variable / operator）。
- **实时输出数据源**（CH-1 探针实证，18s tick 循环第 8s 命中）：现代形态 `toolCall.tool.value.result` 运行中**不存在**；
  旧形态 `toolFormerData.result.output` 已有部分输出（195 字符 / 前 12 行），`additionalData.status:'running'`。
  Cursor 的 shell UI 服务把流式输出定时 flush 进气泡 legacy result，每次 flush 走 `markDirty` ⇒ 我们的写后快照链路已覆盖，
  **无需新 hook 通道、无需 bundle 补丁**。（`shellOutputDelta` 协议事件在 3.6.31 的 `AgentResponseAdapter` 里被 `break` 忽略。）
- 完成后 result：`interleavedOutput`、`stdout/stderr`、`exitCode`、`executionTime`（ms）。

### 2.7 Edit / grep / read / await 内存形态（3.6.31）

| 工具 | args | result / additionalData |
|---|---|---|
| edit | `path`, `streamContent`（整文件，已在 OMITTED_INPUT_KEYS） | result：`linesAdded`, `linesRemoved`, `diffString`；`additionalData.precomputedDiff.lines[{type, content, originalLineNumber, modifiedLineNumber}]`（Cursor diff 卡就用它；折叠高度 80） |
| read | `path` | `readRange{startLine,endLine}`, `totalLines`, `fileSize`；正文是 blob 不内联 |
| grep | `pattern`, `path`, `outputMode` | `workspaceResults[*].result.matches[{file, matches[{lineNumber, content}]}]`, `totalMatchedLines`（阶段 D 实施前用 `/tmp/sg-eval.mjs` 再核一次真实字段名） |
| await | `taskId` | `awaitResult{ runtimeMs, exitCode, outputFilePath }`；组头按 `awaitResult.case==='complete'` 计 complete/active |
| thinking | `thinking.text`, `thinkingDurationMs` | — |

***

## 3. 现存缺陷（调研发现，阶段 B / C 修）

### RC-A：运行中的 shell 被判成「完成」

`cursor-stream-observer.ts` `toolInfo()`：`result = value?.result || td?.result`，随后
`status==='running' && result!==undefined → 'done'`。运行期间 legacy `td.result` 就已存在（装着部分输出），
所以一有输出流出卡片立刻变「完成」；`generatingBubbleIds` 在工具执行期间为空，兜不住。
**修法**：`td.status==='loading'` 或 `additionalData.status==='running'` 为运行权威；现代 result 缺席时 legacy result 只当
**部分结果**（供输出面板），不是完成证据。旧形态（无 additionalData）保留「有 result 即完成」回退。

### RC-B：`awaitToolCall` 被映射成 `task`

presenter `awaitToolCall: { kind: 'task', summary: taskId }` → 人形图标 + 「子任务完成」。应是等待后台命令：
kind 改 `command`（或新 kind），动词 `等待中/已等待`，分组归入 waiting-group。

***

## 4. 现状代码地图（改动落点）

```text
数据源  src/infrastructure/cursor/cursor-stream-observer.ts
          CURSOR_STREAM_HOOK_EXPRESSION：toolInfo（状态判定，RC-A）/ TOOL_PRESENTERS（每 case 的 kind/title/summary/hint/output）
          / present（clip 12k）/ processSnapshot（transport 过滤、items 组装）；CURSOR_STREAM_HOOK_VERSION = 26
解析    src/infrastructure/cursor/cursor-cdp-session-creator.ts
          CursorStreamToolBlock / parseProcessStream（字段白名单与长度上限，新增字段必须在此放行）
领域    src/domain/conversation-entry.ts
          ProcessBlockTool（toolKind/title/summary/hint/input/output/error/todos/question）→ 新增可选 toolCase / diff
合并    src/application/desktop-session-service.ts
          mergeProcessEvidence（upsert 块，字段透传）/ sealChannelVirtualProcess（封口写库：4k 裁剪落点）
投影    src/renderer/src/process-turn-view.ts
          blockStep / buildProcessTurnView（steps 扁平）→ 新增分组 items
渲染    src/renderer/src/ProcessTurnCard.tsx（compact 分支 = 会话页）、styles.css 1693–1800（.cursor-native-*）
预览    src/renderer/src/preview/mock-data.ts（live-* 过程块）、scripts/preview-shots.mjs（session-question-selected 场景可仿）
测试    tests/process-turn-view.test.ts、tests/process-blocks.test.tsx、tests/cursor-stream-observer.test.ts（VM 执行 hook 表达式）、
        tests/cursor-cdp-session-creator.test.ts、tests/desktop-session-service.test.ts
```

***

## 5. 阶段 A · 投影层分组（零数据改动）

目标：`buildProcessTurnView` 额外产出 `items: ProcessTurnItem[]`（单步 | 组），会话页按 items 渲染；`steps` 扁平数组保留（既有测试 / reveal 定位继续可用）。

### A1 领域：`toolCase` 可选字段

- `ProcessBlockTool.toolCase?: string`（Cursor 原生 case 名，如 `readToolCall`）；`CursorStreamToolBlock.toolCase?: string`；
  `parseProcessStream` 放行（`/^[a-zA-Z]{1,60}$/`）；hook `items.push` 带 `toolCase: tool.toolCase`；
  `mergeProcessEvidence` upsert 透传。**不 bump hook 版本**（纯追加字段，旧 hook 帧缺字段走回退）。
- 回退映射 `inferToolCase(block)`（投影层）：无 toolCase 时按 `toolName`/`toolKind`：
  `browser_*` 或 `mcp-*-browser_*` → 浏览器 MCP；`mcp-*` → `mcpToolCall`；`awaitToolCall`/`await` → `awaitToolCall`；
  toolKind read→`readToolCall`，search→`grepToolCall`，edit/write→`editToolCall`，command→`shellToolCall`，
  browser→`fetchToolCall`，todo→`updateTodosToolCall`，task→`taskToolCall`，question→`askQuestionToolCall`，other→undefined（不可归组）。

### A2 投影：`groupProcessSteps(steps, options)`

新文件 `src/renderer/src/process-step-groups.ts`（纯函数，无 React）：

```ts
export type ProcessGroupVariant = 'thought' | 'explore' | 'commands' | 'edits' | 'browser' | 'waiting'
export interface ProcessTurnGroup {
  kind: 'group'
  id: string                       // `group:${steps[0].id}`
  variant: ProcessGroupVariant
  action: string                   // Exploring / Explored / Ran / Edited / Thought …（按组 status 取 loading|completed）
  details?: string                 // '1 file' / '3 files, 2 searches' / '2 commands'
  fileChangeStats?: { additions: number; deletions: number }
  thinkingDurationMs?: number
  status: 'running' | 'done' | 'failed'
  steps: ProcessTurnStep[]
}
export type ProcessTurnItem = { kind: 'step'; step: ProcessTurnStep } | ProcessTurnGroup
export interface GroupingOptions { density: 'detailed' | 'compact-grouped' | 'compact-all-grouped'; isCompleted: boolean }
export function groupProcessSteps(steps: ProcessTurnStep[], options: GroupingOptions): ProcessTurnItem[]
```

- 逐条移植 2.1 / 2.2 / 2.3（Jmd / jev / Omd / B3n / Xev / Nei / Umd / qmd / FAh / HAh）；`ProcessTurnStep` 需带
  `toolCase?`、`approvalPending?`（暂无来源，恒 false）、`text`（message/thinking 正文供 Omd）、`hint` 里的 `+a −b`
  由投影层从 block.hint 解析（`/\+(\d+) −(\d+)/`）→ fileChangeStats；files 取 `target`/`summary` basename。
- `shouldSkip` 对应：待答 `question.status==='pending'` 的步骤不入组（单独成卡，Cursor 同款）。
- 组 status：任一步 running → running；否则任一步 failed → failed；否则 done。组头 `action` 在 running 用 loading 词。
- `buildProcessTurnView` 增加 `items`，默认 `density: 'detailed'`，`isCompleted = !running`。

### A3 渲染：compact 分支按 items 渲染

- 新组件段 `cursor-native-group`：头部 = 组图标（探索=搜索镜 / 命令=终端 / 编辑=笔 / 思考=灯泡 / 浏览器 / 等待）+
  `action` + `details`（`fileChangeStats` 用 `[data-kind]` 着色）+ 右侧 chevron；running 时头部动词用 loading 词 + 脉冲点。
- 展开态：组内 steps 逐行渲染为**轻行**（`cursor-native-row`：无边框卡，图标 + 动词 + 对象 + hint，单行），
  行本身可再展开明细（复用 `StepDetails`）。默认折叠；组内含 running 步骤时自动展开（对齐「直播时展开最新可见内容」的既有效果）。
- 组内 thinking 步骤沿用 `cursor-native-thought`（保留打字机 `StreamingTextBody`，`hydrate` 判据不变）。
- `expanded` 状态集合同时容纳 step id 与 group id；`toggleAll` 与 reveal 定位（`subscribeReveal`）需把所在组一并展开。
- 非 compact 分支不动。

### A4 测试（事件级）

`tests/process-step-groups.test.ts`（新）：
1. `[read, read, read]` → 1 组 `Explored 3 files`；`[read, read]` → 2 单条（allLight 阈值 3）。
2. `[read, thinking]` → 组（count 2 ≥ 1）含 2 步；`[thinking, read]` → 2 单条（thinking 不开组）。
3. `[grep, read]` → 组 `Explored 1 file, 1 search`（grep 非 light，阈值 1）。
4. detailed：`[shell, read, read, read]` → shell 单条 + 组；`[read, edit]` → read 单条 + edit 单条。
5. `[browser_navigate(mcp), browser_click(mcp)]` → browser-group `Ran 2 browser actions`；单个 → 单条。
6. `[await, await]` → waiting-group `Monitoring background tasks`；组内后续 shell/read 继续吸入；assistant-message 打断。
7. 组 id 稳定：blocks 增长（同组多一个 read）前后 `group.id` 不变；组内 running → done 时 `action` 由 `Exploring` 变 `Explored`。
8. 待答 ask_question 不入组。
9. 短正文（≤100 字符、≤2 行、无 Markdown 结构）在有 pending 时被吸入组，长正文不吸入。

`tests/process-blocks.test.tsx`：compact 渲染下出现 `.cursor-native-group` 与组头文案；展开后出现组内行；组内 thinking 仍是 `.cursor-native-thought`。

### A5 预览与走查

- `mock-data.ts` 直播场景补一组 `read ×3 + thinking` 与 `await ×2`；`preview-shots.mjs` 增加
  `session-process-groups-light/dark`（clip `.cursor-native-process`）。
- 走查项：折叠头与展开行的对齐、暗色、窄宽（720px 以下 hint 隐藏规则沿用）。

***

## 6. 阶段 B · Shell 独立卡 + 运行态修正 + 4k 尾部持久化

### B1 hook：RC-A 状态判定（不 bump 版本也可，但与 D 合并 bump 更省一次重装；**本阶段先不 bump**，用 VM 测试覆盖）

`toolInfo()`：

```js
const rawStatus = String(td?.status || value?.status || '').toLowerCase()
const additionalStatus = String(td?.additionalData?.status || '').toLowerCase()
const explicitlyRunning = rawStatus === 'loading' || additionalStatus === 'running'
let status = rawStatus === 'completed'||'success'||'done' ? 'done' : rawStatus === 'error'||'failed' ? 'failed' : 'running'
if (status === 'running' && !explicitlyRunning && result !== undefined) status = resultCase 为 error/failure ? 'failed' : 'done'
```

同时 shell presenter `output: p => p.interleavedOutput || joinStd(p) || p.output`（legacy 部分输出显式接入，不再依赖 outputText 兜底扫描）。
探针复核：实施前后各跑一次 `/tmp/sg-probe.mjs <composerId> 8000 running` 对照 18s tick 循环（只读 CDP，不影响任何进程）。

### B2 投影：shell 步骤元数据

`ProcessTurnStep` 增加 `command?: { text: string; programs?: string; exitCode?: number; output?: string }`（仅 kind=command）；
`exitCode` 从 hint 的 `exit N` 或 block.input/output 解析不可靠，改为 hook 在 hint 之外把 `exitCode` 放进 `block.input.__exit`?——
**不要**：新增可选字段 `ProcessBlockTool.exitCode?: number`（hook 写、parse 放行、merge 透传），投影直接读。

### B3 渲染：`cursor-native-shell`

- 头部：`Running`/`Ran`（中文沿用 `运行中/已运行`）+ description（无则命令首 50 字符）+ 程序名 hint；失败追加 `exit N` 红字。
- 正文：输出预览 `pre.cursor-native-shell__preview`，`display:flex; flex-direction:column-reverse; max-height: calc(5 * 1.5em + 8px); overflow:hidden`，
  `::before` 16px 顶部渐隐；running 时天然跟随尾部（column-reverse）；点击展开为 `max-height: 200px; overflow:auto` 并在 running 时
  `scrollTop = scrollHeight`（ResizeObserver / effect），完成后停止跟随。
- 命令行 `$ <command>`，简单 token 着色（首词 command、`-x` flag、引号 string、`$VAR` variable、`&& || | ;` operator）。
- 无输出的运行中命令：预览区显示 3 点脉冲；完成且无输出：不渲染预览区。

### B4 封口裁剪：尾部 4k

`src/domain/process-block-persistence.ts`（新，纯函数）：`clipProcessBlockForPersistence(block)`：
`kind==='tool' && toolKind==='command'`（及 `kind==='command'`）且 `output.length > 4096` → 保留尾部 4096 字符，前置
`…[已省略前 N 字符，仅保留输出尾部]\n`。`sealChannelVirtualProcess` 的 `settled` 映射后套用；直播层不裁。
测试：`tests/process-block-persistence.test.ts` + `desktop-session-service.test.ts` 事件序列
`running(无输出) → running(部分输出 6k) → completed(8k) → record_reply` 断言落库 output 长度 ≤ 4096+前缀、直播层 12k 不变、
封口后再来 keepalive 帧 `process_blocks_json` 字节不变（§8.4-1 既有断言沿用）。

### B5 测试

- `cursor-stream-observer.test.ts`（VM 执行 hook）：legacy result 存在 + `additionalData.status:'running'` → `running` 且 `output` 含部分输出；
  `td.status:'completed'` + 现代 result → `done`；旧形态无 additionalData 有 result → `done`（回退不变）。
- `process-blocks.test.tsx`：shell 卡默认可见 `.cursor-native-shell__preview`，失败显示 `exit 1`，running 有脉冲。

***

## 7. 阶段 C · 头部降噪 + 动词对齐 + await 映射

- C1 移除行内估算耗时：`stepDuration` 只在 `durationMs`（原生）存在时返回；`timingEstimated` 的 `~Ns` 不再渲染在行上
  （回合总览 summary 的「观测 ~Ns」保留）。done 行右侧只保留 chevron；running 保留脉冲 + 状态词；failed 保留红字状态词；问卷状态词保留。
- C2 动词表补全：`TOOL_VERBS` 增加按 `toolCase` 的细分（ls：列出中/已列出；glob：搜索文件中/已搜索文件；semSearch：语义搜索中/已语义搜索；
  webSearch：搜索网页中/已搜索网页；fetch：抓取中/已抓取；readLints：读取诊断中/已读取诊断；await：等待中/已等待），无 toolCase 回退 kind 表。
- C3 RC-B：presenter `awaitToolCall → kind 'command'`（图标终端）、summary `taskId`、hint 由 `awaitResult`（runtimeMs / exitCode）生成；
  分组按 2.1 进 waiting-group。
- C4 shell 头部 description 去掉开头 `run ` 并首字母大写（Cursor `iav/rav` 同款）。
- 测试：更新 `process-turn-view.test.ts` 的 stateText/verb 断言；新增 await 用例。

***

## 8. 阶段 D · hook v28：结构化 diff（红绿）+ grep 摘要

- D1 领域：`ProcessBlockTool.diff?: { lines: Array<{ type: 'added' | 'removed' | 'context' | 'hunk'; text: string; oldLine?: number; newLine?: number }>; truncatedLineCount?: number }`；
  `CursorStreamToolBlock.diff` 同形；`parseProcessStream` 放行（实时行数 ≤ 240，每行 ≤ 300 字符）。
- D2 hook：`editToolCall` presenter 增加 `diff: (a, p, td) => fromPrecomputedDiff(td.additionalData?.precomputedDiff?.lines)`
  （type 映射：Cursor 的 `type` 取值实施前用 `/tmp/sg-eval.mjs` 核实——CH-1 探针的 `editDiffLineTypes` 结果未留档）；
  `grepToolCall` 解包 `workspaceResults` → hint `N matches · M files`，output 为 `file:line: content` 列表（≤ 200 行）。
  `CURSOR_STREAM_HOOK_VERSION = 28`（v27 已用于阶段 C；在位重装机制现成，拾光桌面端下次连接即生效）。
- D3 渲染：edit 行 hint 拆成 `<span data-kind=additions>+N</span><span data-kind=deletions>−M</span>`（绿/红，`light-dark()` 双值，
  只用于增删语义——符合 DESIGN-SYSTEM「状态色不作装饰」）；展开为 `cursor-native-diff` 按行着色（added 绿底、removed 红底、context 灰，
  左侧旧/新行号），折叠高度 80px 可展开；无 `diff` 时回退现有 `diffString` 代码块。
- D4 持久化：`diff` 随块进 `process_blocks_json`；直播层最多 240 行，封口落库最多 120 行，超出数量累加到 `truncatedLineCount`；Shell 4k 尾部裁剪保持独立。
- 测试：hook VM 用例（precomputedDiff → diff 行；grep → hint/output）；parse 放行与上限；渲染红绿与回退。

***

## 9. 进度日志（每完成一步追加，最新在下）

| 时间 | 阶段 | 完成内容 | 验证 |
|---|---|---|---|
| 09-11 20:40 | 文档 | 建立本任务书；复核 bundle：Jmd / jev / Omd / B3n / Xev / Nei / Umd / qmd / FAh / HAh / zJv 动词表 / shell 卡 CSS 常量（预览 5 行、渐隐 16px、展开 200px、diff 折叠 80px、绿红变量） | 只读，无代码改动 |
| 09-11 20:50 | A | A1 `toolCase` 可选字段贯通：`ProcessBlockTool` / `CursorStreamToolBlock` / `parseProcessStream`（`/^[a-zA-Z]{1,60}$/` 放行）/ hook items / `mergeProcessEvidence` 透传，hook **未** bump。A2 新建 `src/renderer/src/process-step-groups.ts`：Jmd 全部谓词与摘要、组头逐条移植（含 `shouldSkip` 待答问卷、await 尾部 thinking 迁入等待组、compact 密度 minGroupSize 2）；`ProcessTurnStep` 增加 `toolName` / `toolCase`。A3 `ProcessTurnCard` compact 分支按 items 渲染：`cursor-native-group`（组头 + 计数 + 增删绿红）、组内成员为 `is-nested` 轻行；**尾组直播预览窗**按 Cursor `ytv` loading 态移植（限高 144px、column-reverse 贴底、顶部淡出遮罩、成员文字降对比、点击展开；条件 = 尾组 && 未手动展开 && (live ‖ 组内有 running)），组默认折叠、不自动展开——回合结束即得紧凑收尾。右栏定位 `revealStep` 连同所在组展开。A5 mock 直播场景补 read×3 + browser MCP×2；截图场景 `session-process-groups-{light,dark}` / `session-process-group-expanded`。 | typecheck ✅（期间一次报错来自其他 Agent 的 session-warmup WIP，已自愈）；`tests/process-step-groups.test.ts` 新增 17 用例 + process-blocks / cursor-cdp / cursor-stream-observer 各补断言，过程流相关 7 文件 200 用例全绿；knip 无输出；预览截图浅/深/展开三张走查通过（组头、轻行、shell 独立卡、问卷卡共存） |

| 09-11 21:05 | B | B1 hook `toolInfo`：`td.status==='loading'` / `additionalData.status==='running'` 为运行权威，显式运行时 result 只当部分结果（RC-A 修复，**未** bump 版本）；shell presenter `output` 显式接入旧形态 `p.output`。B2 `ProcessTurnStep.shell{command,output,exitCode,error}`（exitCode 由 hint `exit N` 解析）。B3 `ProcessTurnCard`：`ShellBody`（`$ 命令` 着色行 + 输出预览：5 行 column-reverse 贴底 + 顶部渐隐；点击/头部切换 200px 展开态，运行中 effect 贴底；无输出运行中三点脉冲；error 红框）、新模块 `shell-command-tokens.ts`（command/flag/string/variable/operator 分词，token 拼回即原文）；shell 命令从头部移入正文。B4 新建 `src/domain/process-block-persistence.ts` `clipProcessBlockForPersistence`（尾部 4096 + `…[已省略前 N 字符，仅保留输出尾部]`，未超限保持同一引用），接在 `sealChannelVirtualProcess` 的 `settled` 之后；直播层不裁。**实证**：用 `/tmp/sg-eval.mjs` 在本会话 composer 上并行探针 3 次——运行中 `td.status:'loading'`、`additionalData.status:'running'`、无现代 result、legacy `{output(部分), exitCode:0, endedReason:0, notInterrupted:false}`；完成后现代 result 键 `command/workingDirectory/exitCode/signal/stdout/stderr/executionTime/interleavedOutput/localExecutionTimeMs`。 | hook VM 用例「running(无输出)→running(部分输出)→completed→旧形态回退」；`desktop-session-service` 事件序列「6k 部分 → 8k 完成 → record_reply → 落库尾部 4k + 前缀、直播层 8k、封口后 keepalive 回流字节不变」；`process-block-persistence` 4 用例；`shell-command-tokens` 4 用例；process-blocks shell 卡 running/waiting/failed 断言。全量 156 文件 / 1473 用例全绿，typecheck、knip 干净；截图 `session-process-groups-light/dark` 走查通过 |

| 09-11 21:12 | C | C1 会话页工具行不再显示耗时（`~0.1s` 采样噪音移除；Thought 头仍显示原生 / 估算时长）；完成态不再重复「完成」状态词，只保留进行中（脉冲）/ 失败 / 问卷状态（`compactStateText`）。C2 `CASE_VERBS`：按原生 case 细分 ls / glob / semSearch / webSearch / fetch / webFetch / readLints / delete / readTodos / getMcpTools / await 的三态动词，无 toolCase 回退 kind 表。C3 RC-B：hook presenter `awaitToolCall → kind 'command'`，hint 为运行时长 + 非零退出码（`awaitHint` 解 `awaitResult{case, value}`）；投影层 await 不生成 shell 卡数据（`isShell = command && toolCase !== 'awaitToolCall'`）。C4 `normalizeShellDescription`：去掉开头 `run ` 并首字母大写（Cursor `iav`）。**hook bump 26 → 27**（覆盖 B1 / C3 / toolCase）。 | 测试：process-turn-view 新增 case 动词 / await / 描述归一用例；process-blocks 状态词与耗时断言改写 + 新增 running/failed 状态词与 Thought 时长保留用例；hook VM 新增 await 用例。5 文件 118 用例全绿；typecheck 干净；截图 `session-process-group-expanded` 走查：行内无耗时无「完成」 |

| 09-11 21:40 | D | D1 `ProcessDiff`（added / removed / context / hunk + 双行号 + 截断计数）贯通 domain、hook、CDP parser、DesktopSessionService、投影与持久化。D2 hook v28：优先读取 `precomputedDiff.lines`，缺失时解析 `diffString`；grep 解包 content/files/counts 三种结果，输出匹配数、文件数与精简命中行。D3 Edit 行 `+N` 绿、`−M` 红；展开为逐行红绿 diff，旧/新行号列按最大位数动态扩宽并禁止换行；无结构化 diff 时保留旧文本回退。D4 直播最多 240 行，封口最多 120 行并累计截断数。 | typecheck ✅；过程流相关 8 文件 187 用例全绿；截图 `session-process-diff-{light,dark}` 复核通过，四位行号 1728 保持单行、浅深主题语义色与 Shell/问卷共存正常。最终全量 test / knip / build / smoke 待执行 |

| 09-11 21:44 | 全量验证 | 对 A–D 完整链做最终对抗复核：分组 identity 保持首块稳定；transport 噪音仍只在 hook/parser 过滤；Shell 直播 12k 与封口尾部 4k 分层不变；Diff 直播 240 / 落库 120 分层不变；非 compact 兼容入口未改。 | typecheck ✅；156 文件 / 1485 用例全绿；knip ✅；build ✅；smoke:channel ✅；git diff --check ✅。未主动消耗 Cursor 会话，真实单会话验收留给用户安排时机 |

| 09-11 23:19 | 编辑流式尾窗 | 固定版 Cursor 3.6.31 实证链补齐：`streamContentDelta` 经 Handler 按帧 / 最长 250ms flush 到 `bubble.params.streamingContent`；hook v29 只读该字段并解析为既有 `ProcessDiff`，不下发原始大字符串。运行态保留最新 240 行、卡片自动展开为 5 行高尾窗并随最后内容原地贴底，当前尾行强调；完成后同一 block / DOM 切最终双行号红绿 diff，历史只落最终状态。 | 真实形态 VM 测试（modern args 不含增量、仅 params.streamingContent）✅；running→growing→done 同 id、240 行尾部窗口、原始输入脱敏 ✅；React 同 DOM + 自动贴底 + 完成态切换 ✅；浅/深截图 `session-process-edit-stream-*` 走查通过 |

| 09-11 23:37 | Shell 超栏修复 | 根因是工具头已收为三列，右侧 meta 仍指向第 4 列，Grid 因此生成隐式列；同时过程流与 Shell 正文缺少 `minmax(0, 1fr)` / `min-width: 0` 的完整收缩链，长 monospace 命令会按 min-content 撑破会话栏。统一修正为三列并补齐 process → flow → shell body → command/output 的宽度约束；命令单行省略，输出允许任意长行换行。 | 900px 窄窗浅/深实测：长绝对路径卡片 `514px`，`scrollWidth=clientWidth=512px`；card ⊆ flow ⊆ timeline；页面无水平溢出；卡片右边框、状态、箭头完整 ✅ |

| 09-11 23:45 | 编辑直播链路修复 | 查明“组件预览有动画、实机只在结束时瞬现”的数据层断点：`processBlocksFingerprint()` 对 tool 块漏算 `diff`。同一 edit block 流式增长时 id/status/path 恒定，服务层把约 250ms 的连续 diff 帧全部误判为未变化；只有结束状态翻转才发布最终帧。fingerprint 纳入结构化 diff，保持既有同 id 原地更新，不新增旁路状态。 | 新增 DesktopSessionService 集成回归：两帧仅 diff 尾行 `tail-1 → tail-2` 变化，第二帧必须进入 `liveProcess` 且 `updatedAt` 推进；此前实现会在该断言失败。observer → service → renderer 相关 3 文件 118 用例通过 ✅ |

| 09-11 23:52 | 编辑卡默认形态补齐 | 图 1 证明仅有“展开后的完整 diff”仍不符合 Cursor：已完成编辑重挂载后默认缩成单行，用户看不到代码。compact 会话流现改为进行中固定 5 行尾窗并自动贴底；完成后默认保留以首个真实增删为中心的紧凑代码预览（隐藏行号，红绿底与左侧语义线）；点击头部展开完整双行号 diff。非 compact 兼容入口与其它工具详情逻辑保持原样。 | 新增 `session-process-diff-preview-{light,dark}`；浅/深完成态预览与进行态五行尾窗四张截图走查通过；相关 3 文件 118 用例通过 ✅ |

| 09-11 23:58 | 旧会话 Diff 兼容 | 实查 `task-pool.sqlite3`：图 1 所在的旧回复编辑块并非缺少改动数据，完整 unified diff 保存在 `output`，只是 v28 前没有 `diff` 字段。视图投影增加只读兼容解析（要求真实 `@@` hunk 且至少一个增删行，240 行/单行 300 字上限），统一进入现有预览组件；不迁库、不改原记录。 | 用本机旧回复确认 `42` 个 edit 块均为 `output=unified diff / diff=null`；新增 legacy 落库形态回归，现有旧卡可直接显示紧凑预览；过程流相关 4 文件 131 用例通过 ✅ |

| 09-12 00:14 | Cursor 编辑卡结构重做 | 依据参考图撤掉“通用工具卡 + 内嵌 Diff”的错误结构，编辑步骤改成独立文件卡：头部只显示语言徽记、basename、增删统计；完整路径仅保留在 title；正文与头部共用外框/hairline，默认最多四行上下文，红绿底及 4px 左侧语义线；展开箭头固定在代码区底部中央。加入零依赖轻量语法着色（关键字/名称/字符串/数字/注释/操作符），长行单行裁切。Shell、分组、MCP、问卷分支未改。 | `session-process-diff-preview`、完整展开、编辑直播浅/深截图复核；卡片层级、文件名、语言徽记、统计、语义色、箭头均与参考结构一致；相关 4 文件 131 用例通过 ✅ |

| 09-12 00:24 | 编辑卡悬浮箭头与头部基线 | 修正参考遗漏：移除正文永久 `27px` 底部占位，箭头改成绝对定位覆盖层；静止态 `opacity:0` 且不接收鼠标，整卡 hover / 键盘 focus 时才连同底部渐隐托底出现。头部 `语言/文件名/+N−N` 统一为 Anthropic Sans、14px、600、20px 行高，并为三列设定同高 20px 对齐盒，消除混用 mono/numeric/sans 造成的基线参差。 | 浅色静止截图无箭头且无空行；hover 截图箭头浮于代码上；暗色静止同样通过；相关 19 项渲染测试与 typecheck 通过 ✅ |

**A 阶段发现的算法事实（实施时确认，已写入测试）**：单个非轻探索工具（grep / glob / fetch / semSearch）在 detailed 下也成组
（`Nei` 阈值 = minGroupSize 1，仅 read/ls 才要 3）——Cursor 自身即如此渲染「Explored 1 search」；compact-grouped 下 edit 与非 edit、
shell 与非 shell 不混组（`Xev`），只有 compact-all-grouped 才出现「Edited styles.css, explored 1 file」这类混合组头。

***

## 09-12 修订：编辑卡六项回归（覆盖此前验收结论）

- DiffView 明确区分 live / preview / full；文件卡不再加入自动展开集合。未手动展开时，运行中五行跟随，结束后四行预览；手动展开后停止抢滚动，收起后恢复跟随。右栏定位仍走既有 expanded。
- 失败编辑保留错误说明并标记“编辑失败”；旧 output 中的 unified diff 只读解析保留原有行长及行数，不迁库。此举只恢复已有数据；上游早已裁剪的内容不会凭空补回。
- 完整代码窗支持横向滚动，宽度约束保持。四字符语言标识使用内容宽度，避免 HTML/YAML 与文件名相撞。
- hover / :focus-visible 控制覆盖箭头，鼠标点击留焦点再移出时隐藏；键盘 Tab 聚焦时可见，无底部空行。
- Chromium 浅深 900px 交互实测：预览高度 151.75px，hover 前后同高；展开代码窗 scrollLeft=273，卡宽恒 514px；点击移出隐藏、Tab 再显示均通过。
- 组件回归覆盖完整生命周期、同 DOM、手动滚动保留、失败详情、旧数据 366 字符/250 行。全量 156 文件 / 1492 测试通过。
- 真实付费 Cursor 编辑生成本轮未发起。浏览器夹具和组件/服务回归与实机生成验收分开记录。

## 10. 完成定义

1. 会话页过程流：连续探索类调用折叠为 `Explored …` 组头，展开可见每行；shell 独立卡默认内联输出预览并实时跟随尾部，运行中不再被判「完成」；
   编辑行 `+N` 绿 `−M` 红，展开为按行着色 diff；行内不再出现 `~0.1s`。
2. `[read, thinking]` / `[thinking, read]` / `[read×3]` / `[shell, read×3]` / `[await×2]` 的分组结果与第 2 节规则一致，且组 id 在块增长时稳定。
3. 封口后 `process_blocks_json` 中 shell 输出 ≤ 4k 尾部；直播层不裁；封口后 keepalive 帧字节不变。
4. `npm run typecheck`、全量 `vitest`、`npm run build`、`npm run smoke:channel` 通过；预览截图矩阵含 `session-process-*` 浅/深。
5. 实机验收（用户安排时机，只发一个测试会话）：让 Agent 连续读 3 个文件 + 跑一条 10 秒以上有输出的命令 + 编辑一个文件，
   观察折叠头、实时输出、红绿 diff；重启拾光后历史一致。
