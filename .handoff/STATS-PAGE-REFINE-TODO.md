# 交接任务书：设置页「统计」精致化重构（对标 Cursor 原生 Usage 页）

> **状态（2026-09-22 21:10）：任务书起草完成，S1 动工中。** 分支 `feat/stats-refine`，worktree `../SG-Team-stats`（`node_modules` 软链主仓）。
> 每完成一步在 §7 追加一行；中断后接手者只读 §0、§4、§7 即可定位。主工作树的未提交文件属其他 Agent——**不要碰**。
>
> 项目：拾光 / SG Team（`shiguang-team` 0.4.3）· 仓库 `lyr339/SG-Team` · 基线 main `df98b5d`。
>
> 来源：CH-2 2026-09-22 20:58 对用户三张截图（Cursor Usage 页 / 拾光统计页真实数据 / Cursor 事件表）与 `SettingsStats.tsx` / `stats.css` / `stats-view.ts` 的逐项对照分析（分析全文已随 CH-2 回复归档；§1 是摘要）。
>
> 用户拍板（09-22 21:0x）：「我要的就是设计精致、用户友好、交互丝滑，可以开工，先写任务书，做到哪更新到哪」——未逐项否决分析里的四个取舍，**按分析建议执行**（§0.2）；用户之后若改口，改 §0.2 的对应行即可，切片按行调整。

***

## 0. 接手人先读

### 0.1 一句话

把统计页从「数据即装饰、细节藏在 hover 里」改成 Cursor Usage 页那种**一眼可读**的形态：三张 KPI 卡 → 带坐标系与图例的趋势图（可按席位 / 模型 / 分组切分）→ 逐回合明细表（右对齐、导出 CSV、分页计数）；同时把壁纸、色彩、字号、格式这些「看着粗」的根因一次收掉。功能面（席位筛选、键盘漫游、缓存命中率、节省估算、质量徽章）**只增不减**。

### 0.2 已拍板的决策（不要再讨论）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 是否推翻 09-13「不设 KPI 英雄带」的决策 | **推翻**。首屏放三张等宽 KPI 卡（成本 / Tokens / 回合），光谱带降级为 KPI 下方带标题与图例的「席位份额」行，筛选能力保留 |
| D2 | 统计页卡片是否随外观偏好透明 | **不随**。统计页卡片一律实底（`--surface-solid`），是数据页对壁纸的例外；壁纸偏好本身不动 |
| D3 | 明细表粒度 | **逐回合事件表为默认视图**（Cursor 式），「按会话」汇总保留为同一张表的第二视图（分段切换） |
| D4 | 范围预设 | 加 **本月（MTD）/ 上月**；自定义起止日期**不做**（P3，另开任务） |
| D5 | Included / On-demand 两张卡 | **不做**。我们只有等价 API 成本，没有 Cursor 计费 / 额度数据；不伪装计费口径 |
| D6 | 图表实现 | 继续 div/CSS，不引图表库（运行时依赖仍是 `ws` + `zod` + `electron-updater`） |
| D7 | 全局 `formatCostUsd` / `formatClock` | **不改**（会话页、用量弹层、聊天都在用）。统计页用自己的 `formatStatsCost` / `formatStatsTime`；全局修正另记 follow-up |

### 0.3 实施纪律

1. 每个切片（§4）独立可合入、全绿后再进下一片；切片内先改 `stats-view.ts`（纯函数 + 单测）再改组件与 CSS。
2. 测试与预览探针的选择器契约见 §5.3——改类名前先搜 `tests/settings-stats.test.tsx`、`scripts/preview-shots.mjs`。
3. 所有新增动效有 `prefers-reduced-motion` 关闭分支；所有颜色状态都有文字 / `aria` 对应（`docs/DESIGN-SYSTEM.md`）。
4. 每片结束跑：`npm run typecheck` · `npx vitest run tests/stats-view.test.ts tests/settings-stats.test.tsx` · `npm run preview:shots -- --only settings-stats`（若脚本不支持 `--only`，跑全量并只看 stats 场景）。合回前跑全量 `npm test` + `npm run lint:dead`。
5. 视觉验收以**稀疏态**（§5.2 `?stats=sparse`：1 个主席位 + 1 个只有几百 token 的席位、6 回合集中在一小时）为第一标准——真实用户一天就是这样，09-13 的版本正是因为只对着丰满 fixture 设计才翻车。

