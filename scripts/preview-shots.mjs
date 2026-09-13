#!/usr/bin/env node
/**
 * 设计走查截图：用本机 Chromium 内核浏览器（Edge / Chrome）无头打开 `npm run preview:ui`
 * 的预览页，按场景矩阵（右栏面板 / 运行页 / 会话侧栏 × 深浅色 × 窄窗 × 透明模式 × reduced-motion × 交互）
 * 截图到 preview-screenshots/。只依赖 CDP 与 ws，不引入 Playwright。
 *
 *   npm run preview:ui                      # 另一个终端，端口 5174
 *   node scripts/preview-shots.mjs          # 全部场景
 *   node scripts/preview-shots.mjs --only review-light,plan-dark
 *   node scripts/preview-shots.mjs --only run-team-active-light,run-independent-mixed-dark
 *   node scripts/preview-shots.mjs --only sessions-rail-light,sessions-rail-narrow,sessions-rail-empty
 *   node scripts/preview-shots.mjs --list
 *
 * 可选环境变量：PREVIEW_BASE（默认 http://127.0.0.1:5174）、PREVIEW_BROWSER（浏览器可执行文件）、
 * PREVIEW_OUT（输出目录）、PREVIEW_CDP_PORT（默认 9555；9333 是 Cursor 自己的调试端口，勿用）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const BASE = (process.env.PREVIEW_BASE || 'http://127.0.0.1:5174').replace(/\/+$/, '')
const OUT = resolve(process.env.PREVIEW_OUT || 'preview-screenshots')
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT || 9555)
const ONLY = flag('--only')?.split(',').map((value) => value.trim()).filter(Boolean)

const INSPECTOR_OPEN_KEY = 'sg-team.layout:v1:workspace-inspector:open'
const INSPECTOR_TAB_KEY = 'sg-team.inspector:active-tab'
const INSPECTOR_WIDTH_KEY = 'sg-team.layout:v1:shell.workspace-inspector'
const REVIEW_SCOPE_KEY = 'sg-team.inspector:review-scope'
const APPEARANCE_KEY = 'shiguang.appearance.v1'

/** 基础存储：右栏展开、CH-2 会话、默认宽度；accent 为主题色预设 id（缺省拾光橙）。 */
function baseStorage({ tab = 'review', width = 420, cardOpacity = 0.9, colorMode = 'light', scope = 'uncommitted', accent = 'sg-orange' } = {}) {
  return {
    [INSPECTOR_OPEN_KEY]: '1',
    [INSPECTOR_TAB_KEY]: tab,
    [INSPECTOR_WIDTH_KEY]: JSON.stringify([width]),
    [REVIEW_SCOPE_KEY]: scope,
    [APPEARANCE_KEY]: JSON.stringify({ cardOpacity, colorMode, accent }),
    'shiguang.lastSessionChannel.v1': '2'
  }
}

const SESSION_RAIL_WIDTH_KEY = 'sg-team.layout:v1:shell.sessions.v2'

/** 会话侧栏走查：右栏收起、选中 CH-2、侧栏宽度可指定（默认 326，下限 286）。 */
function railStorage({ cardOpacity = 0.94, colorMode = 'light', railWidth = 326 } = {}) {
  return {
    ...baseStorage({ cardOpacity, colorMode }),
    [INSPECTOR_OPEN_KEY]: '0',
    [SESSION_RAIL_WIDTH_KEY]: JSON.stringify([railWidth])
  }
}

