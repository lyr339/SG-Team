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
const REVIEW_SCOPE_KEY = 'sg-team.inspector:review-scope:v2'
const APPEARANCE_KEY = 'shiguang.appearance.v1'

/** 基础存储：右栏展开、CH-2 会话、默认宽度；accent / background 为主题色 / 背景预设 id（缺省拾光橙 / 折光）。 */
function baseStorage({ tab = 'review', width = 540, cardOpacity = 0.9, colorMode = 'light', scope = 'turn', accent = 'sg-orange', background = 'refraction' } = {}) {
  return {
    [INSPECTOR_OPEN_KEY]: '1',
    [INSPECTOR_TAB_KEY]: tab,
    [INSPECTOR_WIDTH_KEY]: JSON.stringify([width]),
    [REVIEW_SCOPE_KEY]: scope,
    [APPEARANCE_KEY]: JSON.stringify({ cardOpacity, colorMode, accent, background }),
    'shiguang.lastSessionChannel.v1': '2'
  }
}

const SESSION_RAIL_WIDTH_KEY = 'sg-team.layout:v1:shell.sessions.v2'

/** 会话侧栏走查：右栏收起、选中 CH-2、侧栏宽度可指定（默认 326，下限 300）。 */
function railStorage({ cardOpacity = 0.94, colorMode = 'light', railWidth = 326 } = {}) {
  return {
    ...baseStorage({ cardOpacity, colorMode }),
    [INSPECTOR_OPEN_KEY]: '0',
    [SESSION_RAIL_WIDTH_KEY]: JSON.stringify([railWidth])
  }
}

const TABS = ['review', 'plan', 'activity', 'artifacts']
const SELECT_TIMELINE_TEXT = `new Promise((done, fail) => {
  const paragraph = [...document.querySelectorAll('.workspace-timeline .chat-row--agent .message-content p')]
    .find((node) => node.textContent?.includes('架构报告已整理完毕'))
  if (!paragraph) return fail(new Error('选择目标正文缺失'))
  paragraph.scrollIntoView({ block: 'center' })
  requestAnimationFrame(() => {
    const node = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()
    if (!node?.textContent) return fail(new Error('正文没有文本节点'))
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(9, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    done(selection.toString())
  })
})`
const INSPECTOR_TAB_GEOMETRY_PROBE = `(() => {
  const shell = document.querySelector('.workspace-inspector')
  const tabs = [...shell.querySelectorAll('.inspector-tab')].map((tab) => ({
    label: tab.querySelector('.inspector-tab__label')?.textContent,
    active: tab.classList.contains('is-active'),
    width: Math.round(tab.getBoundingClientRect().width),
    height: Math.round(tab.getBoundingClientRect().height),
    revealWidth: Math.round(tab.querySelector('.inspector-tab__reveal').getBoundingClientRect().width)
  }))
  const bar = shell.querySelector('.workspace-inspector__bar').getBoundingClientRect()
  const close = shell.querySelector('.workspace-inspector__close').getBoundingClientRect()
  const iconOnly = bar.width < shell.getBoundingClientRect().width / 2
  const size = iconOnly ? 30 : 32
  if (tabs.some((tab) => tab.height !== size || (iconOnly && tab.width !== size) || (!iconOnly && !tab.active && tab.width !== size))) throw new Error('标签尺寸不一致: ' + JSON.stringify(tabs))
  if (tabs.some((tab) => iconOnly ? tab.revealWidth !== 0 : (tab.active ? tab.revealWidth <= 0 : tab.revealWidth !== 0))) throw new Error('标签展开状态错误')
  if (Math.abs(close.height - size) > .5 || Math.abs((close.top + close.height / 2) - (bar.top + bar.height / 2)) > .5) throw new Error('关闭按钮未对齐')
  return { iconOnly, tabs }
})()`
const REVIEW_WIDE_HEADER_PROBE = `(() => {
  const shell = document.querySelector('.workspace-inspector').getBoundingClientRect()
  const summary = document.querySelector('.inspector-review__summary').getBoundingClientRect()
  const scope = document.querySelector('.inspector-review__scope-trigger').getBoundingClientRect()
  const totals = document.querySelector('.inspector-review__totals').getBoundingClientRect()
  const toolbar = document.querySelector('.inspector-review__toolbar').getBoundingClientRect()
  const tabs = document.querySelector('.workspace-inspector__bar').getBoundingClientRect()
  if (summary.height > 55) throw new Error('审查工具行换行: ' + summary.height)
  if (scope.right > totals.left + 1 || totals.right > toolbar.left + 1 || toolbar.right > tabs.left + 1) {
    throw new Error('审查工具行重叠: ' + JSON.stringify({scope:scope.right,totals:[totals.left,totals.right],toolbar:[toolbar.left,toolbar.right],tabs:tabs.left}))
  }
  if (tabs.right > shell.right + 1) throw new Error('标签越过右栏边缘')
  return { width: Math.round(shell.width), summaryHeight: Math.round(summary.height), toolbarRight: Math.round(toolbar.right), tabsLeft: Math.round(tabs.left) }
})()`
const INSPECTOR_WIDE_PANEL_PROBE = `(() => {
  const bar = document.querySelector('.workspace-inspector__bar').getBoundingClientRect()
  const header = document.querySelector('.inspector-panel:not(.is-hidden) .inspector-section__header')
  const title = header?.querySelector('div:first-child')?.getBoundingClientRect()
  const aside = header?.querySelector('.inspector-section__aside')?.getBoundingClientRect()
  if (!header || !title || title.right > bar.left + 1 || (aside && aside.right > bar.left + 1)) throw new Error('面板标题与标签重叠')
  if (Math.abs(header.getBoundingClientRect().top - bar.top) > 2) throw new Error('面板标题未与标签同排')
  return { titleRight:Math.round(title.right), tabsLeft:Math.round(bar.left), asideRight:aside ? Math.round(aside.right) : null }
})()`
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
/** §7 探针：组卡片网格不得横向溢出，卡片右缘不越过网格右缘。 */
const GROUPS_GRID_PROBE = `(() => {
  const grid = document.querySelector('.pool-groups__grid')
  if (!grid) throw new Error('没有组卡片网格')
  if (grid.scrollWidth > grid.clientWidth + 1) throw new Error('组卡片网格横向溢出: ' + grid.scrollWidth + ' > ' + grid.clientWidth)
  const gridRect = grid.getBoundingClientRect()
  const cards = [...grid.querySelectorAll('.group-card')]
  for (const card of cards) {
    if (card.getBoundingClientRect().right > gridRect.right + 1) throw new Error('组卡片越过网格右缘')
  }
  return { cards: cards.length, width: Math.round(gridRect.width) }
})()`

/** §7 探针（口径更新）：建组抽屉是带背板的模态面——校验抽屉在视口内、背板全覆盖（inspector 在背板之下）。 */
const COMPOSER_PROBE = `(() => {
  const drawer = document.querySelector('.group-composer')
  if (!drawer) throw new Error('建组抽屉未打开')
  const rect = drawer.getBoundingClientRect()
  if (rect.right > innerWidth + 0.5 || rect.top < -0.5 || rect.bottom > innerHeight + 0.5) throw new Error('抽屉超出视口')
  const backdrop = document.querySelector('.group-composer-backdrop').getBoundingClientRect()
  if (backdrop.width < innerWidth - 1 || backdrop.height < innerHeight - 1) throw new Error('背板未覆盖视口')
  return { width: Math.round(rect.width), height: Math.round(rect.height) }
})()`

/** 名册多选：程序化勾选一行（复选框平时仅悬停可见，.click() 不受 pointer-events 限制）。 */
const pickRailRow = (channelId) => `document.querySelector('.session-row[data-channel-id="${channelId}"]')
  .closest('.session-list__slot').querySelector('.session-row__pick input').click()`

/** §7 探针：浮动条是 session-pane 网格第三行——名册收缩让位，滚到底后最后一行完整可见、与条不重叠。 */
const RAIL_BAR_PROBE = `new Promise((done, fail) => {
  const list = document.querySelector('.session-list')
  const bar = document.querySelector('.session-pane__bar')
  if (!bar) return fail(new Error('浮动条未出现'))
  list.scrollTop = list.scrollHeight
  requestAnimationFrame(() => {
    const barRect = bar.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    if (listRect.bottom > barRect.top + 0.5) return fail(new Error('名册与浮动条重叠: list.bottom=' + listRect.bottom + ' bar.top=' + barRect.top))
    const last = [...list.querySelectorAll('.session-list__slot')].at(-1).getBoundingClientRect()
    if (last.bottom > listRect.bottom + 0.5) return fail(new Error('最后一行被浮动条遮挡: ' + last.bottom + ' > ' + listRect.bottom))
    done({ listBottom: Math.round(listRect.bottom), barTop: Math.round(barRect.top), lastRowBottom: Math.round(last.bottom) })
  })
})`