### 0.4 文件地图

| 文件 | 角色 | 本任务动作 |
|---|---|---|
| `src/renderer/src/settings/stats-view.ts` | 纯视图模型 `buildSessionStatsView` | 扩范围 / 分组维度 / 逐回合行 / Y 轴刻度 / 折叠「其他」/ CSV 构造 / 统计页专用格式函数 |
| `src/renderer/src/settings/SettingsStats.tsx` | 页面组件 | 重排结构（§2.1）；保留 hover 卡、键盘漫游、数值缓动、隐藏冻结 |
| `src/renderer/src/settings/stats.css` | 页面样式 | 重写尺度与色彩（§2.2）；实底卡片 |
| `src/renderer/src/settings/settings-view.ts` | `SettingsPageProps` | 不动（`usageSnapshot / statsSeats / statsGroups` 已够用） |
| `src/renderer/src/App.tsx` L826–870 | `statsSeats` / `statsGroups` 投影 | 不动 |
| `src/domain/cursor-usage.ts` | 账本、牌价、`formatCostUsd` / `formatTokenCount` | 不动（D7） |
| `src/renderer/src/preview/preview-main.tsx` L709–771 | `?stats=1` fixture | 加 `?stats=sparse` |
| `scripts/preview-shots.mjs` L477–497 | 截图场景 | 场景改名 / 加稀疏场景 / 探针 |
| `tests/stats-view.test.ts`（13 例）· `tests/settings-stats.test.tsx`（17 例） | 单测 | 按 §5.1 增改 |
| `docs/DESIGN-SYSTEM.md` · `docs/UI-STRUCTURE.md` · `docs/ARCHITECTURE-LOG.md` | 长期记录 | S6 收口时写 |

***

## 1. 现状与根因（摘要）

真实数据截图（09-22，1 天 622K tokens / 6 回合 / 主要 1 个席位）下：

1. **首屏无锚点**：最上面是一条无标题无图例的 14px 光谱带（97% 单色），下面一行把 `$0.878 · 622K tokens · 6 回合 · 缓存节省 86%（$5.53）· 累计` 五个信息用竖线挤在一起，23px/650 字重的数字与 12px 小字同行。
2. **图表无坐标系**：`.stats-bars` 只有一根底线，无 Y 轴、无网格、无图例；X 轴抽稀到 0/6/12/18 时，唯一那根柱落在 20 时却没有刻度——不悬停读不出值也读不出时间。
3. **「条纹帽」渲染缺陷**：每段 `Math.max(share, 1.5)%` 最小高度 + `.stats-bars__stack { gap: 1px }` + 每段 `border-radius: 2px`，几百 token 的席位被强制画成 1.5% 高的一条线，叠在柱顶成条纹。真实数据必现。
4. **壁纸与数据色打架**：折光 / 极光渐变透过 74% 半透明卡片；8 色席位板 + 4 桶色 + accent + 质量徽章色叠在同色系壁纸上。
5. **尺度与密度**：正文几乎全是 `--fs-10/--fs-11`（= 12px），卡片 padding 13/15px，五档字号；Cursor 约 13px 正文、24px 常规字重数值、24px 卡内留白、三档字号、单一数据色。
6. **格式与文案**：`$0.878` 三位小数；`截至 08:53 PM`（`formatClock` 跟系统 locale 的英文 12 小时制）；「累计」实为 31 天保留窗；「等价 API 成本」口径声明 12px 淡字几乎不可见；成本/Tokens 切换远离它控制的图表；术语偏文学（节奏 / 光谱 / 构成 / 命中）。
7. **明细表**：会话聚合、数字左对齐、无导出、无每页选择、无「第 x–y 条 · 共 n 条」，且不在首屏；Cursor 是逐请求事件日志。