const TABS = ['review', 'plan', 'activity', 'artifacts']
const EDIT_CARD = '.cursor-native-edit[data-step-id="block:live-edit"]'
// 真浏览器检查：hover / 鼠标点击后移出 / 键盘焦点，及完整代码的局部横向滚动。
function editCardProbe(expanded, arrowVisible) {
  return `(() => {
    const card = document.querySelector(${JSON.stringify(EDIT_CARD)})
    const head = card.querySelector('.cursor-native-edit__head')
    const toggle = card.querySelector('.cursor-native-edit__toggle')
    const diff = card.querySelector('.cursor-native-diff')
    const box = card.getBoundingClientRect()
    const title = head.querySelector('strong')
    const language = head.querySelector('.cursor-native-edit__language')
    const stats = head.querySelector('.cursor-native-edit__stats')
    const fail = (message) => { throw new Error(message) }
    if ((head.getAttribute('aria-expanded') === 'true') !== ${expanded}) fail('edit expansion mismatch')
    if ((Number(getComputedStyle(toggle).opacity) > .9) !== ${arrowVisible}) fail('hover/focus visibility mismatch')
    if (Math.abs(box.height - window.__editAuditHeight) > 1 && !${expanded}) fail('hover changed card height')
    if (box.right > card.closest('.cursor-native-process__flow').getBoundingClientRect().right + 1) fail('card escaped flow')
    if (language.getBoundingClientRect().right > title.getBoundingClientRect().left) fail('language overlaps filename')
    const fonts = [language, title, stats].map(node => {
      const style = getComputedStyle(node)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight].join('|')
    })
    if (new Set(fonts).size !== 1) fail('inconsistent header typography')
    if (${expanded}) {
      if (diff.scrollWidth <= diff.clientWidth || getComputedStyle(diff).overflowX !== 'auto') fail('long code has no horizontal reading area')
      diff.scrollLeft = diff.scrollWidth
      if (diff.scrollLeft <= 0) fail('horizontal scroll failed')
      if (card.scrollWidth > card.clientWidth + 1) fail('code expanded the card')
    }
    return { expanded: ${expanded}, arrowVisible: ${arrowVisible}, width: box.width, height: box.height, scrollLeft: diff.scrollLeft }
  })()`
}
const scenes = [
  ...TABS.flatMap((tab) => [
    { name: `${tab}-light`, width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab }) },
    { name: `${tab}-dark`, width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ tab, colorMode: 'dark' }) }
  ]),
  // 标签胶囊：四个标签平时只露图标，选中的那个展开出文字与计数；切换时新胶囊长出、旧胶囊收回同步进行。
  ...['light', 'dark'].map((colorMode) => ({
    name: `inspector-tabs-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode, storage: baseStorage({ colorMode }),
    clip: '.workspace-inspector__bar',
    actions: [{
      label: '标签胶囊几何',
      probe: `(() => {
        const tabs = Array.from(document.querySelectorAll('.inspector-tab')).map((tab) => ({
          label: tab.querySelector('.inspector-tab__label')?.textContent,
          active: tab.classList.contains('is-active'),
          width: Math.round(tab.getBoundingClientRect().width),
          height: Math.round(tab.getBoundingClientRect().height),
          revealWidth: Math.round(tab.querySelector('.inspector-tab__reveal').getBoundingClientRect().width)
        }))
        const bar = document.querySelector('.workspace-inspector__bar').getBoundingClientRect()
        const close = document.querySelector('.workspace-inspector__close').getBoundingClientRect()
        return {
          collapsedAreSquare: tabs.filter((tab) => !tab.active).every((tab) => tab.width === 32 && tab.height === 32 && tab.revealWidth === 0),
          activeExpanded: tabs.some((tab) => tab.active && tab.revealWidth > 0),
          closeAlignedWithTabs: Math.abs(close.height - 32) < 0.5 && Math.abs((close.top + close.height / 2) - (bar.top + bar.height / 2)) < 0.5,
          tabs
        }
      })()`
    }]
  })),
  {
    name: 'inspector-tabs-switch-mid', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(),
    clip: '.workspace-inspector__bar',
    actions: [{ click: '.inspector-tab:nth-child(3)' }, { wait: 90 }]
  },
  {
    name: 'inspector-tabs-switch-end', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(),
    clip: '.workspace-inspector__bar',
    actions: [{ click: '.inspector-tab:nth-child(3)' }, { wait: 400 }]
  },
  { name: 'inspector-tabs-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ tab: 'activity', width: 300 }), clip: '.workspace-inspector__bar' },
  // 窄栏：窗口 1180 宽、右栏收到下限 300，标签应收成纯图标。
  { name: 'review-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ width: 300 }) },
  { name: 'activity-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ tab: 'activity', width: 300 }) },
  // 透明模式：卡片透明度 0（clear）——正文区必须保持阅读面。
  { name: 'review-clear', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  { name: 'review-clear-dark', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ cardOpacity: 0, colorMode: 'dark' }) },
  // reduced-motion：不该有半程动画的中间态。
  { name: 'review-reduced-motion', width: 1440, height: 900, colorScheme: 'light', reducedMotion: true, storage: baseStorage() },
  // 悬停第一条文件行：动作簇出现。
  { name: 'review-hover-row', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), actions: [{ hover: '.review-file__row' }] },
  // 撤销确认浮层。
  { name: 'review-revert-confirm', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), actions: [{ hover: '.review-file__row' }, { click: '.review-file__actions button.is-danger' }, { wait: 250 }] },
  // 分支范围 + 展开全部。
  { name: 'review-branch-expanded', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ scope: 'branch' }), actions: [{ click: '.inspector-review__count > button' }, { wait: 400 }] },
  // 活动页悬停一行：定位 / 复制动作。
  { name: 'activity-hover-row', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab: 'activity' }), actions: [{ hover: '.activity-command .activity-row' }] },
  // 产物卡悬停：右上角浮层动作。
  { name: 'artifacts-hover-card', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab: 'artifacts' }), actions: [{ hover: '.artifact-card' }] },
  // 空态：CH-1 没有过程块 / Todo / 图片。
  { name: 'plan-empty', width: 1440, height: 900, colorScheme: 'light', channel: '1', storage: { ...baseStorage({ tab: 'plan' }), 'shiguang.lastSessionChannel.v1': '1' } },
  // 长清单（?plan=long）：10 项真实颗粒度任务，检验单行收拢、mono token、分段进度与当前项示位。
  { name: 'plan-long-light', width: 1440, height: 900, colorScheme: 'light', query: 'plan=long', storage: baseStorage({ tab: 'plan' }) },
  { name: 'plan-long-dark', width: 1440, height: 900, colorScheme: 'dark', query: 'plan=long', storage: baseStorage({ tab: 'plan', colorMode: 'dark' }) },
  { name: 'activity-empty', width: 1440, height: 900, colorScheme: 'light', channel: '1', storage: { ...baseStorage({ tab: 'activity' }), 'shiguang.lastSessionChannel.v1': '1' } },
  { name: 'artifacts-empty-dark', width: 1440, height: 900, colorScheme: 'dark', channel: '1', storage: { ...baseStorage({ tab: 'artifacts', colorMode: 'dark' }), 'shiguang.lastSessionChannel.v1': '1' } },
  // 变更面板的其它状态（预览参数 ?review=…）。
  { name: 'review-clean', width: 1440, height: 900, colorScheme: 'light', query: 'review=clean', storage: baseStorage() },
  { name: 'review-not-git', width: 1440, height: 900, colorScheme: 'light', query: 'review=not_git', storage: baseStorage() },
  { name: 'review-error-dark', width: 1440, height: 900, colorScheme: 'dark', query: 'review=error', storage: baseStorage({ colorMode: 'dark' }) },
  { name: 'review-many', width: 1440, height: 900, colorScheme: 'light', query: 'review=many', storage: baseStorage() },
  { name: 'review-many-narrow-dark', width: 1180, height: 760, colorScheme: 'dark', query: 'review=many', storage: baseStorage({ width: 300, colorMode: 'dark' }) },
  // 右栏关闭态（对照）与开合中途帧（验证轨道过渡在插值而不是跳变）。
  { name: 'inspector-closed', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' } },
  {
    name: 'inspector-opening', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null,
    actions: [{
      label: 'grid-template-columns 采样（页面内计时，0/60/120/180/320ms）',
      probe: `new Promise((done) => {
        const dock = document.querySelector('.workspace-dock')
        const read = () => getComputedStyle(dock).gridTemplateColumns
        const samples = []
        document.querySelector('[aria-label="展开右侧工作区"]').click()
        for (const at of [0, 60, 120, 180, 320]) setTimeout(() => { samples.push(at + 'ms ' + read()); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 60 }]
  },
  { name: 'inspector-opened', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null, actions: [{ click: '[aria-label="展开右侧工作区"]' }, { wait: 400 }] },

  // ---------- 运行页（#run）：一个工程一个活跃运行，团队 / 独立两种模式 ----------
  ...[['light', 'light'], ['dark', 'dark']].flatMap(([suffix, colorMode]) => [
    // 无活跃运行：开始一次运行（模式选择）。
    { name: `run-start-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-start-independent-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
    // 团队：启动前（目标已填、MCP 待接入）/ 协作执行中 / 已结束。
    { name: `run-team-prelaunch-${suffix}`, run: true, query: 'runStatus=ready', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-team-active-${suffix}`, run: true, colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-team-completed-${suffix}`, run: true, query: 'runStatus=completed', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    // 独立：全部待命 / 混合形态（待命 + 执行中 + 离线 + 待确认）/ 已结束。
    { name: `run-independent-live-${suffix}`, run: true, query: 'independent=live', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-mixed-${suffix}`, run: true, query: 'independent=mixed', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-ended-${suffix}`, run: true, query: 'independent=ended', colorScheme: colorMode, storage: baseStorage({ colorMode }) }
  ]),
  // 切换模式的确认面（团队 → 独立，仍有在线席位）。
  { name: 'run-switch-sheet', run: true, colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
  // 确认后进入独立批次配置（头部标注"正在配置"）。
  { name: 'run-compose-after-switch', run: true, colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }, { click: '.run-sheet__confirm' }, { wait: 400 }] },
  // 结束批次确认面 + 目标编辑器。
  { name: 'run-end-sheet-dark', run: true, query: 'independent=live', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), actions: [{ click: '.run-header__ghost.is-danger' }, { wait: 300 }] },
  { name: 'run-goal-editing', run: true, query: 'runStatus=ready', colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-panel--team .run-link' }, { wait: 300 }] },
  // 宽度阶梯：容器查询断点 1120 / 920 / 680 两侧各取一档，头部与席位行的重排必须在每一档都成立。
  ...[1180, 1000, 860, 720, 600].flatMap((width) => [
    { name: `run-team-active-w${width}`, run: true, width, height: 820, colorScheme: 'light', storage: baseStorage(), clip: null },
    { name: `run-independent-mixed-w${width}`, run: true, width, height: 820, query: 'independent=mixed', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null }
  ]),
  { name: 'run-start-independent-w600', run: true, width: 600, height: 900, query: 'setup=1', colorScheme: 'light', storage: baseStorage(), clip: null, actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
  { name: 'run-compose-w720', run: true, width: 720, height: 900, colorScheme: 'light', storage: baseStorage(), clip: null, actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }, { click: '.run-sheet__confirm' }, { wait: 400 }] },
  // 头部控件位置守恒：切换模式 → 确认 → 进入配置态，分段控件、两个动作按钮和头部高度必须一个像素都不动。
  {
    name: 'run-header-stability', run: true, colorScheme: 'light', storage: baseStorage(), clip: '.run-header',
    actions: [{
      label: '头部控件包围盒（切换前 → 配置态）',
      probe: `new Promise((done) => {
        const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',') }
        const snapshot = () => ({ header: box('.run-header'), switch: box('.run-mode-switch'), open: box('.run-header__ghost'), end: box('.run-header__ghost.is-danger') })
        const before = snapshot()
        document.querySelector('.run-mode-switch button[aria-checked="false"]').click()
        setTimeout(() => {
          document.querySelector('.run-sheet__confirm').click()
          setTimeout(() => {
            const after = snapshot()
            const stable = Object.keys(before).every((key) => before[key] === after[key])
            done({ stable, before, after })
          }, 500)
        }, 350)
      })`
    }, { wait: 100 }]
  },
  // 确认面的展开是高度过渡：中途帧应看到插槽行高在插值，而不是 0 → 满高跳变。
  {
    name: 'run-sheet-opening', run: true, colorScheme: 'light', storage: baseStorage(), clip: null,
    actions: [{
      label: 'run-slot grid-template-rows 采样（0/60/120/200/320ms）',
      probe: `new Promise((done) => {
        const samples = []
        document.querySelector('.run-mode-switch button[aria-checked="false"]').click()
        const slot = () => document.querySelector('.run-slot')
        for (const at of [0, 60, 120, 200, 320]) setTimeout(() => { samples.push(at + 'ms ' + getComputedStyle(slot()).gridTemplateRows); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 40 }]
  },
  { name: 'run-team-active-clear', run: true, colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  // 右上角设置入口：账号与 Cursor。
  ...['accounts', 'import', 'automation', 'aozai', 'maintenance', 'cleanup'].flatMap(group =>
    ['light', 'dark'].map(colorScheme => ({
      name: `settings-${group}-${colorScheme}`, hash: `account:${group}`,
      width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: null
    }))
  ),
  // 统计页：账本铺满 30 天的富数据场景（深浅色 + 7 天范围 + 席位筛选后的联动）。
  ...['light', 'dark'].map((colorMode) => ({
    name: `settings-stats-${colorMode}`, hash: 'account:stats', query: 'stats=1',
    width: 1440, height: 1240, colorScheme: colorMode, storage: baseStorage({ colorMode }), clip: null
  })),
  {
    name: 'settings-stats-7d-filtered-light', hash: 'account:stats', query: 'stats=1', width: 1440, height: 1240, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: null,
    actions: [{ wait: 250 }, { click: '.stats-range button:nth-child(2)' }, { click: '.stats-spectrum__segment:nth-child(2)' }, { wait: 400 }]
  },
  {
    name: 'settings-stats-tokens-dark', hash: 'account:stats', query: 'stats=1', width: 1440, height: 1240, colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null,
    actions: [{ wait: 250 }, { click: '.stats-controls .stats-range:nth-of-type(2) button:nth-child(2)' }, { wait: 400 }]
  },
  // 主题色：外观弹层的色卡行（洛神紫选中），以及整页换装后的派生链效果（统计页 · 深色）。
  {
    name: 'appearance-accent-popover-light', hash: 'account:stats', query: 'stats=1', width: 1440, height: 900, colorScheme: 'light',
    storage: baseStorage({ colorMode: 'light', accent: 'luoshen-violet' }), clip: null,
    actions: [{ wait: 250 }, { click: '.appearance-button' }, { wait: 250 }]
  },
  {
    name: 'settings-stats-accent-violet-dark', hash: 'account:stats', query: 'stats=1', width: 1440, height: 1240, colorScheme: 'dark',
    storage: baseStorage({ colorMode: 'dark', accent: 'luoshen-violet' }), clip: null,
    actions: [{ wait: 250 }, { click: '.stats-spectrum__segment:nth-child(2)' }, { wait: 300 }]
  },
  { name: 'settings-maintenance-compatible-pump', hash: 'account:maintenance', query: 'pump=external', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null },
  { name: 'settings-maintenance-missing-pump', hash: 'account:maintenance', query: 'pump=missing', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: null },
  // 存储清理：Cursor 已退出（全部可清，默认预选含缓存/日志；高窗一次看全八项）、勾上对话历史后的
  // 红色确认块、无可清理内容的空态。盘点 mock 有 350ms 延迟，动作前先等它落地。
  { name: 'settings-cleanup-closed-light', hash: 'account:cleanup', query: 'cleanup=closed', width: 1440, height: 1400, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: null },
  {
    name: 'settings-cleanup-confirm-dark', hash: 'account:cleanup', query: 'cleanup=closed', width: 1440, height: 1400, colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null,
    actions: [{ wait: 600 }, { click: '[data-item="chat-history"] input[type="checkbox"]' }, { click: '.storage-cleanup__button.is-primary' }, { wait: 120 }]
  },
  { name: 'settings-cleanup-empty-dark', hash: 'account:cleanup', query: 'cleanup=empty', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null },
  { name: 'account-page', hash: 'account', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), clip: null },

  // ---------- 会话侧栏（名册）：右栏收起，特写裁 .session-pane ----------
  // 四个状态组齐全（?sessions=many）× 深浅色；透明卡片；窄栏 286（容器查询收起增删行数）；
  // 悬停行 / 键盘焦点漫游 / 折叠一组 / 短窗滚动时的吸顶标题；空态；reduced-motion。
  ...[['light', 'light'], ['dark', 'dark']].map(([suffix, colorMode]) => (
    { name: `sessions-rail-${suffix}`, rail: true, query: 'sessions=many', colorScheme: colorMode, storage: railStorage({ colorMode }) }
  )),
  // 常驻状态行（Cursor 会话列表副标题复刻）：工具动词 + 对象 / 正文片段 / To-Dos / 待命 Thinking /
  // Awaiting approval / 兜底 Planning next moves / 离线 Completed 同台（深浅色）。
  ...[['light', 'light'], ['dark', 'dark']].map(([suffix, colorMode]) => (
    { name: `sessions-rail-activity-${suffix}`, rail: true, query: 'sessions=many&railactivity=1', colorScheme: colorMode, storage: railStorage({ colorMode }) }
  )),
  ...['light', 'dark'].map((colorMode) => ({
    name: `sessions-rail-activity-narrow-${colorMode}`, rail: true, width: 1180, height: 900,
    query: 'sessions=many&railactivity=long', colorScheme: colorMode, storage: railStorage({ colorMode, railWidth: 286 }),
    actions: [{ label: '状态行常驻、布局与状态', probe: `(() => {
      const rows = [...document.querySelectorAll('.session-row')]
      const pills = [...document.querySelectorAll('.session-row__activity')]
      // 常驻：每一行恰好一枚，离线行也有。
      if (pills.length !== rows.length) throw new Error('状态行数量 ' + pills.length + ' ≠ 行数 ' + rows.length)
      for (const row of rows) if (row.querySelectorAll('.session-row__activity').length !== 1) throw new Error('某行状态行数量不为 1')
      for (const kind of ['search', 'read', 'edit', 'message', 'todo', 'thinking', 'question', 'other']) {
        if (!pills.some(pill => pill.classList.contains('is-' + kind))) throw new Error('缺少状态行形态: ' + kind)
      }
      const texts = pills.map(pill => pill.textContent)
      for (const expected of ['Grepping', 'Reading', 'Editing', 'Thinking', 'To-Dos Completed', 'Awaiting approval', 'Completed', 'Planning next moves']) {
        if (!texts.some(text => text.includes(expected))) throw new Error('缺少原版措辞: ' + expected)
      }
      for (const pill of pills) {
        const row = pill.closest('.session-row'), main = row.querySelector('.session-row__main')
        const rect = pill.getBoundingClientRect(), parent = main.getBoundingClientRect()
        const avatar = row.querySelector('.session-row__avatar').getBoundingClientRect()
        // 胶囊是卡片底行：横跨头像列与文字列（头像左沿 → 卡片右沿），每行等宽，不随内容长短。
        if (Math.abs(rect.left - avatar.left) > 1 || Math.abs(rect.right - parent.right) > 1) throw new Error('状态行未横跨卡片: ' + pill.className)
        if (rect.top < parent.bottom || row.lastElementChild !== pill) throw new Error('状态行不是卡片末行')
        if (row.scrollWidth > row.clientWidth + 1) throw new Error('卡片出现横向溢出')
        const live = pill.classList.contains('is-live'), spinner = pill.querySelector('.session-row__activity-spinner')
        if (live !== Boolean(spinner)) throw new Error('转圈与回合存活不一致: ' + pill.className)
        if (row.classList.contains('is-offline') && !(pill.classList.contains('is-muted') && pill.textContent.includes('Completed'))) throw new Error('离线行未收口为 Completed')
        if (getComputedStyle(pill).animationName !== 'none') throw new Error('状态行不应有进场动画')
      }
      const question = document.querySelector('.session-row__activity.is-question')
      if (!question.closest('.session-row.is-attention')) throw new Error('待决策分类不一致')
      const standby = document.querySelector('.session-row.is-waiting .session-row__activity')
      if (!standby || !standby.textContent.includes('Thinking')) throw new Error('待命席位未显示 Thinking')
      // 长明细与长正文片段都在胶囊内省略（…），不撑宽卡片。
      const detail = document.querySelector('.session-row__activity.is-read .session-row__activity-detail')
      if (detail.scrollWidth <= detail.clientWidth || getComputedStyle(detail).textOverflow !== 'ellipsis') throw new Error('长对象未正确省略')
      const snippet = document.querySelector('.session-row__activity.is-message > strong')
      if (snippet.scrollWidth <= snippet.clientWidth || getComputedStyle(snippet).textOverflow !== 'ellipsis') throw new Error('长正文片段未正确省略')
      for (const kind of ['read', 'search', 'question']) {
        const verb = document.querySelector('.session-row__activity.is-' + kind + ' > strong')
        if (verb.scrollWidth > verb.clientWidth + 1) throw new Error('短动词被明细挤压')
      }
      return pills.map(pill => ({kind:pill.className, text:pill.textContent, width:pill.getBoundingClientRect().width, height:pill.getBoundingClientRect().height}))
    })()` }]
  })),
  { name: 'sessions-rail-default', rail: true, colorScheme: 'light', storage: railStorage() },
  { name: 'sessions-rail-clear', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage({ cardOpacity: 0 }) },
  { name: 'sessions-rail-clear-dark', rail: true, query: 'sessions=many', colorScheme: 'dark', storage: railStorage({ cardOpacity: 0, colorMode: 'dark' }) },
  { name: 'sessions-rail-narrow', rail: true, width: 1180, height: 760, query: 'sessions=many', colorScheme: 'light', storage: railStorage({ railWidth: 286 }) },
  { name: 'sessions-rail-hover-row', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ hover: '.session-group.is-attention .session-list__slot:first-child .session-row' }] },
  { name: 'sessions-rail-keyboard', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ eval: `document.querySelector('.session-row.is-selected').focus()` }, { key: 'ArrowDown', code: 'ArrowDown' }, { key: 'ArrowDown', code: 'ArrowDown' }] },
  { name: 'sessions-rail-collapsed', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ click: '.session-group.is-active .session-group__header' }, { wait: 300 }] },
  {
    name: 'sessions-rail-collapsing', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), clip: null,
    actions: [{
      label: '分组折叠 grid-template-rows 采样（0/60/120/200/320ms）',
      probe: `new Promise((done) => {
        const samples = []
        document.querySelector('.session-group.is-waiting .session-group__header').click()
        const slot = () => document.querySelector('.session-group.is-waiting .inspector-collapsible')
        for (const at of [0, 60, 120, 200, 320]) setTimeout(() => { samples.push(at + 'ms ' + getComputedStyle(slot()).gridTemplateRows); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 40 }]
  },
  { name: 'sessions-rail-scrolled', rail: true, width: 1180, height: 620, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ eval: `document.querySelector('.session-list').scrollTop = 150` }, { wait: 120 }] },
  { name: 'sessions-rail-empty', rail: true, query: 'sessions=none', colorScheme: 'light', storage: railStorage() },
  { name: 'sessions-rail-reduced-motion', rail: true, query: 'sessions=many', colorScheme: 'light', reducedMotion: true, storage: railStorage() },

  // ---------- 会话页过程卡：工具头部（意图说明 / 动词 / 提示）与 ask_question 可点选卡片 ----------
  // 含待答问卷的过程回合：Shell 的意图说明为主标题 + 程序名提示、读取行范围、编辑增删行数。
  // 预览夹具同时带流式回复，时间线会把该行归为已关联过程；按问卷后代定位比 live-process-row 更稳定。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-tool.is-question)',
    actions: [{ eval: `document.querySelector('.chat-row--process:has(.cursor-native-tool.is-question)').scrollIntoView({ block: 'start' })` }, { wait: 200 }]
  })),
  // 步骤分组（Cursor detailed 同款）：折叠的「Explored 3 files, 1 search」/「Ran 2 browser actions」组头、
  // 独立 shell 卡、展开后的组内轻行；深浅色各一张，另有一张展开首组。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-groups-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-group)',
    actions: [{ eval: `document.querySelector('.chat-row--process:has(.cursor-native-group)').scrollIntoView({ block: 'start' })` }, { wait: 200 }]
  })),
  // 长绝对路径与长输出行：卡片、时间线和工作区不得被 monospace min-content 撑宽。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-shell-overflow-${colorMode}`, width: 900, height: 760, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.cursor-native-shell[data-step-id="block:live-4"]',
    actions: [
      { eval: `document.querySelector('.cursor-native-shell[data-step-id="block:live-4"]').scrollIntoView({ block: 'center' })` },
      {
        label: '长命令 Shell 边界约束',
        probe: `(() => {
          const card = document.querySelector('.cursor-native-shell[data-step-id="block:live-4"]')
          const flow = card?.closest('.cursor-native-process__flow')
          const timeline = card?.closest('.workspace-timeline')
          if (!card || !flow || !timeline) return { found: false }
          const cardBox = card.getBoundingClientRect()
          const flowBox = flow.getBoundingClientRect()
          const timelineBox = timeline.getBoundingClientRect()
          const documentElement = document.documentElement
          return {
            found: true,
            cardWithinFlow: cardBox.right <= flowBox.right + 0.5,
            flowWithinTimeline: flowBox.right <= timelineBox.right + 0.5,
            pageHasNoHorizontalOverflow: documentElement.scrollWidth <= documentElement.clientWidth,
            card: { left: cardBox.left, right: cardBox.right, width: cardBox.width, clientWidth: card.clientWidth, scrollWidth: card.scrollWidth },
            flow: { left: flowBox.left, right: flowBox.right, width: flowBox.width },
            timeline: { left: timelineBox.left, right: timelineBox.right, width: timelineBox.width }
          }
        })()`
      },
      { wait: 150 }
    ]
  })),
  // 续作行：回复封口后 Agent 继续工作（会话交接后接续任务）。回复正文之下出现「回复后继续工作中」
  // 说明行 + 续作过程卡：已持久化续作块（todo / Explored 组 / 编辑卡）在前，直播中的 shell 在后。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-continuation-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode, query: 'continuation=1',
    storage: railStorage({ colorMode }), clip: '.workspace-timeline',
    actions: [
      { eval: `document.querySelector('[data-entry-id="reply:handoff-1"]').scrollIntoView({ block: 'start' })` },
      {
        label: '续作行结构',
        probe: `(() => {
          const reply = document.querySelector('[data-entry-id="reply:handoff-1"]')
          const row = document.querySelector('.chat-row--continuation')
          if (!reply || !row) return { found: false }
          const caption = row.querySelector('.chat-continuation-caption')?.textContent ?? ''
          return {
            found: true,
            below: row.getBoundingClientRect().top >= reply.getBoundingClientRect().bottom - 1,
            caption,
            liveCaption: caption.endsWith('中'),
            noAvatar: !row.querySelector('.chat-face-avatar') && !row.querySelector('.chat-name'),
            persistedFirst: Array.from(row.querySelectorAll('[data-step-id]')).map((node) => node.getAttribute('data-step-id')).slice(0, 2),
            shellRunning: Boolean(row.querySelector('.cursor-native-shell .cursor-native-shell__output'))
          }
        })()`
      },
      { wait: 150 }
    ]
  })),
  // 待投递托盘：Agent 处理中时新发的两条消息不进时间线，停在时间线与输入区之间（一条带保持位，
  // 另有 1 条内部静默消息只计数）。探针核对：托盘位于时间线之下、输入区之上；排队正文不在任何气泡里。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-queue-tray-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode, query: 'queued=1',
    storage: railStorage({ colorMode }), clip: null,
    actions: [
      {
        label: '托盘结构',
        probe: `(() => {
          const tray = document.querySelector('.queue-tray')
          const timeline = document.querySelector('.workspace-timeline-wrap')
          const composer = document.querySelector('.workspace-composer')
          if (!tray || !timeline || !composer) return { found: false }
          const trayBox = tray.getBoundingClientRect()
          const composerBox = composer.getBoundingClientRect()
          const bubbles = Array.from(document.querySelectorAll('.chat-row--mine')).map((row) => row.textContent ?? '')
          return {
            found: true,
            belowTimeline: trayBox.top >= timeline.getBoundingClientRect().bottom - 1,
            aboveComposer: trayBox.bottom <= composerBox.top + 1,
            sameWidthAsComposer: Math.abs(trayBox.left - composerBox.left) < 1 && Math.abs(trayBox.right - composerBox.right) < 1,
            depth: tray.getAttribute('data-queue-depth'),
            items: tray.querySelectorAll('.queue-tray__item').length,
            heldItems: tray.querySelectorAll('.queue-tray__item.is-held').length,
            queuedTextInTimeline: bubbles.some((text) => text.includes('顺手把托盘的暗色也走查一下')),
            note: tray.querySelector('.queue-tray__note')?.textContent ?? ''
          }
        })()`
      },
      { wait: 150 }
    ]
  })),
  {
    name: 'session-queue-tray-collapsed', width: 1440, height: 900, colorScheme: 'light', query: 'queued=1', storage: railStorage(), clip: '.queue-tray',
    actions: [{ click: '.queue-tray__head' }, { wait: 200 }]
  },
  {
    name: 'session-process-group-expanded', width: 1440, height: 1200, colorScheme: 'light', storage: railStorage(), clip: '.chat-row--process:has(.cursor-native-group)',
    actions: [
      { click: '.cursor-native-group.is-explore .cursor-native-group__head' },
      { wait: 150 },
      { eval: `document.querySelector('.chat-row--process:has(.cursor-native-group)').scrollIntoView({ block: 'start' })` },
      { wait: 150 }
    ]
  },
  // 编辑行展开：结构化 diff 按行着色（增删绿红），浅/深各一张。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-edit-interaction-audit-${colorMode}`, width: 900, height: 900, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: EDIT_CARD,
    actions: [
      { eval: `(() => { const card = document.querySelector(${JSON.stringify(EDIT_CARD)}); card.scrollIntoView({block:'center'}); card.querySelector('.cursor-native-edit__language').textContent = 'HTML'; window.__editAuditHeight = card.getBoundingClientRect().height })()` },
      { hover: '.brand' },
      { probe: editCardProbe(false, false) },
      { hover: EDIT_CARD },
      { probe: editCardProbe(false, true) },
      { click: `${EDIT_CARD} .cursor-native-edit__head` },
      { hover: '.brand' },
      { probe: editCardProbe(true, false) },
      { click: `${EDIT_CARD} .cursor-native-edit__head` },
      { hover: '.brand' },
      { probe: editCardProbe(false, false) },
      { key: 'Tab', code: 'Tab' },
      { probe: editCardProbe(false, true) }
    ]
  })),
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-diff-preview-${colorMode}`, width: 1100, height: 900, colorScheme: colorMode, storage: railStorage({ colorMode }),
    clip: '.cursor-native-edit[data-step-id="block:live-edit"]',
    actions: [{ eval: `document.querySelector('.cursor-native-edit[data-step-id="block:live-edit"]').scrollIntoView({ block: 'center' })` }, { wait: 150 }]
  })),
  {
    name: 'session-process-diff-preview-hover', width: 1100, height: 900, colorScheme: 'light', storage: railStorage(),
    clip: '.cursor-native-edit[data-step-id="block:live-edit"]',
    actions: [
      { eval: `document.querySelector('.cursor-native-edit[data-step-id="block:live-edit"]').scrollIntoView({ block: 'center' })` },
      { hover: '.cursor-native-edit[data-step-id="block:live-edit"]' },
      { wait: 150 }
    ]
  },
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-diff-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode, storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-group)',
    actions: [
      { click: '.cursor-native-edit[data-step-id="block:live-edit"] .cursor-native-edit__head' },
      { wait: 150 },
      { eval: `document.querySelector('.chat-row--process:has(.cursor-native-group)').scrollIntoView({ block: 'start' })` },
      { wait: 150 }
    ]
  })),
  // 编辑运行态：固定高度尾窗、最新代码行强调、自动贴底（hook v29 streamContent）。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-edit-stream-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode, storage: railStorage({ colorMode }), clip: '.cursor-native-edit:has(.cursor-native-diff.is-live)',
    actions: [
      { eval: `document.querySelector('.cursor-native-edit:has(.cursor-native-diff.is-live)').scrollIntoView({ block: 'center' })` },
      { wait: 150 }
    ]
  })),
  {
    name: 'session-question-selected', width: 1440, height: 1100, colorScheme: 'light', storage: railStorage(), clip: '.cursor-native-tool.is-question',
    actions: [
      { click: '.cursor-question__item:nth-of-type(1) .cursor-question__option:first-child' },
      { click: '.cursor-question__item:nth-of-type(2) .cursor-question__option:first-child' },
      { click: '.cursor-question__item:nth-of-type(2) .cursor-question__option:nth-child(2)' },
      { eval: `document.querySelector('.cursor-native-tool.is-question').scrollIntoView({ block: 'center' })` },
      { wait: 150 }
    ]
  },
  {
    name: 'session-question-answered', width: 1440, height: 1100, colorScheme: 'light', storage: railStorage(), clip: '.cursor-native-tool.is-question',
    actions: [
      { click: '.cursor-question__item:nth-of-type(1) .cursor-question__option:first-child' },
      { click: '.cursor-question__item:nth-of-type(2) .cursor-question__option:first-child' },
      { click: '.cursor-question__confirm' },
      { wait: 250 },
      { click: '.cursor-native-tool.is-question .cursor-native-tool__head' },
      { eval: `document.querySelector('.cursor-native-tool.is-question').scrollIntoView({ block: 'center' })` },
      { wait: 150 }
    ]
  }
]

for (const scene of scenes) {
  if (scene.run) {
    scene.hash = 'run'
    scene.width ??= 1440
    scene.height ??= 900
    scene.clip ??= '.run-page__inner'
  }
  if (scene.rail) {
    scene.width ??= 1440
    scene.height ??= 900
    scene.clip ??= '.session-pane'
  }
  if (scene.clip === undefined && scene.name !== 'inspector-closed' && !scene.hash) scene.clip = '.workspace-inspector'
  if (scene.clip === null) delete scene.clip
}

if (args.includes('--list')) {
  for (const scene of scenes) console.log(scene.name)
  process.exit(0)
}

function resolveBrowser() {
  if (process.env.PREVIEW_BROWSER) return process.env.PREVIEW_BROWSER
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!found) throw new Error('未找到 Chrome / Edge；用 PREVIEW_BROWSER 指定可执行文件')
  return found
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch { /* 浏览器尚未监听 */ }
    await sleep(120)
  }
  throw new Error('浏览器调试端口未就绪')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`))
        else done(message.result)
        return
      }
      if (message.method) for (const listener of this.listeners) listener(message)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject })
      this.socket.send(JSON.stringify(payload))
    })
  }

  once(method, sessionId, timeoutMs = 15_000) {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(`等待 ${method} 超时`))
      }, timeoutMs)
      const listener = (message) => {
        if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        done(message.params)
      }
      this.listeners.add(listener)
    })
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate 失败')
  return result.result?.value
}