const scenes = [
  ...[540, 300].map((width) => ({
    name: `inspector-header-align-${width}`, width: width === 300 ? 1180 : 1440, height: 900,
    colorScheme: 'dark', storage: baseStorage({ width, colorMode: 'dark' }), clip: '.workspace-inspector',
    actions: [{ label: '三种计数与各自标题首行对齐', probe: `new Promise(async (done, fail) => {
      const result = []
      for (const id of ['plan','activity','artifacts']) {
        const tab = [...document.querySelectorAll('.inspector-tab')].find(tab => tab.getAttribute('aria-label') === ({plan:'计划',activity:'活动',artifacts:'产物'})[id])
        tab?.click()
        await new Promise(resolve => setTimeout(resolve, 220))
        const panel = document.querySelector('.inspector-panel:not(.is-hidden)')
        const title = panel?.querySelector('.inspector-section__header strong')?.getBoundingClientRect()
        const count = panel?.querySelector('.inspector-section__aside b')?.getBoundingClientRect()
        if (!title || !count) return fail(new Error(id + ' 标题或计数缺失'))
        const delta = count.top - title.top
        if (Math.abs(delta - (title.height-count.height)/2) > 1.5) return fail(new Error(id + ' 计数未与标题首行居中'))
        result.push({id,topDelta:Math.round(delta*10)/10})
      }
      done(result)
    })` }]
  })),
  { name: 'windows-topbar-compact', width: 1440, height: 900, colorScheme: 'dark', storage: railStorage({ colorMode: 'dark' }), clip: '.topbar',
    actions: [{ eval: `document.documentElement.dataset.platform = 'win32'` }, { wait: 80 }, {
      label: 'Windows 顶栏与原生按钮空间同高', probe: `(() => {
        const bar = document.querySelector('.topbar').getBoundingClientRect()
        const actions = document.querySelector('.topbar__actions').getBoundingClientRect()
        if (Math.abs(bar.height - 42) > .5 || actions.right > innerWidth - 138) throw new Error('Windows 顶栏高度或原生按钮避让错误')
        return { height:bar.height, actionsRight:Math.round(actions.right), nativeStart:innerWidth - 138 }
      })()`
    }] },
  { name: 'mac-topbar-compact', width: 1440, height: 900, colorScheme: 'dark', storage: railStorage({ colorMode: 'dark' }), clip: '.topbar',
    actions: [{ eval: `document.documentElement.dataset.platform = 'darwin'` }, { probe: `(() => {
      const height = document.querySelector('.topbar').getBoundingClientRect().height
      if (Math.abs(height - 48) > .5) throw new Error('macOS 顶栏高度错误')
      const project = document.querySelector('.workspace-detection-chip')
      const connection = document.querySelector('.connection-chip')
      const icons = [...document.querySelectorAll('.topbar__actions .panel-button, .topbar__actions .appearance-button, .topbar__actions .account-button')]
      if (!project || !connection || !icons.length || [project,connection,...icons].some(el => Math.abs(el.getBoundingClientRect().height - 30) > .5)) throw new Error('顶栏控件高度未统一')
      if (icons.some(el => Math.abs(el.getBoundingClientRect().width - 30) > .5)) throw new Error('图标按钮宽度未收紧')
      if (project.scrollWidth > project.clientWidth + 1 || connection.scrollWidth > connection.clientWidth + 1) throw new Error('顶栏文字被裁切')
      return { height, projectWidth:Math.round(project.getBoundingClientRect().width), connectionWidth:Math.round(connection.getBoundingClientRect().width), iconCount:icons.length }
    })()` }, { click: '.connection-chip' }, { label: '连接详情随顶栏下沿落位', probe: `(() => {
      const bar = document.querySelector('.topbar').getBoundingClientRect()
      const panel = document.querySelector('.connection-popover')?.getBoundingClientRect()
      if (!panel || Math.abs(panel.top - bar.bottom - 6) > 1) throw new Error('连接详情浮层与新顶栏高度错位')
      return { gap:Math.round(panel.top-bar.bottom) }
    })()` }] },
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-selection-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.workspace-timeline-wrap',
    actions: [{ eval: SELECT_TIMELINE_TEXT }, { wait: 120 }, { label: '选中文字出现轻量操作条', probe: `(() => {
      const bar = document.querySelector('.timeline-selection-actions')
      if (!bar || !bar.textContent.includes('复制') || !bar.textContent.includes('引用')) throw new Error('选中工具条缺失')
      const rect = bar.getBoundingClientRect(), frame = document.querySelector('.workspace-timeline-wrap').getBoundingClientRect()
      if (rect.left < frame.left || rect.right > frame.right || rect.top < frame.top || rect.bottom > frame.bottom) throw new Error('选中工具条越界')
      return { selected:window.getSelection()?.toString(), withinTimeline:true }
    })()` }]
  })),
  { name: 'session-selection-quote', width: 1440, height: 900, colorScheme: 'light', storage: railStorage(), clip: '.workspace-composer',
    actions: [{ eval: SELECT_TIMELINE_TEXT }, { click: '.timeline-selection-actions button[title="引用选中文字到输入框"]' }, {
      label: '引用选中文字并聚焦输入框', probe: `(() => {
        const textarea = document.querySelector('.workspace-composer textarea')
        if (!textarea?.value.includes('> 架构报告已整理完毕') || document.activeElement !== textarea || document.querySelector('.timeline-selection-actions')) throw new Error('引用没有进入输入框')
        return { draft:textarea.value.slice(0, 50), focused:true }
      })()`
    }] },
  { name: 'session-selection-copy', width: 1440, height: 900, colorScheme: 'light', storage: railStorage(), clip: '.workspace-timeline-wrap',
    actions: [{ eval: `Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async text => { window.__copiedSelection = text } } })` },
      { eval: SELECT_TIMELINE_TEXT }, { click: '.timeline-selection-actions button[title="复制选中文字"]' }, {
        label: '只复制选中片段并给予反馈', probe: `(() => {
          const feedback = document.querySelector('.timeline-selection-actions [role="status"]')?.textContent
          if (window.__copiedSelection !== '架构报告已整理完毕' || feedback !== '已复制') throw new Error('选中复制或反馈错误')
          return { copied:window.__copiedSelection, feedback }
        })()`
      }] },
  { name: 'session-selection-scroll-dismiss', width: 1440, height: 900, colorScheme: 'light', storage: railStorage(), clip: '.workspace-timeline-wrap',
    actions: [{ eval: SELECT_TIMELINE_TEXT }, { eval: `document.querySelector('.workspace-timeline').dispatchEvent(new Event('scroll'))` }, {
      label: '滚动时收起浮层', probe: `(() => {
        if (document.querySelector('.timeline-selection-actions')) throw new Error('滚动后浮层残留')
        return { dismissed:true }
      })()`
    }] },
  ...['light', 'dark'].map(colorMode => ({
    name: `session-typing-isolation-${colorMode}`, width: 1180, height: 900, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: null,
    actions: [{ label: '真实 App 输入与时间线稳定性', probe: `new Promise(async (resolve, reject) => {
      const timeline = document.querySelector('.workspace-timeline')
      const textarea = document.querySelector('.workspace-composer textarea')
      if (!timeline || !textarea) { reject(new Error('时间线或输入区未加载')); return }
      const rows = [...timeline.querySelectorAll('.chat-row')]
      const before = timeline.textContent
      let mutations = 0
      const observer = new MutationObserver(records => { mutations += records.length })
      observer.observe(timeline, {childList: true, characterData: true, subtree: true})
      try {
        textarea.focus({preventScroll:true})
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        const text = '输入性能验收：只修改草稿，历史消息保持原位。'
        for (let i = 1; i <= text.length; i++) {
          setter.call(textarea, text.slice(0, i))
          textarea.dispatchEvent(new Event('input', {bubbles:true}))
          await new Promise(requestAnimationFrame)
        }
        if (textarea.value !== text) throw new Error('草稿更新失败')
        const after = [...timeline.querySelectorAll('.chat-row')]
        if (rows.length !== after.length || rows.some((row, i) => row !== after[i])) throw new Error('打字导致历史行重挂载')
        if (timeline.textContent !== before || mutations !== 0) throw new Error('打字修改了历史内容: ' + mutations)
        resolve({characters:text.length, rows:rows.length, contentMutations:mutations, stableNodes:true})
      } catch (error) { reject(error) } finally { observer.disconnect() }
    })` }]
  })),
  ...TABS.flatMap((tab) => [
    { name: `${tab}-light`, width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab }) },
    { name: `${tab}-dark`, width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ tab, colorMode: 'dark' }) }
  ]),
  ...[520, 540].map((width) => ({
    name: `review-wide-${width}`, width: 1440, height: 900, colorScheme: 'light',
    storage: baseStorage({ width }), clip: '.workspace-inspector',
    actions: [{ label: '范围、统计、操作与标签同排不相撞', probe: REVIEW_WIDE_HEADER_PROBE }]
  })),
  ...['plan', 'activity', 'artifacts'].map((tab) => ({
    name: `inspector-wide-${tab}`, width: 1440, height: 900, colorScheme: 'dark',
    storage: baseStorage({ tab, width: 520, colorMode: 'dark' }), clip: '.workspace-inspector',
    actions: [{ label: '面板标题与固定标签同排不遮挡', probe: INSPECTOR_WIDE_PANEL_PROBE }]
  })),
  {
    name: 'inspector-tabs-stable', width: 1440, height: 900, colorScheme: 'light',
    storage: baseStorage({ width: 540 }), clip: '.workspace-inspector',
    actions: [{ label: '四标签切换位置稳定', probe: `new Promise((done, fail) => {
      const tabs = [...document.querySelectorAll('.inspector-tab')]
      const before = tabs.map(tab => tab.getBoundingClientRect().left)
      tabs[1].click()
      setTimeout(() => {
        const after = tabs.map(tab => tab.getBoundingClientRect().left)
        if (after.some((left,i) => Math.abs(left-before[i]) > 1)) return fail(new Error('切换到计划时标签横跳: '+JSON.stringify({before,after})))
        tabs[2].click()
        setTimeout(() => {
          const final = tabs.map(tab => tab.getBoundingClientRect().left)
          if (final.some((left,i) => Math.abs(left-before[i]) > 1)) return fail(new Error('切换到活动时标签横跳: '+JSON.stringify({before,final})))
          done({stable:true})
        },250)
      },250)
    })` }]
  },
  {
    name: 'review-dual-min', width: 1440, height: 900, colorScheme: 'light',
    storage: { ...baseStorage({ width: 540 }), [SESSION_RAIL_WIDTH_KEY]: JSON.stringify([560]) },
    actions: [{ label: '最小窗口双栏可见且中栏守住阅读宽度', probe: `(() => {
      const left = document.querySelector('.session-sidebar-pane').getBoundingClientRect()
      const middle = document.querySelector('.content-stage').getBoundingClientRect()
      const right = document.querySelector('.workspace-inspector-pane').getBoundingClientRect()
      if (left.width < 300 || right.width < 320 || middle.width < 500) throw new Error('双栏空间预算失效: ' + JSON.stringify({left:left.width,middle:middle.width,right:right.width}))
      if (left.right > middle.left + 1 || middle.right > right.left + 1) throw new Error('双栏互相覆盖')
      return { left:Math.round(left.width), middle:Math.round(middle.width), right:Math.round(right.width) }
    })()` }]
  },
  // 宽审查栏四标签收为图标；其它面板的选中标签展开文字。两个几何模式分别验收。
  ...['light', 'dark'].map((colorMode) => ({
    name: `inspector-tabs-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode, storage: baseStorage({ colorMode }),
    clip: '.workspace-inspector__bar',
    actions: [{
      label: '标签胶囊几何',
      probe: INSPECTOR_TAB_GEOMETRY_PROBE
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
  { name: 'inspector-tabs-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ tab: 'activity', width: 300 }), clip: '.workspace-inspector__bar', actions: [{ label: '窄栏标签几何', probe: INSPECTOR_TAB_GEOMETRY_PROBE }] },
  // 窄栏：窗口 1180 宽、右栏收到下限 300，标签应收成纯图标。
  { name: 'review-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ width: 300 }), actions: [{ label: '窄栏操作仍在一行', probe: `(() => {
    const head = document.querySelector('.inspector-review__summary')
    const scope = document.querySelector('.inspector-review__scope-trigger')
    const toolbar = document.querySelector('.inspector-review__toolbar')
    if (!head || head.scrollWidth > head.clientWidth + 1 || head.getBoundingClientRect().height > 55) throw new Error('窄栏审查头部换行或溢出')
    if (scope.getBoundingClientRect().right >= toolbar.getBoundingClientRect().left) throw new Error('范围与操作按钮重叠')
    return { width: Math.round(head.clientWidth), height: Math.round(head.clientHeight) }
  })()` }] },
  { name: 'review-gutter-scroll', width: 1180, height: 760, colorScheme: 'dark', storage: baseStorage({ width: 320, colorMode: 'dark' }), actions: [{
    label: '单列行号与增删轨在横向阅读时固定', probe: `(() => {
      const diff = document.querySelector('.review-diff')
      const oldNumber = diff?.querySelector('.review-line.is-deletion > span')
      const newNumber = diff?.querySelector('.review-line.is-addition > span')
      if (!diff || !oldNumber || !newNumber || diff.scrollWidth <= diff.clientWidth) throw new Error('窄栏差异没有横向阅读区')
      const oldX = oldNumber.getBoundingClientRect().left
      const newX = newNumber.getBoundingClientRect().left
      const hunkHeader = diff.querySelector('.review-hunk__header')
      const editHeader = diff.querySelector('.review-edit__head')
      const skipped = diff.querySelector('.review-hunk__skipped')
      const headerBefore = hunkHeader?.getBoundingClientRect().left
      const editBefore = editHeader?.getBoundingClientRect().left
      const skippedBefore = skipped?.getBoundingClientRect().left
      if (Math.abs(oldX-newX) > 1) throw new Error('增删行号没有共用一列')
      const oldMarker = getComputedStyle(oldNumber, '::before')
      const newMarker = getComputedStyle(newNumber, '::before')
      const oldStyle = getComputedStyle(oldNumber)
      const newStyle = getComputedStyle(newNumber)
      const stripes = oldMarker.backgroundImage
      const green = newMarker.backgroundColor
      if (!stripes.includes('repeating-linear-gradient') || green === 'rgba(0, 0, 0, 0)') throw new Error('增删轨样式缺失')
      if (Math.abs(parseFloat(oldMarker.width)-4) > .1 || Math.abs(parseFloat(newMarker.width)-4) > .1) throw new Error('增删轨太宽')
      if (!oldStyle.boxShadow.includes('inset') || !newStyle.boxShadow.includes('inset')) throw new Error('行号右侧深色分隔线缺失')
      if (oldStyle.backgroundColor === getComputedStyle(oldNumber.parentElement).backgroundColor ||
          newStyle.backgroundColor === getComputedStyle(newNumber.parentElement).backgroundColor) throw new Error('行号底色没有与代码底色分层')
      diff.scrollLeft = 120
      if (Math.abs(oldNumber.getBoundingClientRect().left-oldX) > 1 || Math.abs(newNumber.getBoundingClientRect().left-newX) > 1) throw new Error('滚动时行号/变更轨漂走')
      if (hunkHeader && Math.abs(hunkHeader.getBoundingClientRect().left-headerBefore) > 1) throw new Error('代码块标题漂走')
      if (editHeader && Math.abs(editHeader.getBoundingClientRect().left-editBefore) > 1) throw new Error('逐次编辑标题漂走')
      if (hunkHeader && hunkHeader.getBoundingClientRect().right > diff.getBoundingClientRect().right + 1) throw new Error('代码块标题越过窄栏')
      if (editHeader && editHeader.getBoundingClientRect().right > diff.getBoundingClientRect().right + 1) throw new Error('逐次编辑标题越过窄栏')
      return { old:oldNumber.textContent, next:newNumber.textContent, scrollLeft:diff.scrollLeft, aligned:true, sticky:true,
        header:[headerBefore,hunkHeader?.getBoundingClientRect().left,hunkHeader?.getBoundingClientRect().right], edit:[editBefore,editHeader?.getBoundingClientRect().left],
        skipped:[skippedBefore,skipped?.getBoundingClientRect().left], diffRight:diff.getBoundingClientRect().right }
    })()`
  }] },
  { name: 'activity-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ tab: 'activity', width: 300 }) },
  // 透明模式：卡片透明度 0（clear）——正文区必须保持阅读面。
  { name: 'review-clear', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  { name: 'review-clear-dark', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ cardOpacity: 0, colorMode: 'dark' }) },
  // reduced-motion：不该有半程动画的中间态。
  { name: 'review-reduced-motion', width: 1440, height: 900, colorScheme: 'light', reducedMotion: true, storage: baseStorage() },
  // 悬停第一条文件行：动作簇出现。
  { name: 'review-hover-row', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), actions: [{ hover: '.review-file__row' }] },
  // 撤销确认浮层。
  { name: 'review-revert-confirm', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ scope: 'uncommitted' }), actions: [{ hover: '.review-file__row' }, { click: '.review-file__actions button.is-danger' }, { wait: 250 }] },
  // 分支范围 + 展开全部。
  { name: 'review-branch-expanded', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ scope: 'branch' }), actions: [{ click: '.inspector-review__toolbar button[aria-label="展开全部文件"]' }, { wait: 400 }] },
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
  { name: 'review-clean', width: 1440, height: 900, colorScheme: 'light', query: 'review=clean', storage: baseStorage({ scope: 'uncommitted' }) },
  // 非 Git 工程：面板自动落到「本轮」，正文是 Agent 编辑流（文件行 + 逐次编辑卡 + ≈ 合计），无任何 Git 动作。
  {
    name: 'review-not-git-turn', width: 1440, height: 900, colorScheme: 'light', query: 'review=not_git', storage: baseStorage(),
    actions: [{ wait: 500 }, {
      label: '非 Git 工程自动切到本轮编辑流',
      probe: `(() => {
        const scope = document.querySelector('.inspector-review__scope-trigger')
        const files = Array.from(document.querySelectorAll('.review-file'))
        const totals = document.querySelector('.inspector-review__totals')
        if ((scope?.textContent ?? '').indexOf('Last Turn') !== 0) throw new Error('范围没有落到 Last Turn: ' + scope?.textContent)
        if ((document.body.textContent ?? '').includes('当前工程未启用 Git')) throw new Error('本轮视图不该出现 not_git 卡片')
        if (!files.length) throw new Error('编辑流文件列表为空')
        if (!document.querySelector('.review-edit')) throw new Error('没有逐次编辑卡')
        if (document.querySelector('.review-file__actions button.is-danger')) throw new Error('非 Git 工程不该有撤销按钮')
        if (document.querySelector('.review-file__loading')) throw new Error('本轮视图不该出现 Git 差异骨架屏')
        return {
          found: true,
          scope: scope?.textContent ?? '',
          totals: totals?.textContent ?? '',
          files: files.map((el) => [el.getAttribute('data-path'), el.getAttribute('data-source'), el.classList.contains('is-open')]),
          addedLines: document.querySelectorAll('.review-line.is-addition').length
        }
      })()`
    }]
  },
  // 手动切回「未提交」：not_git 卡片仍在，并带「查看本轮 Agent 改动」的回程链接。
  {
    name: 'review-not-git', width: 1440, height: 900, colorScheme: 'light', query: 'review=not_git', storage: baseStorage(),
    actions: [{ wait: 500 }, { click: '.inspector-review__scope-trigger' }, { click: '.inspector-review__scope-menu button:nth-child(2)' }, { wait: 250 }, {
      label: 'not_git 卡片与回程链接',
      probe: `(() => {
        const body = document.body.textContent ?? ''
        if (!body.includes('当前工程未启用 Git')) throw new Error('not_git 卡片没有出现')
        const back = Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '查看本轮 Agent 改动')
        if (!back) throw new Error('缺「查看本轮 Agent 改动」链接')
        return { found: true }
      })()`
    }]
  },
  { name: 'review-error-dark', width: 1440, height: 900, colorScheme: 'dark', query: 'review=error', storage: baseStorage({ colorMode: 'dark', scope: 'uncommitted' }) },
  { name: 'review-many', width: 1440, height: 900, colorScheme: 'light', query: 'review=many', storage: baseStorage({ scope: 'uncommitted' }) },
  { name: 'review-syntax-dark', width: 1680, height: 900, colorScheme: 'dark', query: 'review=syntax',
    storage: baseStorage({ width: 900, colorMode: 'dark', scope: 'uncommitted' }), clip: '.workspace-inspector',
    actions: [{ label: '代码着色与字级差异同时保留', probe: `(() => {
      const code = document.querySelector('.review-file[data-path="scripts/preview-shots.mjs"]')
      const strings = [...(code?.querySelectorAll('.review-syntax.is-string') ?? [])]
      const marks = [...(code?.querySelectorAll('.review-line mark') ?? [])]
      if (!strings.length || !marks.length) throw new Error('语法着色或字级差异缺失')
      return { strings:strings.map(x=>x.textContent).slice(0,3), marks:marks.map(x=>x.textContent) }
    })()` }] },
  { name: 'review-syntax-narrow', width: 1180, height: 760, colorScheme: 'dark', query: 'review=syntax',
    storage: baseStorage({ width: 320, colorMode: 'dark', scope: 'uncommitted' }), clip: '.workspace-inspector',
    actions: [{ label: '窄栏语法着色留在代码区内', probe: `(() => {
      const shell = document.querySelector('.workspace-inspector')
      const diff = shell?.querySelector('.review-diff')
      const gutter = diff?.querySelector('.review-line.is-deletion > span')
      if (!diff || !gutter || !diff.querySelector('.review-syntax.is-string')) throw new Error('窄栏差异内容缺失')
      if (shell.scrollWidth > shell.clientWidth + 1) throw new Error('着色后整栏溢出')
      const left = gutter.getBoundingClientRect().left
      diff.scrollLeft = diff.scrollWidth
      if (Math.abs(gutter.getBoundingClientRect().left-left) > 1) throw new Error('着色后行号漂移')
      return { scrollLeft:diff.scrollLeft, sticky:true }
    })()` }] },
  {
    name: 'review-reference-dark', width: 2000, height: 900, colorScheme: 'dark', query: 'review=many',
    storage: baseStorage({ width: 1000, colorMode: 'dark', scope: 'uncommitted' }), clip: '.workspace-inspector',
    actions: [{ click: '.inspector-review__toolbar button[aria-label="展开全部文件"]' }, { wait: 300 }, {
      label: '宽栏连续差异保留文件分节与代码横向阅读', probe: `(() => {
        const shell = document.querySelector('.workspace-inspector')
        const files = [...shell.querySelectorAll('.review-file')]
        const diffs = [...shell.querySelectorAll('.review-diff')]
        if (files.length < 5 || diffs.length < 2) throw new Error('多文件差异没有连续展示')
        if (shell.scrollWidth > shell.clientWidth + 1) throw new Error('代码把整个右栏撑宽')
        if (diffs.some(diff => getComputedStyle(diff).overflowX !== 'auto')) throw new Error('代码区缺横向阅读')
        return { width:Math.round(shell.clientWidth), files:files.length, diffSections:diffs.length }
      })()`
    }]
  },
  { name: 'review-many-narrow-dark', width: 1180, height: 760, colorScheme: 'dark', query: 'review=many', storage: baseStorage({ width: 300, colorMode: 'dark', scope: 'uncommitted' }), actions: [{
    label: 'Git 代码块未修改行提示随窄栏横向阅读保持可见', probe: `(() => {
      const diff = document.querySelector('.review-diff')
      const skipped = diff?.querySelector('.review-hunk__skipped')
      if (!diff || !skipped || diff.scrollWidth <= diff.clientWidth) throw new Error('Git 差异前提不足')
      const before = skipped.getBoundingClientRect().left
      diff.scrollLeft = 120
      if (Math.abs(skipped.getBoundingClientRect().left-before) > 1) throw new Error('未修改行提示滚出视口')
      return {scrollLeft:diff.scrollLeft,skipped:[before,skipped.getBoundingClientRect().left],width:skipped.getBoundingClientRect().width,diffWidth:diff.clientWidth}
    })()`
  }] },
  // 右栏关闭态（对照）与开合中途帧（验证轨道过渡在插值而不是跳变）。
  { name: 'inspector-closed', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' } },
  {
    name: 'inspector-opening', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null,
    actions: [{
      label: 'grid-template-columns 采样（页面内计时，0/60/120/180/320ms）',
      probe: `new Promise((done) => {
        const dock = document.querySelector('.session-dock')
        const read = () => getComputedStyle(dock).gridTemplateColumns
        const samples = []
        document.querySelector('[aria-label="展开右侧工作区"]').click()
        for (const at of [0, 60, 120, 180, 320]) setTimeout(() => { samples.push(at + 'ms ' + read()); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 60 }]
  },
  { name: 'inspector-opened', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null, actions: [{ click: '[aria-label="展开右侧工作区"]' }, { wait: 400 }] },

  // ---------- 运行页（#run）：一个工程一个会话池（独立会话 + 可建可拆的协作组，阶段 3）----------
  ...[['light', 'light'], ['dark', 'dark']].flatMap(([suffix, colorMode]) => [
    // 无活跃运行：开始页 + 独立批次配置（阶段 2 · 2B 起没有模式选择）。
    { name: `run-start-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    // 升级前的一次性团队 run 仍是工作区最新运行：开始页多一句「已归档」说明。
    { name: `run-start-archived-${suffix}`, run: true, colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    // 池：全部待命 / 混合形态（待命 + 执行中 + 离线 + 待确认）/ 配置分叉 / 已结束。
    { name: `run-independent-live-${suffix}`, run: true, query: 'independent=live', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-mixed-${suffix}`, run: true, query: 'independent=mixed', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-spread-${suffix}`, run: true, query: 'independent=spread', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-ended-${suffix}`, run: true, query: 'independent=ended', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    // 会话池 · 协作组：两个 active 组（「验收」一人已确认离线 → attention 徽标与行内交接 / 移出）
    // + 一个刚解散的组（历史折叠）+ 独立会话；网格不许横向溢出（§7 探针）。
    {
      name: `run-independent-groups-${suffix}`, run: true, query: 'independent=groups', colorScheme: colorMode, storage: baseStorage({ colorMode }),
      actions: [{ label: '组卡片网格不溢出', probe: GROUPS_GRID_PROBE }]
    },
    // 建组抽屉（运行页入口；名册多选走同一个抽屉、预勾通道）：模态背板全覆盖、抽屉在视口内（§7 探针，口径见常量注释）。
    {
      name: `run-independent-groups-drawer-${suffix}`, run: true, query: 'independent=groups', colorScheme: colorMode, storage: baseStorage({ colorMode }),
      actions: [{ click: '.pool-groups .run-section-head .run-link' }, { wait: 300 }, { label: '抽屉与背板几何', probe: COMPOSER_PROBE }]
    },
    // 会话配置（批次属性）：配置中点「修改」打开的统一弹层 / 换成 Claude Fable 5 并应用后的行内光晕（约 300ms 处）/
    // 单席弹层页脚勾上「同时应用到其余席位」/ 单席改动后的「单独配置」标；开始页即配置态，不再有模式切换步骤。
    { name: `run-batch-config-dialog-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }), clip: null, actions: [{ click: '.run-batch-config__action' }, { wait: 350 }] },
    {
      name: `run-batch-config-applied-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }),
      actions: [
        { click: '.run-batch-config__action' }, { wait: 300 },
        { click: '.cursor-model-dialog .menu-select__button' }, { wait: 200 },
        { eval: `[...document.querySelectorAll('.menu-select__menu [role="option"] button')].find((button) => button.textContent.includes('Claude Fable 5'))?.click()` }, { wait: 200 },
        { eval: `[...document.querySelectorAll('.cursor-model-dialog footer button')].find((button) => button.textContent.startsWith('应用到'))?.click()` }, { wait: 300 }
      ]
    },
    {
      name: `run-seat-dialog-sync-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }), clip: null,
      actions: [
        { click: 'button[aria-label="配置 CH-2 会话"]' }, { wait: 300 },
        { click: '.cursor-model-dialog footer .toggle-switch' }, { wait: 250 }
      ]
    },
    {
      name: `run-seat-override-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }),
      actions: [
        { click: 'button[aria-label="配置 CH-2 会话"]' }, { wait: 300 },
        { click: 'button[aria-label="CH-2 弹层Fast Off"]' }, { wait: 150 },
        { eval: `[...document.querySelectorAll('.cursor-model-dialog footer button')].find((button) => button.textContent === '保存')?.click()` }, { wait: 500 }
      ]
    }
  ]),
  // 破坏性动作的确认面：结束批次（danger）/ 解散组（danger，文案含任务与消息后果）/ 移出成员（neutral：可再加回来）。
  { name: 'run-end-sheet-dark', run: true, query: 'independent=live', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), actions: [{ click: '.run-header__ghost.is-danger' }, { wait: 300 }] },
  {
    name: 'run-group-dissolve-sheet', run: true, query: 'independent=groups', colorScheme: 'light', storage: baseStorage(),
    actions: [
      { click: '.pool-groups__grid .group-card .account-actions-menu__trigger' }, { wait: 200 },
      { eval: `[...document.querySelectorAll('.account-actions-menu button')].find((button) => button.textContent.includes('解散本组'))?.click()` }, { wait: 300 }
    ]
  },
  {
    name: 'run-group-remove-sheet', run: true, query: 'independent=groups', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }),
    actions: [{ eval: `[...document.querySelectorAll('.group-card-member__actions .run-link')].find((button) => button.textContent === '移出' && !button.disabled)?.click()` }, { wait: 300 }]
  },
  // 组目标编辑器（⋯ → 写目标；Ctrl+Enter 保存、Esc 放弃）——「验收」组目标为空，菜单项是「写目标」。
  {
    name: 'run-group-goal-editing', run: true, query: 'independent=groups', colorScheme: 'light', storage: baseStorage(),
    actions: [
      { eval: `[...document.querySelectorAll('.group-card')].find((card) => card.getAttribute('aria-label').includes('验收'))?.querySelector('.account-actions-menu__trigger')?.click()` }, { wait: 200 },
      { eval: `[...document.querySelectorAll('.account-actions-menu button')].find((button) => button.textContent.includes('写目标'))?.click()` }, { wait: 250 }
    ]
  },
  // 离线成员的组身份迁移弹窗（交接给独立席位，可附带上下文）——「验收」组 CH-4 已确认离线。
  {
    name: 'run-transfer-dialog', run: true, query: 'independent=groups', colorScheme: 'light', storage: baseStorage(),
    actions: [{ eval: `[...document.querySelectorAll('.group-card-member__actions .run-link')].find((button) => button.textContent.includes('交接'))?.click()` }, { wait: 400 }]
  },
  // 运行中新建批次：先确认（当前批次会结束），确认后进入配置态横幅。
  {
    name: 'run-new-batch-compose', run: true, query: 'independent=live', colorScheme: 'light', storage: baseStorage(),
    actions: [
      { eval: `[...document.querySelectorAll('.run-panel__actions button')].find((button) => button.textContent.includes('新建批次'))?.click()` }, { wait: 300 },
      { click: '.run-sheet__confirm' }, { wait: 400 }
    ]
  },
  // 宽度阶梯：容器查询断点 1120 / 920 / 680 两侧各取一档；席位行的重排与组卡片网格（§7 探针）在每一档都成立。
  ...[1180, 1000, 860, 720, 600].flatMap((width) => [
    {
      name: `run-independent-groups-w${width}`, run: true, width, height: 900, query: 'independent=groups',
      colorScheme: 'light', storage: baseStorage(), clip: null,
      actions: [{ label: `组卡片网格不溢出（${width}px）`, probe: GROUPS_GRID_PROBE }]
    },
    { name: `run-independent-mixed-w${width}`, run: true, width, height: 820, query: 'independent=mixed', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null }
  ]),
  { name: 'run-start-w600', run: true, width: 600, height: 900, query: 'setup=1', colorScheme: 'light', storage: baseStorage(), clip: null },
  // 窄窗里的「单独配置」标：席位行折成两行后，标与运行态徽标仍在同一行、不挤掉模型摘要。
  {
    name: 'run-seat-override-w600', run: true, width: 600, height: 1400, query: 'setup=1', colorScheme: 'light', storage: baseStorage(), clip: '.run-seats',
    actions: [
      { click: 'button[aria-label="配置 CH-2 会话"]' }, { wait: 300 },
      { click: 'button[aria-label="CH-2 弹层Fast Off"]' }, { wait: 150 },
      { eval: `[...document.querySelectorAll('.cursor-model-dialog footer button')].find((button) => button.textContent === '保存')?.click()` }, { wait: 500 }
    ]
  },
  // 确认面的展开是高度过渡：中途帧应看到插槽行高在插值，而不是 0 → 满高跳变（结束批次触发）。
  {
    name: 'run-sheet-opening', run: true, query: 'independent=live', colorScheme: 'light', storage: baseStorage(), clip: null,
    actions: [{
      label: 'run-slot grid-template-rows 采样（0/60/120/200/320ms）',
      probe: `new Promise((done, fail) => {
        const samples = []
        document.querySelector('.run-header__ghost.is-danger').click()
        const slot = () => document.querySelector('.run-sheet')?.closest('.run-slot')
        for (const at of [0, 60, 120, 200, 320]) setTimeout(() => {
          const element = slot()
          if (!element) return fail(new Error('确认面未挂载'))
          samples.push(at + 'ms ' + getComputedStyle(element).gridTemplateRows)
          if (at === 320) done(samples)
        }, at)
      })`
    }, { wait: 40 }]
  },
  { name: 'run-independent-groups-clear', run: true, query: 'independent=groups', colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  // 右上角设置入口：账号与 Cursor。
  ...['accounts', 'import', 'automation', 'aozai', 'maintenance', 'cleanup'].flatMap(group =>
    ['light', 'dark'].map(colorScheme => ({
      name: `settings-${group}-${colorScheme}`, hash: `account:${group}`,
      ...(group === 'aozai' ? { query: 'automation=processing' } : {}),
      width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: null,
      ...(group === 'aozai' ? { actions: [
        { click: '.processing-provider-tabs button:nth-child(2)' },
        { label: '痕心服务商切换与次数语义', probe: `(() => {
          const panel = document.querySelector('.settings-aozai')
          if (!panel.textContent.includes('剩余 5 次') || !panel.textContent.includes('每次 1 次')) throw new Error('痕心次数未呈现')
          if (!panel.textContent.includes('单网页会话') || !panel.textContent.includes('提交给痕心')) throw new Error('痕心说明或操作缺失')
          if (panel.textContent.includes('剩余 87 点')) throw new Error('切换后仍展示奥仔余额')
          return { provider:'henxin', noOverflow:panel.scrollWidth <= panel.clientWidth + 1 }
        })()` }
      ] } : {})
    }))
  ),
  // 账号列表（一账号一行）：确认态 + hover 行的特写。探针盯四件事——行不横向溢出、
  // 右缘锚定的 切换并重启 / 删除 / ⋯ 在所有行同一 x、确认态文案变短时按钮不变窄、
  // 二次确认同一时刻只有一个（Esc 收回；再点另一枚会顶掉前一个）。
  ...['light', 'dark'].map(colorScheme => ({
    name: `settings-accounts-rows-armed-${colorScheme}`, hash: 'account:accounts',
    width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: '.settings-account-list',
    actions: [
      { click: '.account-row:nth-child(3) .lobby-account__inject' },
      { label: '确认重启等宽', probe: `(() => {
        const rows = [...document.querySelectorAll('.account-row')]
        if (rows.length < 3) throw new Error('预览应有三行账号')
        const width = (row) => Math.round(rows[row].querySelector('.lobby-account__inject').getBoundingClientRect().width)
        if (!rows[2].querySelector('.lobby-account__inject').textContent.includes('确认重启')) throw new Error('第三行未进入确认重启')
        if (width(2) !== width(1)) throw new Error('确认重启比切换并重启窄')
        return { confirmWidth: width(2), restWidth: width(1) }
      })()` },
      { key: 'Escape', code: 'Escape' },
      { label: 'Esc 收回确认', probe: `(() => {
        const text = document.querySelector('.account-row:nth-child(3) .lobby-account__inject').textContent
        if (text !== '切换并重启') throw new Error('Esc 未收回确认重启: ' + text)
        return { text }
      })()` },
      { click: '.account-row:nth-child(3) .lobby-account__inject' },
      { click: '.account-row:nth-child(2) .account-remove' },
      { hover: '.account-row:nth-child(2) .account-row__identity' },
      { label: '账号行几何', probe: `(() => {
        const rows = [...document.querySelectorAll('.account-row')]
        for (const row of rows) if (row.scrollWidth > row.clientWidth + 1) throw new Error('账号行横向溢出')
        const lefts = (selector) => rows.map(row => Math.round(row.querySelector(selector).getBoundingClientRect().left))
        for (const selector of ['.lobby-account__inject', '.account-remove', '.account-actions-menu__trigger']) {
          if (new Set(lefts(selector)).size !== 1) throw new Error(selector + ' 未在各行对齐: ' + lefts(selector).join(','))
        }
        const width = (row, selector) => Math.round(rows[row].querySelector(selector).getBoundingClientRect().width)
        if (width(1, '.account-remove') !== width(0, '.account-remove')) throw new Error('确认比删除窄')
        if (rows[1].querySelector('.account-remove').textContent !== '确认') throw new Error('第二行未进入确认删除')
        if (rows[2].querySelector('.lobby-account__inject').textContent !== '切换并重启') throw new Error('点删除后第三行的确认重启应被顶掉')
        if (document.querySelectorAll('.account-row__actions .is-confirming').length !== 1) throw new Error('同一时刻应只有一枚待确认按钮')
        const hint = rows[1].querySelector('.account-row__select-hint')
        if (Number(getComputedStyle(hint).opacity) < .9) throw new Error('hover 行的「设为当前」未浮现')
        const emails = rows.map(row => row.querySelector('.account-row__identity strong')).map(e => e.scrollWidth <= e.clientWidth + 1)
        return { rows: rows.length, heights: rows.map(row => Math.round(row.getBoundingClientRect().height)), emailsIntact: emails }
      })()` }
    ]
  })),
  // 账号列表的中档容器（会话栏拉宽后内容区 ≈ 611px）：操作上移到邮箱同一行、元信息独占次行——
  // 探针盯：行仍是两行文本的高度、chip 不折行、操作与邮箱同一水平线、无横向溢出。
  {
    name: 'settings-accounts-rows-mid-light', hash: 'account:accounts',
    width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), clip: '.settings-account-list',
    actions: [
      { eval: `document.querySelector('.settings-account-list').style.width = '611px'` },
      { wait: 120 },
      { label: '中档账号行几何', probe: `(() => {
        const rows = [...document.querySelectorAll('.account-row')]
        if (rows.length < 3) throw new Error('预览应有三行账号')
        for (const row of rows) {
          if (row.scrollWidth > row.clientWidth + 1) throw new Error('账号行横向溢出')
          const height = row.getBoundingClientRect().height
          if (height > 84) throw new Error('中档下账号行不应超过两行文本高度: ' + Math.round(height))
          const meta = row.querySelector('.account-row__meta').getBoundingClientRect()
          if (meta.height > 26) throw new Error('中档下元信息 chip 不应折行: ' + Math.round(meta.height))
          const identity = row.querySelector('.account-row__identity').getBoundingClientRect()
          const actions = row.querySelector('.account-row__actions').getBoundingClientRect()
          const identityMid = identity.top + identity.height / 2
          const actionsMid = actions.top + actions.height / 2
          if (Math.abs(identityMid - actionsMid) > 4) throw new Error('中档下操作应与邮箱同一水平线')
          if (meta.top < actions.bottom - 1) throw new Error('中档下元信息应在操作行之下')
        }
        return { heights: rows.map(row => Math.round(row.getBoundingClientRect().height)) }
      })()` }
    ]
  },
  // 自动化运行卡：每个相位一张整页 + 一张卡片特写（空闲态已在 settings-automation-* 覆盖）。
  ...['countdown', 'processing', 'hardening-countdown', 'importing', 'deleting', 'cleaning', 'done', 'failed', 'cancelled'].flatMap(phase =>
    ['light', 'dark'].map(colorScheme => ({
      name: `settings-automation-run-${phase}-${colorScheme}`, hash: 'account:automation', query: `automation=${phase}`,
      width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: '.automation-run'
    }))
  ),
  ...['light', 'dark'].flatMap(colorMode => [1180, 1440, 380].map(width => ({
    name: `settings-roxy-key-${width}-${colorMode}`, hash: 'account:import',
    width: Math.max(1180, width), height: 900, colorScheme: colorMode,
    storage: baseStorage({ colorMode }), clip: '.account-browser__connection-row',
    actions: [
      ...(width === 380 ? [{ eval: `document.querySelector('.account-browser').style.width = '380px'` }] : []),
      ...[false, true].flatMap(editing => [
        ...(editing ? [{ click: '.account-browser__key-saved button' }] : []),
        { label: editing ? '编辑 Key 排版' : '已保存 Key 排版', probe: `(() => {
          const cell = document.querySelector('.account-browser__key-cell')
          const label = cell.firstElementChild.getBoundingClientRect()
          const controls = cell.querySelector('.account-browser__key-input')
          const box = controls.getBoundingClientRect()
          if (label.width < 64) throw new Error('Key 说明列被控件挤塌')
          if (label.right > box.left + 1 && label.left < box.right - 1 && label.bottom > box.top + 1 && label.top < box.bottom - 1) throw new Error('Key 说明与控件重叠')
          for (const parent of [cell, controls, cell.parentElement]) {
            if (parent.scrollWidth > parent.clientWidth + 1) throw new Error(parent.className + ' 横向溢出')
          }
          const input = controls.querySelector('input')
          if (input && input.getBoundingClientRect().width < 100) throw new Error('Key 输入区过窄')
          const port = cell.querySelector('.account-browser__port').getBoundingClientRect()
          const sameRow = port.top < box.bottom - 1 && port.bottom > box.top + 1
          if ((sameRow && port.left < box.right + 4) || port.right > cell.getBoundingClientRect().right + 1) throw new Error('端口控件与 Key 控件重叠或溢出')
          if (cell.querySelector('.account-browser__port input').value !== '50000') throw new Error('默认端口未呈现')
          const select = document.querySelector('.account-browser__window-cell .menu-select__button').getBoundingClientRect()
          const refresh = document.querySelector('.account-browser__refresh').getBoundingClientRect()
          if (Math.abs(select.top + select.height / 2 - refresh.top - refresh.height / 2) > 1) throw new Error('刷新按钮未与下拉框垂直居中对齐')
          if (refresh.left < select.right || refresh.right > cell.parentElement.getBoundingClientRect().right) throw new Error('刷新按钮与下拉框重叠或溢出')
          return { cellWidth: cell.clientWidth, controlsWidth: controls.clientWidth, inputWidth: input?.clientWidth }
        })()` }
      ])
    ]
  }))),
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
  // 背景预设：外观弹层的缩略卡行（极光选中），以及三套非默认背景在会话页上的整页效果（浅 / 深）。
  ...['light', 'dark'].map(colorMode => ({
    name: `appearance-background-popover-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode,
    storage: baseStorage({ colorMode, background: 'aurora' }), clip: '.appearance-popover',
    actions: [{ wait: 250 }, { click: '.appearance-button' }, { wait: 250 }]
  })),
  ...['aurora', 'mesh', 'prism'].flatMap(background => ['light', 'dark'].map(colorMode => ({
    name: `background-${background}-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode,
    storage: baseStorage({ colorMode, background }), clip: null
  }))),
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
  // 软件更新（手动组件）：状态卡的每个相位（?update=…）× 深浅色；已就绪时点「安装并重启」出现门禁确认块；
  // 有新版时会话页右下角的小提醒框与齿轮角标（geometry probe：不遮挡输入框、齿轮上有角标）。
  ...['idle', 'up_to_date', 'available', 'downloading', 'downloaded', 'failed', 'offline', 'unsupported'].flatMap(phase =>
    ['light', 'dark'].map(colorScheme => ({
      name: `settings-update-${phase.replaceAll('_', '-')}-${colorScheme}`, hash: 'account:update', query: `update=${phase}`,
      width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: null,
      // 一行设置的几何：没有圆点、没有内卡 / 英雄行 / 大号数字；行直接住在区块正文里，标签字号与维护页的行一致；
      // 操作在文案右侧且不与文案重叠、不出正文、按钮不折行；胶囊（如有）在区块头里、单行。
      actions: [{ wait: 200 }, { label: '版本状态行', probe: `(() => {
        if (document.querySelector('.app-update__dot, .app-update__card, .app-update__hero, .app-update__number, .app-update__eyebrow')) throw new Error('版本状态不该再有圆点 / 内卡 / 英雄行 / 大号数字')
        const row = document.querySelector('.app-update__row')
        if (!row || !row.classList.contains('settings-row')) throw new Error('版本状态不是 settings-row')
        const body = row.closest('.settings-section__body').getBoundingClientRect()
        const copy = row.querySelector('.settings-row__copy').getBoundingClientRect()
        const title = row.querySelector('.app-update__title')
        if (!title || !title.textContent.trim()) throw new Error('状态行缺标签')
        const titleSize = parseFloat(getComputedStyle(title).fontSize)
        if (titleSize > 14) throw new Error('标签字号过大（又成英雄行了）：' + titleSize)
        const actions = row.querySelector('.app-update__actions')
        if (actions) {
          const box = actions.getBoundingClientRect()
          if (box.left < copy.right - 1) throw new Error('操作与文案横向重叠')
          if (box.right > body.right + 1 || box.left < body.left - 1) throw new Error('操作出了区块正文')
          for (const button of actions.querySelectorAll('button')) {
            if (button.getBoundingClientRect().height > 34) throw new Error('操作按钮换行了：' + button.textContent)
          }
        }
        for (const divided of document.querySelectorAll('.app-update .settings-row--divided')) {
          const box = divided.getBoundingClientRect()
          if (box.left < body.left - 1 || box.right > body.right + 1) throw new Error('分隔行溢出区块正文')
        }
        const badge = document.querySelector('.app-update__badge')
        if (badge) {
          const head = badge.closest('.settings-section__head').getBoundingClientRect()
          const box = badge.getBoundingClientRect()
          if (box.top < head.top || box.bottom > head.bottom) throw new Error('胶囊出了区块头')
          if (box.height > 22) throw new Error('胶囊折行了：' + badge.textContent)
        }
        return { title: title.textContent, badge: badge ? badge.textContent : null, actions: actions ? actions.querySelectorAll('button').length : 0, rows: document.querySelectorAll('.app-update .settings-row').length }
      })()` }]
    }))
  ),
  {
    name: 'settings-update-confirm-light', hash: 'account:update', query: 'update=downloaded', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: '.app-update',
    actions: [{ wait: 200 }, { click: '.app-update__button.is-primary' }, { wait: 200 }, { label: '门禁确认块', probe: `(() => {
      const confirm = document.querySelector('.app-update__confirm')
      if (!confirm) throw new Error('未出现门禁确认块')
      if (!confirm.textContent.includes('席位在线')) throw new Error('确认文案缺少在线席位后果')
      if (document.querySelectorAll('.app-update__row .app-update__actions').length) throw new Error('确认块出现时普通操作按钮应收起')
      if (document.querySelector('.app-update__dot, .app-update__hero, .app-update__number')) throw new Error('版本状态不该再有圆点 / 英雄行')
      const title = document.querySelector('.app-update__title')?.textContent
      if (title !== '新版本 0.3.3') throw new Error('确认时标签应仍是新版本：' + title)
      const row = document.querySelector('.app-update__row').getBoundingClientRect()
      if (confirm.getBoundingClientRect().top < row.bottom - 1) throw new Error('确认块应在状态行之下')
      // 打开它的按钮已经卸载：真浏览器里焦点必须落在确认块的主按钮上，否则会掉回 body。
      const primary = confirm.querySelector('.app-update__button.is-primary')
      if (document.activeElement !== primary) throw new Error('确认块打开后焦点应在主按钮上，实际在：' + document.activeElement.tagName)
      if (confirm.classList.contains('is-danger') || primary.classList.contains('is-danger')) throw new Error('装个新版不是破坏性操作，不该用危险色')
      return { text: confirm.textContent.slice(0, 60), title, focused: primary.textContent }
    })()` }]
  },
  // 自定义更新源展开：提示、镜像预设胶囊、输入 + 保存一行；点预设只填入输入框（保存按钮亮起、胶囊不亮）。
  ...['light', 'dark'].map(colorScheme => ({
    name: `settings-update-advanced-${colorScheme}`, hash: 'account:update', query: 'update=idle', width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: '.app-update__settings',
    actions: [{ wait: 200 }, { click: '.app-update__advanced > summary' }, { wait: 200 }, { click: '.app-update__preset' }, { wait: 100 }, { label: '自定义源排版', probe: `(() => {
      const details = document.querySelector('.app-update__advanced')
      if (!details?.open) throw new Error('点 summary 后未展开')
      const body = details.closest('.settings-section__body').getBoundingClientRect()
      const feed = document.querySelector('.app-update__feed').getBoundingClientRect()
      const input = document.querySelector('.app-update__feed-input')
      const save = [...document.querySelectorAll('.app-update__feed button')].find((node) => node.textContent === '保存')
      if (feed.right > body.right + 1 || feed.left < body.left - 1) throw new Error('输入行溢出区块正文')
      if (Math.abs(input.getBoundingClientRect().height - save.getBoundingClientRect().height) > 1) throw new Error('输入框与保存按钮不等高')
      if (!input.value.startsWith('https://gh-proxy.com/')) throw new Error('点预设后输入框未填入镜像地址')
      if (save.disabled) throw new Error('填入预设后保存按钮应可点')
      if (document.querySelector('.app-update__preset').classList.contains('is-active')) throw new Error('未保存时胶囊不该点亮')
      const chip = document.querySelector('.app-update__preset').getBoundingClientRect()
      const line = document.querySelector('.app-update__feed-presets').getBoundingClientRect()
      if (chip.top < line.top - 1 || chip.bottom > line.bottom + 1) throw new Error('预设胶囊撑破了所在行')
      return { inputWidth: Math.round(input.getBoundingClientRect().width), chipHeight: Math.round(chip.height) }
    })()` }]
  })),
  // mac 分支：辅助脚本结果横幅（applied 绿 / apply_failed 红 alert）与回滚脚注 → 确认块（含数据回退警告）。
  { name: 'settings-update-applied-light', hash: 'account:update', query: 'update=idle&updated=applied', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: '.app-update' },
  { name: 'settings-update-apply-failed-dark', hash: 'account:update', query: 'update=idle&updated=apply_failed', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: '.app-update' },
  {
    name: 'settings-update-rollback-confirm-light', hash: 'account:update', query: 'update=idle&rollback=1', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ colorMode: 'light' }), clip: '.app-update',
    actions: [{ wait: 200 }, { label: '备份行', probe: `(() => {
      const row = document.querySelector('.app-update__rollback')
      if (!row || !row.classList.contains('settings-row--divided')) throw new Error('备份应是 hairline 之下独立的一行设置')
      const copy = row.querySelector('.settings-row__copy').getBoundingClientRect()
      const button = row.querySelector('button').getBoundingClientRect()
      if (button.left < copy.right - 1) throw new Error('回滚按钮与说明横向重叠')
      const status = document.querySelector('.app-update__row').getBoundingClientRect()
      if (row.getBoundingClientRect().top < status.bottom - 1) throw new Error('备份行应在状态行之下')
      return { text: row.textContent.slice(0, 40) }
    })()` }, { click: '.app-update__rollback button' }, { wait: 200 }, { label: '回滚确认块', probe: `(() => {
      const confirm = document.querySelector('.app-update__confirm')
      if (!confirm) throw new Error('点击回滚后未出现确认块')
      if (!confirm.textContent.includes('回滚会退出拾光')) throw new Error('确认块缺少数据回退警告')
      if (document.querySelector('.app-update__rollback')) throw new Error('确认块出现时备份行应收起')
      // 回滚会用旧库快照覆盖当前库：确认块与主按钮都必须是危险色，跟「安装新版」那块一眼分得开。
      const primary = confirm.querySelector('.app-update__button.is-primary')
      if (!confirm.classList.contains('is-danger')) throw new Error('回滚确认块应走危险色')
      if (!primary.classList.contains('is-danger')) throw new Error('回滚的主按钮应走危险色')
      if (document.activeElement !== primary) throw new Error('确认块打开后焦点应在主按钮上，实际在：' + document.activeElement.tagName)
      return { text: confirm.textContent.slice(0, 60), background: getComputedStyle(confirm).backgroundColor, focused: primary.textContent }
    })()` }]
  },
  ...['light', 'dark'].map(colorScheme => ({
    name: `update-reminder-${colorScheme}`, query: 'update=available', width: 1440, height: 900, colorScheme, storage: baseStorage({ colorMode: colorScheme }), clip: null,
    actions: [{ wait: 300 }, { label: '小提醒框几何', probe: `(() => {
      const toast = document.querySelector('.update-reminder')
      if (!toast) throw new Error('有新版时未出现小提醒框')
      const box = toast.getBoundingClientRect()
      if (box.width > 440) throw new Error('小提醒框过宽：' + box.width)
      if (box.right > window.innerWidth || box.bottom > window.innerHeight) throw new Error('小提醒框溢出视口')
      const composer = document.querySelector('.composer textarea, .composer-workbench textarea, textarea')
      if (composer) {
        const c = composer.getBoundingClientRect()
        if (box.left < c.right && box.right > c.left && box.top < c.bottom && box.bottom > c.top) throw new Error('小提醒框遮住了输入框')
      }
      if (!document.querySelector('.account-button__dot')) throw new Error('齿轮上没有新版角标')
      if (document.activeElement === toast || toast.contains(document.activeElement)) throw new Error('小提醒框不应抢焦点')
      return { width: Math.round(box.width), height: Math.round(box.height) }
    })()` }]
  })),
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
  {
    name: 'sessions-rail-picks-narrow', rail: true, width: 1440, height: 900, query: 'sessions=many',
    colorScheme: 'dark', storage: railStorage({ colorMode: 'dark', railWidth: 300 }),
    actions: [
      { label: '300px 名册静止时头像无遮挡', probe: `(() => {
        const picks = [...document.querySelectorAll('.session-row__pick')]
        const visible = () => picks.filter(el => Number(getComputedStyle(el).opacity) > .9)
        if (!picks.length || visible().length) throw new Error('静止态复选框覆盖头像')
        return { rows: picks.length, visible: 0 }
      })()` },
      { eval: `document.querySelector('.session-row__pick input').click()` }, { wait: 160 },
      { label: '多选只覆盖已选行，其他头像保留', probe: `(() => {
        const picked = document.querySelectorAll('.session-list__slot.is-picked').length
        const visible = [...document.querySelectorAll('.session-row__pick')].filter(el => Number(getComputedStyle(el).opacity) > .9).length
        if (picked !== 1 || visible !== 1) throw new Error('多选覆盖了未选中的头像')
        return { picked, visible }
      })()` }
    ]
  },
  { name: 'sessions-rail-hover-row', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ hover: '.session-group[data-section="team-group:many:review"] .session-list__slot:first-child .session-row' }] },
  { name: 'sessions-rail-keyboard', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ eval: `document.querySelector('.session-row.is-selected').focus()` }, { key: 'ArrowDown', code: 'ArrowDown' }, { key: 'ArrowDown', code: 'ArrowDown' }] },
  { name: 'sessions-rail-collapsed', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ click: '.session-group[data-section="team-group:many:review"] .session-group__header' }, { wait: 300 }] },
  {
    name: 'sessions-rail-collapsing', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), clip: null,
    actions: [{
      label: '分组折叠：列表 grid-template-rows 采样，组条几何恒定、被点组条原地不动（0/60/120/200/320ms）',
      probe: `new Promise((done, fail) => {
        const samples = []
        const list = document.querySelector('.session-list')
        const header = document.querySelector('.session-group[data-section="team-group:many:review"] .session-group__header')
        const slot = () => document.querySelector('.session-group[data-section="team-group:many:review"] .inspector-collapsible')
        const headerTop = () => header.getBoundingClientRect().top - list.getBoundingClientRect().top
        const top0 = headerTop()
        header.click()
        for (const at of [0, 60, 120, 200, 320]) setTimeout(() => {
          const rect = header.getBoundingClientRect()
          samples.push(at + 'ms rows=' + getComputedStyle(slot()).gridTemplateRows + ' header=' + rect.height.toFixed(1) + 'px top=' + headerTop().toFixed(1))
          if (Math.abs(rect.height - 32) > 0.5) return fail(new Error('组条高度在折叠中变化: ' + rect.height))
          if (Math.abs(headerTop() - top0) > 0.5) return fail(new Error('未滚动时被点的组条不该移动: ' + headerTop() + ' vs ' + top0))
          if (at === 320) {
            if (getComputedStyle(slot()).gridTemplateRows !== '0px') return fail(new Error('折叠未收口: ' + getComputedStyle(slot()).gridTemplateRows))
            if (!slot().querySelector('.session-row')) return fail(new Error('折叠后行被卸载（应 keepMounted）'))
            done(samples)
          }
        }, at)
      })`
    }, { wait: 40 }]
  },
  {
    // 滚动后折叠被钉住的组：scrollTop 与列表收缩同步缓动到终态，组条不飞走、不跳格。
    name: 'sessions-rail-collapse-anchored', rail: true, width: 1180, height: 620, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), clip: null,
    actions: [{
      label: '钉住的组条折叠：滚动锚定采样（0/60/120/200/320ms）',
      probe: `new Promise((done, fail) => {
        const list = document.querySelector('.session-list')
        const section = document.querySelector('.session-group[data-section="team-group:many:review"]')
        const header = section.querySelector('.session-group__header')
        const body = section.querySelector('.inspector-collapsible')
        list.scrollTop = section.offsetTop + 60
        requestAnimationFrame(() => {
          const start = list.scrollTop
          if (start <= section.offsetTop) return fail(new Error('场景前提不成立：组条未被钉住 ' + start + ' ≤ ' + section.offsetTop))
          const nextMax = Math.max(0, list.scrollHeight - body.getBoundingClientRect().height - list.clientHeight)
          const expected = Math.max(0, Math.min(start, nextMax, section.offsetTop))
          const headerTop = () => header.getBoundingClientRect().top - list.getBoundingClientRect().top
          const samples = []
          let previousTop = headerTop()
          header.click()
          for (const at of [0, 60, 120, 200, 320]) setTimeout(() => {
            const top = headerTop()
            const rect = header.getBoundingClientRect()
            samples.push(at + 'ms scrollTop=' + list.scrollTop.toFixed(1) + ' headerTop=' + top.toFixed(1))
            if (Math.abs(rect.height - 32) > 0.5) return fail(new Error('组条高度变化: ' + rect.height))
            if (top < -0.5 || rect.bottom > list.getBoundingClientRect().bottom + 0.5) return fail(new Error('被点的组条被推出可视区: top=' + top))
            if (top < previousTop - 0.5) return fail(new Error('组条反向移动（先下后上 / 先上后下）: ' + previousTop + ' → ' + top))
            if (top - previousTop > 15) return fail(new Error('组条单帧跳格 ' + (top - previousTop).toFixed(1) + 'px'))
            previousTop = top
            if (at === 320) {
              if (Math.abs(list.scrollTop - expected) > 1) return fail(new Error('终态 scrollTop ' + list.scrollTop + ' ≠ 预期 ' + expected))
              done(samples)
            }
          }, at)
        })
      })`
    }, { wait: 40 }]
  },
  { name: 'sessions-rail-scrolled', rail: true, width: 1180, height: 620, query: 'sessions=many', colorScheme: 'light', storage: railStorage(), actions: [{ eval: `document.querySelector('.session-list').scrollTop = 150` }, { wait: 120 }] },
  { name: 'sessions-rail-empty', rail: true, query: 'sessions=none', colorScheme: 'light', storage: railStorage() },
  { name: 'sessions-rail-reduced-motion', rail: true, query: 'sessions=many', colorScheme: 'light', reducedMotion: true, storage: railStorage() },
  // 名册多选（阶段 3）：勾选两行独立会话 → 底部浮动条（建组 / 加入… / 取消）；
  // 浮动条是 session-pane 网格第三行，名册收缩让位——滚到底后最后一行完整可见（§7 探针）。
  ...['light', 'dark'].map((colorMode) => ({
    name: `sessions-rail-multiselect-${colorMode}`, rail: true, width: 1180, height: 720, query: 'sessions=many',
    colorScheme: colorMode, storage: railStorage({ colorMode }),
    actions: [
      { eval: pickRailRow('3') }, { eval: pickRailRow('9') }, { wait: 250 },
      { label: '浮动条不遮挡最后一行', probe: RAIL_BAR_PROBE }
    ]
  })),
  // 混合选择（组内 + 独立）：只提供移出组，提示一行说明独立会话不受影响。
  {
    name: 'sessions-rail-multiselect-mixed', rail: true, query: 'sessions=many', colorScheme: 'light', storage: railStorage(),
    actions: [{ eval: pickRailRow('4') }, { eval: pickRailRow('3') }, { wait: 250 }]
  },
  // 名册里的移出确认面：与组卡片同一段文案，在浮动条位置展开。
  {
    name: 'sessions-rail-remove-sheet', rail: true, query: 'sessions=many', colorScheme: 'dark', storage: railStorage({ colorMode: 'dark' }),
    actions: [
      { eval: pickRailRow('4') }, { wait: 200 },
      { eval: `[...document.querySelectorAll('.session-pane__bar button')].find((button) => button.textContent.includes('移出组'))?.click()` }, { wait: 250 },
      { label: '确认面在名册面板内', probe: `(() => {
        const sheet = document.querySelector('.session-pane__bar .run-sheet')
        if (!sheet) throw new Error('确认面未出现')
        const pane = document.querySelector('.session-pane').getBoundingClientRect()
        const rect = sheet.getBoundingClientRect()
        if (rect.left < pane.left - 0.5 || rect.right > pane.right + 0.5 || rect.bottom > pane.bottom + 0.5) throw new Error('确认面超出名册面板')
        return { title: sheet.querySelector('strong').textContent, width: Math.round(rect.width) }
      })()` }
    ]
  },

  // ---------- 会话页过程卡：工具头部（意图说明 / 动词 / 提示）与 ask_question 可点选卡片 ----------
  // 含待答问卷的过程回合：Shell 的意图说明为主标题 + 程序名提示、读取行范围、编辑增删行数。
  // 预览夹具同时带流式回复，时间线会把该行归为已关联过程；按问卷后代定位比 live-process-row 更稳定。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-tool.is-question)',
    actions: [{ eval: `document.querySelector('.chat-row--process:has(.cursor-native-tool.is-question)').scrollIntoView({ block: 'start' })` }, { wait: 200 }]
  })),
  {
    name: 'session-turn-working-light', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=1',
    storage: railStorage(), clip: '.chat-row--turn:has(.cursor-native-process__summary:disabled)',
    actions: [{ label: '运行中过程直接展开、对话头像槽已移除', probe: `(() => {
      const row = document.querySelector('.chat-row--turn:has(.cursor-native-process__summary:disabled)')
      const summary = row?.querySelector('.cursor-native-process__summary')
      if (!summary?.textContent.startsWith('Working for ') || row.querySelector('.cursor-native-process__flow')?.hidden) throw new Error('运行中过程没有展开')
      if (document.querySelector('.chat-gutter')) throw new Error('对话仍留有头像槽')
      return { heading: summary.textContent, steps: row.querySelectorAll('[data-step-id]').length }
    })()` }]
  },
  {
    name: 'session-turn-worked-dark', width: 1440, height: 900, colorScheme: 'dark',
    storage: railStorage({ colorMode: 'dark' }), clip: '.chat-row--turn:has(.cursor-native-process__summary[aria-expanded="false"])',
    actions: [
      { eval: `(() => {
        const viewport = document.querySelector('.workspace-timeline')
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
        document.querySelector('.chat-row--turn:has(.cursor-native-process__summary[aria-expanded="false"])').scrollIntoView({ block: 'center' })
      })()` },
      { wait: 180 },
      { label: '完成后过程折叠、结果仍显示', probe: `(() => {
        const row = document.querySelector('.chat-row--turn:has(.cursor-native-process__summary[aria-expanded="false"])')
        const summary = row?.querySelector('.cursor-native-process__summary')
        const viewport = document.querySelector('.workspace-timeline').getBoundingClientRect()
        const box = row?.getBoundingClientRect()
        if (!box || box.bottom <= viewport.top || box.top >= viewport.bottom) throw new Error('完成回合未进入可视区，截图会假绿')
        if (!summary?.textContent.startsWith('Worked') || !row.querySelector('.cursor-native-process__flow')?.hidden) throw new Error('已完成过程没有收束')
        if (!row.querySelector('.message-content')?.textContent.trim()) throw new Error('最终回复不可见')
        return { heading: summary.textContent, reply: row.querySelector('.message-content')?.textContent.slice(0, 30) }
      })()` }
    ]
  },
  {
    name: 'session-continuation-archived-dark', width: 1440, height: 900, colorScheme: 'dark', query: 'continuation=archived',
    storage: railStorage({ colorMode: 'dark' }), clip: '.chat-row--continuation',
    actions: [{ wait: 1_500 }, { label: '重启回放的历史续作已收束且时长冻结', probe: `(() => {
      const row = document.querySelector('.chat-row--continuation')
      const heading = row?.querySelector('.cursor-native-process__summary')
      if (!heading || heading.textContent !== 'Worked for 1m 0s') throw new Error('历史续作仍在计时: ' + heading?.textContent)
      if (!row.querySelector('.cursor-native-process__flow')?.hidden || row.classList.contains('live-process-row')) throw new Error('历史续作仍呈现为直播态')
      return { heading: heading.textContent, folded: true }
    })()` }]
  },
  // 步骤分组（Cursor detailed 同款）：折叠的「Explored 3 files, 1 search」/「Ran 2 browser actions」组头、
  // 独立 shell 卡、展开后的组内轻行；深浅色各一张，另有一张展开首组。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-groups-${colorMode}`, width: 1440, height: 1200, colorScheme: colorMode,
    storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-group)',
    actions: [{ eval: `document.querySelector('.chat-row--process:has(.cursor-native-group)').scrollIntoView({ block: 'start' })` }, { wait: 200 }]
  })),
  // 图片生成卡（?image=1）：已完成的一张缩略图内联在头部之下（限高、与标签列对齐），
  // 进行中的一张只有「生成图片中」头部；两张卡裁在一起，深浅色各一张。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-process-image-${colorMode}`, width: 1100, height: 900, colorScheme: colorMode, query: 'image=1',
    storage: railStorage({ colorMode }), clip: '.chat-row--process:has(.cursor-native-tool.is-image)',
    actions: [
      { eval: `document.querySelector('.cursor-native-tool.is-image').scrollIntoView({ block: 'center' })` },
      { wait: 200 },
      {
        label: '图片卡几何约束',
        probe: `(() => {
          const done = document.querySelector('.cursor-native-tool.is-image.is-done')
          const running = document.querySelector('.cursor-native-tool.is-image.is-running')
          const img = done && done.querySelector('.cursor-native-image img')
          const label = done && done.querySelector('.cursor-native-tool__label')
          if (!done || !running || !img || !label) return 'missing image cards: done=' + !!done + ' running=' + !!running + ' img=' + !!img
          if (running.querySelector('.cursor-native-image')) return 'running card must not render an image body'
          const imgBox = img.getBoundingClientRect(), labelBox = label.getBoundingClientRect()
          if (!img.complete || img.naturalWidth === 0) return 'image did not load'
          if (imgBox.height > 300) return 'image taller than the 300px cap: ' + imgBox.height
          if (Math.abs(imgBox.left - labelBox.left) > 1) return 'image not aligned with the label column: ' + imgBox.left + ' vs ' + labelBox.left
          return 'ok'
        })()`
      }
    ]
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
          if (!reply || !row) throw new Error('直播续作行缺失')
          const caption = row.querySelector('.chat-continuation-caption')?.textContent ?? ''
          if (!caption.endsWith('中')) throw new Error('真实续作被当作已结束：' + caption)
          if (row.getBoundingClientRect().top < reply.getBoundingClientRect().bottom - 1) throw new Error('续作行跑到回复上方')
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
          // 基础夹具的实时过程里有两条编辑 → 文件栏同在：外框在停靠区上，托盘自己缩在框内 1px 边框之内。
          const dock = tray.closest('.session-dock')
          const frame = dock && dock.querySelector(':scope > .turn-files') ? dock : tray
          const frameBox = frame.getBoundingClientRect()
          const bubbles = Array.from(document.querySelectorAll('.chat-row--mine')).map((row) => row.textContent ?? '')
          return {
            found: true,
            belowTimeline: trayBox.top >= timeline.getBoundingClientRect().bottom - 1,
            aboveComposer: trayBox.bottom <= composerBox.top + 1,
            merged: frame !== tray,
            sameWidthAsComposer: Math.abs(frameBox.left - composerBox.left) < 1 && Math.abs(frameBox.right - composerBox.right) < 1,
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
  // 本轮文件栏：Agent 改了三个文件（Git 已看到）、正在写第四个（按过程块估算），与本轮无关的未提交文件不出现。
  // 探针核对：栏在时间线之下、输入区之上、与输入区同宽；四行、合计、估算标记、转圈、审查入口；无关文件缺席。
  ...['light', 'dark'].map((colorMode) => ({
    name: `session-turn-files-${colorMode}`, width: 1440, height: 900, colorScheme: colorMode, query: 'turnfiles=1',
    storage: railStorage({ colorMode }), clip: null,
    actions: [
      { wait: 400 },
      {
        label: '文件栏结构',
        probe: `(() => {
          const bar = document.querySelector('.turn-files')
          const timeline = document.querySelector('.workspace-timeline-wrap')
          const composer = document.querySelector('.workspace-composer')
          if (!bar || !timeline || !composer) return { found: false }
          const barBox = bar.getBoundingClientRect()
          const composerBox = composer.getBoundingClientRect()
          const rows = Array.from(bar.querySelectorAll('.turn-files__item')).map((row) => ({
            path: row.getAttribute('data-path'),
            counts: row.querySelector('.turn-files__counts')?.textContent ?? '',
            estimated: row.classList.contains('is-estimated'),
            icon: row.querySelector('.file-type-icon')?.getAttribute('class') ?? ''
          }))
          // 与 Cursor 原生栏同规则：图标而不是文字徽标；数字只写非零一侧，−0 / +0 不该出现。
          if (rows.some((row) => !row.icon.includes('file-type-icon'))) throw new Error('有文件行没有类型图标')
          if (/[−+]0(?!\\d)/.test(bar.textContent ?? '')) throw new Error('出现了 −0 / +0')
          return {
            found: true,
            belowTimeline: barBox.top >= timeline.getBoundingClientRect().bottom - 1,
            aboveComposer: barBox.bottom <= composerBox.top + 1,
            sameWidthAsComposer: Math.abs(barBox.left - composerBox.left) < 1 && Math.abs(barBox.right - composerBox.right) < 1,
            headHeight: Math.round(bar.querySelector('.turn-files__head').getBoundingClientRect().height),
            count: bar.getAttribute('data-file-count'),
            title: bar.querySelector('.turn-files__title')?.textContent ?? '',
            totals: bar.querySelector('.turn-files__totals')?.textContent ?? '',
            spinner: Boolean(bar.querySelector('.turn-files__spinner')),
            review: bar.querySelector('.turn-files__review')?.textContent ?? '',
            rows,
            unrelatedAbsent: !rows.some((row) => row.path.endsWith('App.tsx')),
            noStop: !/Stop|中止/.test(bar.textContent ?? '')
          }
        })()`
      }
    ]
  })),
  // 合计与名册同源：本轮是会话迄今唯一的改动区间（?turnfiles=sole）时，合计取 Cursor 的累计净值——
  // 与左侧名册行同一个数、不再标 ≈；逐文件行保持过程估算的淡显。这就是「名册 +863 −137 vs 栏 ≈ +907 −183」
  // 倒挂的修复走查（逐笔求和把同文件反复编辑重复计入，净值不会）。
  {
    name: 'session-turn-files-reconciled', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=sole',
    storage: railStorage(), clip: null,
    actions: [
      { wait: 400 },
      {
        label: '名册行与文件栏合计同源',
        probe: `(() => {
          const totals = document.querySelector('.turn-files__totals')
          if (!totals) throw new Error('文件栏未渲染')
          const text = (totals.textContent ?? '').replace(/\\s+/g, '')
          if (text.includes('≈')) throw new Error('同源合计不该再标估算: ' + text)
          if (!text.includes('+74') || !text.includes('−388')) throw new Error('合计不是 Cursor 净值: ' + text)
          if (!totals.title.includes('名册')) throw new Error('来源说明缺失: ' + totals.title)
          const rail = document.querySelector('.session-row[data-channel-id="2"] .session-row__changes')
          if (!rail) throw new Error('名册行没有变更数字')
          const railText = (rail.textContent ?? '').replace(/\\s+/g, '')
          if (railText !== '+74−388') throw new Error('名册行与合计不同源: ' + railText)
          const estimatedRows = document.querySelectorAll('.turn-files__item.is-estimated').length
          if (!estimatedRows) throw new Error('逐文件行应保持估算标记')
          return { totals: text, rail: railText, estimatedRows }
        })()`
      }
    ]
  },
  {
    name: 'session-turn-files-collapsed', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=1', storage: railStorage(), clip: '.turn-files',
    actions: [{ wait: 300 }, { click: '.turn-files__toggle' }, { wait: 220 }, {
      label: '折叠后列表仍挂载且 inert',
      probe: `(() => {
        const bar = document.querySelector('.turn-files')
        return {
          collapsed: bar.classList.contains('is-collapsed'),
          inert: bar.querySelector('.turn-files__listwrap').hasAttribute('inert'),
          rowsMounted: bar.querySelectorAll('.turn-files__item').length,
          listHeight: Math.round(bar.querySelector('.turn-files__listwrap').getBoundingClientRect().height),
          headHeight: Math.round(bar.querySelector('.turn-files__head').getBoundingClientRect().height)
        }
      })()`
    }]
  },
  // 托盘 + 文件栏同时在场：共用一个实线外框（两段自己的外框归零、中间一条虚线分界）、托盘在上；
  // 文件栏让位——只留头部（计数 / 合计 / 审查），不转圈。中栏有 680px 下限，栏最窄 648px，目录列始终保留。
  {
    name: 'session-turn-files-with-tray-narrow', width: 980, height: 820, colorScheme: 'dark', query: 'turnfiles=1&queued=1',
    storage: railStorage({ colorMode: 'dark' }), clip: '.session-dock',
    actions: [{ wait: 400 }, {
      label: '托盘与文件栏合框',
      probe: `(() => {
        const dock = document.querySelector('.session-dock')
        const tray = document.querySelector('.queue-tray')
        const bar = document.querySelector('.turn-files')
        const composer = document.querySelector('.workspace-composer')
        if (!dock || !tray || !bar || !composer) return { found: false }
        const trayBox = tray.getBoundingClientRect()
        const barBox = bar.getBoundingClientRect()
        const dockStyle = getComputedStyle(dock)
        return {
          found: true,
          trayAboveBar: trayBox.bottom <= barBox.top + 1,
          barAboveComposer: barBox.bottom <= composer.getBoundingClientRect().top + 1,
          merged: dockStyle.borderTopStyle === 'solid' && getComputedStyle(tray).borderTopStyle === 'none' && getComputedStyle(bar).borderBottomStyle === 'none',
          divider: getComputedStyle(bar).borderTopStyle,
          sameWidthAsComposer: Math.abs(dock.getBoundingClientRect().left - composer.getBoundingClientRect().left) < 1,
          barYielding: bar.classList.contains('is-yielding') && bar.classList.contains('is-collapsed'),
          barHeight: Math.round(barBox.height),
          spinner: Boolean(bar.querySelector('.turn-files__spinner')),
          headText: bar.querySelector('.turn-files__head')?.textContent ?? '',
          barWidth: Math.round(barBox.width),
          names: Array.from(bar.querySelectorAll('.turn-files__name strong')).map((el) => el.textContent)
        }
      })()`
    }]
  },
  // 窗口下限 1440×680、托盘 3 条 + 文件栏 4 个：时间线保住下限（144px），停靠区收缩而不是时间线；
  // 文件栏让位后托盘完整可见（列表不用滚）；输入区完整在窗内。再手动展开文件栏：两段分摊剩余空间、各自滚动。
  {
    name: 'session-dock-min-height', width: 1440, height: 680, colorScheme: 'light', query: 'turnfiles=1&queued=1',
    storage: railStorage(), clip: null,
    actions: [{ wait: 400 }, {
      label: '窗口下限的纵向预算',
      probe: `(() => {
        const h = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? -1)
        const trayList = document.querySelector('.queue-tray__list')
        const composer = document.querySelector('.workspace-composer').getBoundingClientRect()
        return {
          timeline: h('.workspace-timeline-wrap'),
          floorKept: h('.workspace-timeline-wrap') >= 144,
          dock: h('.session-dock'), tray: h('.queue-tray'), bar: h('.turn-files'),
          trayListScrolls: trayList ? trayList.scrollHeight > trayList.clientHeight + 1 : null,
          barCollapsed: document.querySelector('.turn-files').classList.contains('is-collapsed'),
          composerInsideViewport: composer.bottom <= innerHeight
        }
      })()`
    }, { click: '.turn-files__toggle' }, { wait: 300 }, {
      label: '手动展开文件栏后',
      probe: `(() => {
        const h = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? -1)
        const scrolls = (sel) => { const el = document.querySelector(sel); return el ? el.scrollHeight > el.clientHeight + 1 : null }
        return {
          timeline: h('.workspace-timeline-wrap'),
          floorKept: h('.workspace-timeline-wrap') >= 144,
          tray: h('.queue-tray'), bar: h('.turn-files'),
          trayListScrolls: scrolls('.queue-tray__list'), barListScrolls: scrolls('.turn-files__list'),
          trayHeadVisible: h('.queue-tray__head') >= 36, barHeadVisible: h('.turn-files__head') >= 36,
          composerInsideViewport: document.querySelector('.workspace-composer').getBoundingClientRect().bottom <= innerHeight
        }
      })()`
    }]
  },
  // 满高草稿 + 粘贴附件：textarea 已到视口上限时附件条再插入，发送栏不得被推出窗口
  //（预算回收：网格溢出多少 textarea 让多少；附件条自身两行封顶内部滚动）。
  {
    name: 'composer-attachment-overflow', width: 1280, height: 800, colorScheme: 'light',
    storage: railStorage(), clip: '.workspace-composer',
    actions: [{ wait: 400 }, {
      eval: `(() => {
        const textarea = document.querySelector('.workspace-composer textarea')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(textarea, Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '行草稿').join('\\n'))
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    }, { wait: 200 }, {
      eval: `(() => {
        const textarea = document.querySelector('.workspace-composer textarea')
        const transfer = new DataTransfer()
        const pixel = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
        transfer.items.add(new File([pixel], 'pasted-shot-1.png', { type: 'image/png' }))
        transfer.items.add(new File([pixel], 'pasted-shot-2.png', { type: 'image/png' }))
        textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
        return true
      })()`
    }, { wait: 500 }, {
      label: '附件条插入后发送栏仍完整可见',
      probe: `(() => {
        const controls = document.querySelector('.composer-controls').getBoundingClientRect()
        const strip = document.querySelector('.composer-attachments')
        const textarea = document.querySelector('.workspace-composer textarea')
        if (!strip) throw new Error('粘贴的附件没有进入附件条')
        if (controls.bottom > innerHeight + 0.5) throw new Error('发送栏被推出窗口：bottom ' + Math.round(controls.bottom) + ' > ' + innerHeight)
        return {
          attachments: strip.querySelectorAll('.composer-attachment').length,
          controlsBottom: Math.round(controls.bottom),
          viewport: innerHeight,
          textareaH: Math.round(textarea.getBoundingClientRect().height),
          timelineFloorKept: document.querySelector('.workspace-timeline-wrap').getBoundingClientRect().height >= 144
        }
      })()`
    }]
  },
  // 「上一轮」保持：新消息刚被取走、Agent 还在想：栏保住上一轮的四个文件并标「上一轮」、降色；
  // 审查仍走「本轮」范围——右栏的「本轮」视图与栏同一份数据，同样保住上一轮。
  {
    name: 'session-turn-files-previous', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=previous',
    storage: railStorage(), clip: '.turn-files',
    actions: [{ wait: 400 }, {
      label: '上一轮保持态',
      probe: `(() => {
        const bar = document.querySelector('.turn-files')
        if (!bar) return { found: false }
        return {
          found: true,
          scope: bar.getAttribute('data-scope'),
          previous: bar.classList.contains('is-previous'),
          label: bar.querySelector('.turn-files__scope')?.textContent ?? '',
          count: bar.getAttribute('data-file-count'),
          working: bar.classList.contains('is-working'),
          listOpacity: getComputedStyle(bar.querySelector('.turn-files__list')).opacity,
          reviewTitle: bar.querySelector('.turn-files__review')?.getAttribute('title') ?? '',
          // 时间线：上一轮回复已落库、新消息在下、新回合的思考块在其后。
          replyBeforeNewMessage: (document.body.textContent ?? '').indexOf('退役完成') < (document.body.textContent ?? '').indexOf('继续：给 handoff')
        }
      })()`
    }]
  },
  // 最窄中栏（名册 + 右栏都展开、窗口 1440 下限）：栏 648px；深路径的目录列从头截断、文件名扩展名不截断、行不横向溢出。
  {
    name: 'session-turn-files-narrow-pane', width: 1440, height: 820, colorScheme: 'dark', query: 'turnfiles=1&deep=1',
    storage: { ...baseStorage({ colorMode: 'dark', tab: 'plan' }), [SESSION_RAIL_WIDTH_KEY]: JSON.stringify([400]) }, clip: '.turn-files',
    actions: [{ wait: 400 }, {
      label: '窄栏深路径截断',
      probe: `(() => {
        const bar = document.querySelector('.turn-files')
        if (!bar) return { found: false }
        const rows = Array.from(bar.querySelectorAll('.turn-files__row'))
        const deep = rows.find((row) => (row.getAttribute('title') ?? '').includes('very-long-feature-module-name'))
        const dir = deep?.querySelector('.turn-files__name small')
        const ext = deep?.querySelector('.turn-files__name strong > b')
        // 目录只在同名文件不止一个时出场：深路径那对同名 .test.tsx 带目录，名字唯一的四行不带。
        if (!dir) throw new Error('同名文件的深路径行没有摆出目录')
        const uniqueRowsWithDir = rows.filter((row) => !(row.getAttribute('title') ?? '').includes('AccessibilityRegressionHarness') && row.querySelector('.turn-files__name small'))
        if (uniqueRowsWithDir.length) throw new Error('名字唯一的行不该显示目录')
        return {
          found: true,
          barWidth: Math.round(bar.getBoundingClientRect().width),
          deepRow: Boolean(deep),
          dirTruncated: dir.scrollWidth > dir.clientWidth + 1,
          extVisible: ext ? ext.getBoundingClientRect().right <= bar.getBoundingClientRect().right : null,
          extText: ext?.textContent ?? '',
          reactIcons: bar.querySelectorAll('.file-type-icon.is-react').length,
          noOverflow: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
          counts: Array.from(bar.querySelectorAll('.turn-files__counts')).map((el) => el.textContent)
        }
      })()`
    }]
  },
  // 浅色近景：类型图标（TS 方块 / React 原子）、同名对带目录、其余行只有名字、数字只写非零一侧。
  // 几何：图标中心与头部箭头同一条竖线；列表按整行封顶——6 个文件只完整露出 5 行，第 6 行露不出图标和文字；
  // TS 方块里的两个字母占 14px 方块 ≥ 60% 且不出方块。
  {
    name: 'session-turn-files-icons-light', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=1&deep=1',
    storage: railStorage(), clip: '.turn-files',
    actions: [{ wait: 400 }, {
      label: '类型图标、目录出场规则与几何',
      probe: `(() => {
        const bar = document.querySelector('.turn-files')
        if (!bar) return { found: false }
        const kinds = Array.from(bar.querySelectorAll('.file-type-icon')).map((icon) => icon.getAttribute('class').replace('file-type-icon is-', ''))
        const withDir = Array.from(bar.querySelectorAll('.turn-files__item')).filter((row) => row.querySelector('.turn-files__name small')).map((row) => row.getAttribute('data-path'))
        const icon = bar.querySelector('.file-type-icon').getBoundingClientRect()
        if (kinds.length !== 6) throw new Error('图标数量不对: ' + kinds.length)
        if (Math.round(icon.width) !== 16 || Math.round(icon.height) !== 16) throw new Error('图标不是 16px: ' + icon.width + 'x' + icon.height)
        if (/[−+]0(?!\\d)/.test(bar.textContent ?? '')) throw new Error('出现了 −0 / +0')
        const chevron = bar.querySelector('.turn-files__chevron').getBoundingClientRect()
        const axisDelta = (icon.left + icon.width / 2) - (chevron.left + chevron.width / 2)
        if (Math.abs(axisDelta) > 0.5) throw new Error('图标中心偏离头部箭头中心 ' + axisDelta.toFixed(2) + 'px')
        const list = bar.querySelector('.turn-files__list')
        const listBottom = list.getBoundingClientRect().bottom
        const rows = Array.from(bar.querySelectorAll('.turn-files__row'))
        if (list.scrollHeight <= list.clientHeight) throw new Error('6 个文件的列表没有滚动')
        if (rows[4].getBoundingClientRect().bottom > listBottom + 0.5) throw new Error('第 5 行没有完整露出')
        const cut = ['.file-type-icon', '.turn-files__name', '.turn-files__counts']
          .filter((selector) => rows[5].querySelector(selector).getBoundingClientRect().top < listBottom)
        if (cut.length) throw new Error('第 6 行被切了半截: ' + cut.join(', '))
        const letters = bar.querySelector('.file-type-icon.is-typescript text').getBBox()
        if (letters.width < 8.4 || letters.x < 1.5 || letters.x + letters.width > 14.5) throw new Error('TS 字母尺寸或位置不对: ' + JSON.stringify({ x: letters.x, width: letters.width }))
        return {
          found: true, kinds, withDir, counts: Array.from(bar.querySelectorAll('.turn-files__counts')).map((el) => el.textContent),
          axisDelta: Number(axisDelta.toFixed(2)), listHeight: Math.round(list.clientHeight), lettersWidth: Number(letters.width.toFixed(2))
        }
      })()`
    }]
  },
  // 点「审查」：右栏展开并切到「变更」标签、范围切到「本轮」；点某一行：该文件在右栏被展开高亮。
  {
    name: 'session-turn-files-review', width: 1440, height: 900, colorScheme: 'light', query: 'turnfiles=1',
    storage: { ...railStorage(), 'sg-team.layout:v1:workspace-inspector:open': '0', 'sg-team.inspector:active-tab': 'plan', [REVIEW_SCOPE_KEY]: 'uncommitted' },
    clip: null,
    actions: [{ wait: 400 }, { click: '[data-path="src/mcp/index.ts"] .turn-files__row' }, { wait: 500 }, {
      label: '右栏定位',
      probe: `(() => {
        const inspector = document.querySelector('.workspace-inspector-pane')
        const active = document.querySelector('.inspector-tab.is-active')
        const scope = document.querySelector('.inspector-review__scope-trigger')
        const file = document.querySelector('.review-file[data-path="src/mcp/index.ts"]')
        return {
          inspectorVisible: inspector ? !inspector.hasAttribute('inert') : false,
          activeTab: active?.textContent ?? '',
          scope: scope?.textContent ?? '',
          fileOpen: file?.classList.contains('is-open') ?? false,
          // 「本轮」正文来自编辑流：定位的文件展开后是逐次编辑卡（这批块只有 hint，卡内是占位说明）。
          editCards: file ? file.querySelectorAll('.review-edit').length : 0,
          listedFiles: Array.from(document.querySelectorAll('.review-file')).map((el) => el.getAttribute('data-path'))
        }
      })()`
    }]
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