Cursor 页有而我们没有的可复现细节：解析后的真实日期文本 + (i) 图标；MTD / 上月预设；三张 KPI 卡；图表副标题句子；Group By 下拉；Y 轴刻度 + 网格 + 轴标题；柱下直接标日期；底部图例；`Export CSV`；`Rows` 选择器；`Showing x–y of n`；数字右对齐；表头注明时区口径。

***

## 2. 目标设计规格

### 2.1 页面结构（从上到下；类名即契约）

```text
.settings-stats
├─ .stats-controls                控制行
│  ├─ .stats-range[aria-label=统计时间范围]   今天 | 7 天 | 30 天 | 本月 | 上月
│  ├─ .stats-controls__dates                 解析后的日期：9月22日 / 9月16日 – 9月22日 / 9月1日 – 9月22日 / 8月1日 – 8月31日
│  └─ .stats-controls__info (i)              悬浮：等价 API 成本口径 + 截至 HH:mm + 「累计 = 近 31 天保留窗」
├─ .stats-kpi                     三张等宽卡（grid 3 列，<720px 降 1 列）
│  ├─ .stats-kpi__card.is-cost    标签「成本」· 大数 $0.88 · 副行「缓存节省 86% · $5.53」（无节省时「按公开牌价折算」）
│  ├─ .stats-kpi__card.is-tokens  标签「Tokens」· 大数 622K · 副行「输入 617K · 输出 4.8K」
│  └─ .stats-kpi__card.is-turns   标签「回合」· 大数 6 · 副行「2 个会话 · 全部精确 / 精确 N」
├─ .stats-caption                 一行淡字：近 31 天累计 $100.14 · 104M tokens（右侧：等价 API 成本 · 截至 20:53）
├─ .stats-seats                   「席位份额」行：小标题 + 光谱带（.stats-spectrum，段位 .stats-spectrum__segment 保留）+ 行内图例（色点 · 名称 · 值 · %）
│  └─ .stats-filter-chip          筛选中出现「仅看 X ×」
├─ .stats-card.stats-card--trend  「用量趋势」（跨两列）
│  ├─ header: strong 用量趋势 · span 副标题「按小时 · 今天」/「按天 · 9月16日 – 9月22日」
│  │  └─ 右侧控件簇 .stats-card__tools：度量分段（成本 | Tokens，aria-label=统计度量）+ 分组 <select>（席位 / 模型 / 分组 / 不分组）
│  ├─ .stats-chart（grid：Y 轴 44px | 绘图区；底部 X 轴 18px）
│  │  ├─ .stats-chart__axis-y     4 个刻度标签（0 与 3 个 nice 步长），右对齐
│  │  ├─ .stats-chart__grid       每刻度一根 1px 网格线（含 0 基线）
│  │  ├─ .stats-bars（保留 role=img / tabIndex / 键盘漫游 / hover 卡 / is-active 列高亮）
│  │  └─ .stats-chart__axis-x     刻度：有数据的桶必标，其余按抽稀规则；相邻碰撞时保留值大的
│  └─ .stats-legend               底部图例：色点 · 系列名 · 值（按度量）；不分组时不渲染
├─ .stats-grid                    第二行卡片
│  ├─ .stats-card「Token 构成」     现有结构保留（混合条 + 四行 + 每席位行 + 节省注脚）
│  ├─ .stats-card「模型分布」       现有结构保留
│  └─ .stats-card「分组」           仅有 active 组时出现（现有）
└─ .stats-card.stats-card--table  「明细」
   ├─ header: strong 明细 · 视图分段 .stats-table__view（逐回合 | 按会话）· 右侧 .stats-export 按钮「导出 CSV」
   ├─ .stats-table__scroll > table.stats-table
   │  ├─ 逐回合列：时间 · 会话（头像 + 名 + CH-n）· 模型 · Tokens(num) · 成本(num, 数据条) · 质量
   │  └─ 按会话列：会话 · 模型 · 回合(num) · Tokens(num) · 成本(num, 数据条) · 质量 · 最后活动
   └─ .stats-pager：每页 <select>（10 / 20 / 50）· 「第 1–20 条 · 共 46 条」· 上一页 / 下一页
```