async function navigate(cdp, sessionId, url) {
  const loaded = cdp.once('Page.loadEventFired', sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  await loaded
}

async function elementCenter(cdp, sessionId, selector) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    element.scrollIntoView({ block: 'nearest' })
    const box = element.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 18) }
  })()`)
  if (!rect) throw new Error(`未找到元素：${selector}`)
  return rect
}

async function runActions(cdp, sessionId, actions = []) {
  for (const action of actions) {
    if (action.wait) await sleep(action.wait)
    if (action.hover) {
      const { x, y } = await elementCenter(cdp, sessionId, action.hover)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
      await sleep(220)
    }
    if (action.click || action.clickNoWait) {
      const { x, y } = await elementCenter(cdp, sessionId, action.click ?? action.clickNoWait)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
      if (action.click) await sleep(260)
    }
    if (action.key) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, ...(action.code ? { code: action.code } : {}) }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, ...(action.code ? { code: action.code } : {}) }, sessionId)
      await sleep(260)
    }
    if (action.eval) await evaluate(cdp, sessionId, action.eval)
    if (action.probe) console.log(`  · ${action.label ?? 'probe'}: ${JSON.stringify(await evaluate(cdp, sessionId, action.probe))}`)
  }
}

async function shoot(cdp, scene) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: scene.width, height: scene.height, deviceScaleFactor: 2, mobile: false
    }, sessionId)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: scene.colorScheme ?? 'light' },
        { name: 'prefers-reduced-motion', value: scene.reducedMotion ? 'reduce' : 'no-preference' }
      ]
    }, sessionId)
    // 先落到同源空页写 localStorage，再进正式页面：首帧即为目标状态，没有二次布局。
    // bootstrap 页本身也会挂载应用并回写外观偏好（上一场景的深浅色）；等它写完再覆盖一次。
    await navigate(cdp, sessionId, `${BASE}/preview.html?bootstrap=1`)
    const seedStorage = `(() => {
      localStorage.clear()
      for (const [key, value] of Object.entries(${JSON.stringify(scene.storage ?? {})})) localStorage.setItem(key, value)
      return true
    })()`
    await evaluate(cdp, sessionId, seedStorage)
    await sleep(300)
    await evaluate(cdp, sessionId, seedStorage)
    await navigate(cdp, sessionId, `${BASE}/preview.html${scene.query ? `?${scene.query}` : ''}#${scene.hash ?? `sessions:${scene.channel ?? '2'}`}`)
    await sleep(scene.settleMs ?? 900)
    await runActions(cdp, sessionId, scene.actions)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const file = join(OUT, `${scene.name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`✓ ${scene.name} → ${file}`)
    // 右栏特写：同一状态再按元素边界裁一张，细节（字号、间距、hairline）看得清。
    if (scene.clip) {
      const box = await evaluate(cdp, sessionId, `(() => {
        const element = document.querySelector(${JSON.stringify(scene.clip)})
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })()`)
      if (box) {
        const clipped = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } }, sessionId)
        const clipFile = join(OUT, `${scene.name}.clip.png`)
        writeFileSync(clipFile, Buffer.from(clipped.data, 'base64'))
        console.log(`  ↳ ${clipFile}`)
      }
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function main() {
  const selected = ONLY ? scenes.filter((scene) => ONLY.includes(scene.name)) : scenes
  if (!selected.length) throw new Error(`没有匹配的场景：${ONLY?.join(', ')}`)
  try {
    const probe = await fetch(`${BASE}/preview.html`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch (error) {
    throw new Error(`预览服务器不可达（${BASE}）：先运行 npm run preview:ui。${error instanceof Error ? error.message : ''}`)
  }
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'sg-preview-shots-'))
  const browser = spawn(resolveBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' })
  let socket
  try {
    const endpoint = await waitForEndpoint(CDP_PORT)
    socket = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    await new Promise((done, reject) => {
      socket.once('open', done)
      socket.once('error', reject)
    })
    const cdp = new Cdp(socket)
    for (const scene of selected) {
      try {
        await shoot(cdp, scene)
      } catch (error) {
        console.error(`✗ ${scene.name}: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    }
  } finally {
    socket?.close()
    const exited = new Promise((done) => browser.once('exit', done))
    browser.kill()
    await Promise.race([exited, sleep(3_000)])
    // 浏览器退出后仍可能短暂持有 profile 文件锁（Windows）：重试几次，清不掉也不算失败。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await sleep(400)
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