删除：账本行 `.stats-ledger*`（信息分流到 KPI 卡与 caption）；控制行里的度量分段（迁入趋势卡）；`.stats-card--rhythm`（改名 `--trend`）。

### 2.2 视觉规格

- **实底**：`.stats-kpi__card` 与 `.stats-card` 背景 `var(--surface-solid)`，覆盖 `html[data-card-transparency="clear"]` 规则；边框 `--color-border-tertiary`，圆角 14px，阴影 `--shadow-hairline`（不变）。
- **尺度**：卡片 padding `18px 20px 20px`；卡间距 16px；KPI 大数 `28px / 500 / var(--font-numeric) / tabular-nums / letter-spacing -0.01em`；KPI 标签 `--fs-11` `--text-soft`；KPI 副行 `--fs-11` `--faint`；卡标题 `--fs-13 / 600`；卡副标题与元信息 `--fs-11` `--faint`；表格正文 `--fs-12`；轴刻度与图例 `--fs-11`。全页只用 `--fs-11 / --fs-12 / --fs-13 / 28px` 四档。
- **色**：席位分类板 `--stats-c0..c7` 只出现在光谱带、趋势图（按席位 / 按分组时）、图例、Token 构成的席位行；按模型分组时同一分类板按模型序取色；不分组时单系列用 `color-mix(var(--accent) 62%, var(--color-background-secondary))`（与模型分布条同源）。「其他」折叠段用 `--stats-history` 灰。四桶色不变（`--usage-output` 钉橙）。质量徽章色不变。
- **柱**：段与段之间 **无 gap、无独立圆角**；整根柱顶 2px 圆角（stack 容器 `overflow: hidden`）；单柱最小可见高度 2px 只作用于整根柱。列悬停底色 `--color-background-secondary` 保留。
- **网格**：1px `--line-faint`；0 基线 `--line-strong`。
- **动效预算**：hover 120ms；柱高 / 段宽 300–320ms；KPI 数值缓动 400ms（现有 `useAnimatedNumber`）；表格换页淡入 160ms；全部受 `prefers-reduced-motion` 关闭。

### 2.3 文案与格式

- `formatStatsCost(v)`：`0 → $0.00`；`0 < v < 0.005 → <$0.01`；其余两位小数。
- `formatStatsTime(at, unit)`：`today → HH:mm`；多日 → `M/D HH:mm`；固定 24 小时制，不走 locale。
- `formatStatsDateRange(range, now)`：见 §2.1 控制行示例；`–` 用 en dash 两侧空格。
- 「累计」一律写「近 31 天累计」。
- 标题：成本节奏 → **用量趋势**；会话明细 → **明细**；命中 N% 保留（Token 构成的席位行已有解释 title）。
- (i) 悬浮文案：「费用为按公开牌价折算的等价 API 成本，与 Cursor 实际扣费口径不同。数据截至 HH:mm；累计为近 31 天保留窗内的合计。」

### 2.4 交互

- 范围切换：桶重建、活跃桶清空、表格回第 1 页（现有）；日期文本与趋势卡副标题同步。
- 席位筛选：光谱段位 / 图例项点击 = 筛选；chip 清除；KPI、趋势、构成、模型、明细全部收窄；光谱带与分组卡不收窄（现有口径）。
- 分组维度：`<select>` 切换只重算 `bucket.parts` 与图例，不影响 KPI / 表格；选中态持久到组件 state（不落 localStorage）。
- 度量切换：只影响趋势图 Y 轴 / 柱 / 图例 / 模型条 / 表格默认排序（现有语义），KPI 三卡不受影响。
- 明细视图切换：逐回合 ↔ 按会话，各自记忆排序键；切换回第 1 页。
- 导出 CSV：导出当前范围 + 当前筛选 + 当前视图的**全部**行（不只当前页）；UTF-8 with BOM；文件名 `拾光用量-{今天|7天|30天|本月|上月}-YYYYMMDD.csv`；实现走 `Blob` + `<a download>`（Electron 默认弹系统保存框；若真机不弹，退到新增 `saveTextFileAs` IPC，参照 `register-session-handoff-ipc.ts` 的 `saveImageAs`）。
- 键盘：光谱段位 / 图例项 / 表头排序 / 分页 / select 全部可 Tab；柱状图 ←/→/Home/End/Esc 漫游保留，`aria-live` 朗读区仍在 `role=img` 之外。
- 空态：`hasAnyUsage=false` 保留现有说明卡；`rangeEmpty` 时 KPI 显示 `$0.00 / 0 / 0`、趋势卡显示「此范围内没有用量」、表格显示同句。

***

## 3. 数据与视图模型变更（`stats-view.ts`）

- `StatsRange = 'today' | '7d' | '30d' | 'mtd' | 'lastMonth'`；`STATS_RANGE_OPTIONS` 加「本月 / 上月」。
- 新增 `statsRangeBounds(range, now): { start, end, unit, label }`：`end` 对上月为本月零点 − 1ms，其余为 `now`；`emptyBuckets` 对 mtd / lastMonth 生成该月天桶（mtd 到今天为止）。回合过滤改 `turn.at >= start && turn.at <= end`。
- `StatsGroupBy = 'seat' | 'model' | 'group' | 'none'`；`SessionStatsInput.groupBy`（缺省 `'seat'`）。`StatsBucketPart` 改为通用系列 `{ seriesKey, colorIndex, costUsd, tokens }`；新增 `series: StatsSeries[]`（图例：key / label / sub? / colorIndex / costUsd / tokens）。按分组时无组席位归「独立」；按模型时系列 = `turn.modelLabel`。
- 折叠：`foldBucketParts(parts, top, metric)`——占 Y 轴顶值 < 1.5% 的段并入 `other`（`seriesKey: 'other'`, `colorIndex: -1`），单段桶不折叠。折叠在组件层按当前度量做（视图模型无度量），或视图模型同时给出 cost / tokens 两套 `top`。
- Y 轴：`niceAxis(max, steps = 3): { top, ticks: number[] }`——step = `10^floor(log10(max/steps)) × {1, 2, 2.5, 5}` 中首个使 `step × steps ≥ max` 者；`top = step × steps`；max = 0 时 `top = 1`、ticks `[0]`。柱高按 `top` 归一（不再按 `maxBucket`）。
- 逐回合行：`turnRows: StatsTurnRow[]`（`at / seatKey / colorIndex / title / sub / avatarId / online / composerId / generationId / modelLabel / tokens / costUsd / 四桶 / exact`），随席位筛选与范围；`sortStatsTurnRows(rows, key: 'at' | 'tokens' | 'cost', direction)`。`normalizeTurns` 需带出 `generationId`（账本键）；legacy 折叠回合 `generationId = 'legacy'`。
- KPI 派生：`totals.sessionCount`（范围内有回合的会话数）；其余复用 `totals`。
- CSV：`buildStatsCsv(view, { mode: 'turns' | 'sessions', range })`——列头中文 + 英文键（`时间 (本地)`, `席位`, `通道`, `会话 ID`, `模型`, `Input`, `Output`, `Cache Read`, `Cache Write`, `Tokens`, `成本 USD`, `质量`）；数值不缩写；成本 6 位小数。
- 格式函数：`formatStatsCost` / `formatStatsTime` / `formatStatsDateRange` 放 `stats-view.ts`（纯函数，可测）。

***

## 4. 切片（顺序即优先级；每片独立可合入）

| 片 | 内容 | 验收 |
|---|---|---|
| **S1 基建** | 范围 mtd / lastMonth + `statsRangeBounds`；`niceAxis`；`foldBucketParts`；`groupBy` 与通用系列；`turnRows` + 排序；`buildStatsCsv`；三个格式函数。只改 `stats-view.ts` + `stats-view.test.ts`，组件仍能编译（旧字段保留或同步改名） | 单测：本月 / 上月边界（含跨年）；`niceAxis` 表驱动（0 / 0.0042 / 0.878 / 3.24 / 515_500 / 1.3e6）；折叠规则；四种 groupBy 的 parts / series 一致性（Σ parts = bucket 总量）；turnRows 数量 = Σ 会话回合；CSV 行数与转义（逗号 / 引号 / 换行）；格式函数边界 |
| **S2 首屏** | 控制行（范围 + 日期文本 + (i)）；KPI 三卡；caption；席位份额行（带标题与图例）；删账本行 | `settings-stats.test.tsx`：KPI 三值 / 副行 / caption 文案；(i) 悬浮内容；日期文本随范围；席位筛选仍通过段位与图例项触发并出 chip；数值缓动仍受 hidden 冻结 |
| **S3 趋势卡** | 度量分段与分组 select 迁入卡头；Y 轴 + 网格 + X 轴刻度规则；柱去 gap / 去段圆角 / 折叠其他；底部图例；副标题句子 | 单测：Y 轴标签数 = ticks 数且按度量格式化；有数据桶必有刻度；`is-other` 段出现于稀疏数据；键盘漫游与 hover 卡回归；分组切换只改系列。预览稀疏场景无任何 <2px 的段（探针：遍历 `.stats-bars__stack > i` 的 `offsetHeight`） |
| **S4 明细表** | 逐回合默认视图 + 按会话视图分段；数字列右对齐（`.is-num`，排序按钮 `row-reverse` 让箭头在标签左侧）；成本数据条保留；每页 select（10/20/50，默认 10）；「第 x–y 条 · 共 n 条」；导出 CSV 按钮 | 单测：默认按时间降序；视图切换回第 1 页并各自记忆排序；每页选择改变行数与计数文案；右对齐由 `th/td.is-num` 类断言（不查 computed style）；导出点击生成正确文件名与 BOM（mock `URL.createObjectURL` + 拦截 anchor click） |
| **S5 皮肤** | 实底卡片；尺度表（§2.2）；色彩收敛；动效与 reduced-motion；宽度 <720px 的降列 | 预览四场景 + 稀疏场景重拍；`theme-surface-contract.test.ts` 若有断言随之更新；对照 Cursor 截图逐项勾 §1 末尾清单 |
| **S6 收口** | `?stats=sparse` fixture；`preview-shots.mjs` 场景与探针更新（选择器见 §5.3）；`docs/DESIGN-SYSTEM.md`（数据页实底例外、KPI 卡）；`docs/UI-STRUCTURE.md` 统计页小节；`docs/ARCHITECTURE-LOG.md` 日期条目；`.handoff/README.md` 状态行 | 全量 `npm test` / `npm run typecheck` / `npm run lint:dead` 全绿；截图矩阵探针全绿 |

***

## 5. 验收清单

### 5.1 测试

- `tests/stats-view.test.ts`：现有 13 例保持语义（字段改名同步）；新增 S1 列出的用例。
- `tests/settings-stats.test.tsx`：现有 17 例中需重写的——「账本行呈现…」→ KPI / caption；「全表左对齐…」→ 右对齐 + 默认逐回合；「明细超过 8 行在卡片内翻页」→ 每页 10 + 计数文案；「度量切换…」→ 切换控件位于趋势卡头；其余按选择器微调。新增 S2–S4 列出的用例。
- 不允许「只删断言让测试过」；每条被删断言在 §7 记一行原因。

### 5.2 预览场景（`scripts/preview-shots.mjs`）

| 场景 | query | 说明 |
|---|---|---|
| `settings-stats-light` / `-dark` | `stats=1` | 丰满 fixture（3 席位 + 旧会话 + 历史 + 2 组） |
| `settings-stats-sparse-light` / `-dark` | `stats=sparse` | **新增**：CH-1 今天 6 回合集中在一小时（≈ 480K tokens）+ CH-3 两回合 ≈ 27K；无历史无组。探针：KPI 三卡可见、Y 轴 ≥ 3 个标签、有数据的两个小时有刻度、无 <2px 段、表格默认逐回合 8 行 |
| `settings-stats-7d-filtered-light` | `stats=1` | 点 7 天 + 点第二个光谱段位（选择器不变） |
| `settings-stats-tokens-dark` | `stats=1` | 改点 `.stats-card--trend .stats-range button:nth-child(2)` |
| `settings-stats-mtd-light` | `stats=1` | **新增**：点「本月」，看月天桶与日期文本 |
| `settings-stats-sessions-view-light` | `stats=1` | **新增**：点「按会话」视图 |
| `settings-stats-accent-violet-dark` | `stats=1` | 保留（Output 仍橙、席位板不随 accent） |

### 5.3 选择器契约（测试 / 探针 / 深链共用）

保留：`.settings-stats` `.stats-controls` `.stats-range` `.stats-spectrum` `.stats-spectrum__segment` `.stats-spectrum__tip` `.stats-filter-chip` `.stats-card` `.stats-bars` `.stats-bars__col` `.stats-bars__stack` `.stats-bars__tip` `.stats-mix*` `.stats-seatmix*` `.stats-models*` `.stats-groups*` `.stats-table` `.stats-table__sort` `.stats-table__seat` `.stats-table__quality` `.stats-pager` `.stats-empty` `#account:stats` 深链。
新增：`.stats-controls__dates` `.stats-controls__info` `.stats-kpi` `.stats-kpi__card` `.stats-caption` `.stats-seats` `.stats-seats__legend` `.stats-card--trend` `.stats-card__tools` `.stats-chart` `.stats-chart__axis-y` `.stats-chart__grid` `.stats-chart__axis-x` `.stats-legend` `.stats-table__view` `.stats-export` `th.is-num / td.is-num` `.stats-pager__size`。
删除：`.stats-ledger*` `.stats-card--rhythm` `.stats-controls__meta` `.stats-bars__tick`（刻度移到 `.stats-chart__axis-x`）。

***

## 6. 已知风险与非目标

- **风险**：`<a download>` 在 Electron 里若被某处 `will-download` 处理器拦截（当前 main 进程无此监听），保存框不弹——退到 IPC 方案（§2.4）。
- **风险**：月桶最多 31 列，7 天以上的 X 轴标签 `9/22` 在 ~26px 列宽下会碰撞——必须实现碰撞规避（§2.1 X 轴规则），不能只靠 `index % 5`。
- **风险**：`useAnimatedNumber` 在 KPI 三卡各一份 rAF，隐藏冻结逻辑（`active=false`）必须继续覆盖它们。
- **非目标**：Included / On-demand；自定义日期；全局 `formatCostUsd` / `formatClock` 修正（follow-up：`formatClock` 应固定 `hour12: false`，涉及聊天 / 名册多处快照测试）；图表库；服务端 / IPC 改动（除 CSV 兜底）。

***

## 7. 进度日志（每完成一步追加一行；格式：日期 时间 · 席位 · 做了什么 · 验证）

- 2026-09-22 21:10 · CH-2 · 任务书起草；main 上提交任务书与 `.handoff/README.md` 索引行；建 worktree `../SG-Team-stats` / 分支 `feat/stats-refine`。 · —
