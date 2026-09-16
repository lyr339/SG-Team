import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const foundation = readFileSync(join(process.cwd(), 'src/renderer/src/claude-theme.css'), 'utf8')
const controls = readFileSync(join(process.cwd(), 'src/renderer/src/controls.css'), 'utf8')
const lobby = readFileSync(join(process.cwd(), 'src/renderer/src/lobby/lobby.css'), 'utf8')
const run = readFileSync(join(process.cwd(), 'src/renderer/src/run/run.css'), 'utf8')
const settings = readFileSync(join(process.cwd(), 'src/renderer/src/settings/settings.css'), 'utf8')

describe('theme surface contracts', () => {
  it('keeps floating connection UI opaque even when card opacity is zero', () => {
    expect(styles).toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--color-background-primary\)/)
    expect(styles).not.toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--surface\)/)
  })

  it('uses semantic disabled colors instead of white-on-transparent submit text', () => {
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*color:\s*var\(--color-text-disabled\)/)
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*background:\s*var\(--color-background-secondary\)/)
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*border-color:\s*var\(--color-border-primary\)/)
    expect(styles).toMatch(/\.composer-submit kbd\s*\{[^}]*border:\s*1px solid var\(--color-border-primary\)/)
    expect(styles).not.toMatch(/\.composer-submit button:disabled\s*\{[^}]*rgba\(255,\s*255,\s*255/)
  })

  it('docks the queue tray between the timeline and the composer instead of floating a popover', () => {
    // 绑定状态徽章已按需求移除（信息保留在会话卡遥测状态里）。
    expect(styles).not.toContain('.composer-binding-status')
    // 队列不再是输入区上的悬浮弹层：工作区网格为它留出独立一行，托盘是普通流内块（不绝对定位、
    // 不抢层级），虚线外框表达「还不是对话记录」，宽度与输入区一致（同 16px 侧边距）。
    expect(styles).not.toContain('.composer-queue-popover')
    expect(styles).not.toContain('.composer-queue-status')
    expect(styles).toMatch(/\.workspace-main\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto auto/)
    expect(styles).toMatch(/\.queue-tray\s*\{[^}]*border:[^;]*dashed/)
    expect(styles).toMatch(/\.queue-tray\s*\{[^}]*margin:\s*0 16px/)
    expect(styles).not.toMatch(/\.queue-tray\s*\{[^}]*position:\s*absolute/)
    expect(styles).not.toMatch(/\.queue-tray\s*\{[^}]*z-index/)
    // 时间线里的用户消息不再有「排队中」尾注样式（排队中的消息在托盘，不在时间线）。
    expect(styles).not.toContain('.chat-state.is-queued')
    // 动效尊重系统减弱设置。
    expect(styles).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.queue-tray, \.queue-tray__item\s*\{\s*animation:\s*none/)
  })

  it('uses the cool Orbit palette instead of the former yellow parchment palette', () => {
    expect(foundation).toContain('--anthropic-orange: #ff6b35')
    expect(foundation).toContain('light-dark(#edf2f7, #0b1017)')
    expect(foundation).not.toContain('#f5f4ed')
    expect(foundation).not.toContain('#faf9f5')
    expect(styles).toContain('shiguang-light.png')
    expect(styles).toContain('shiguang-dark.png')
  })

  it('never paints or hit-tests the toggle-switch checkbox (2026-09-13 ghost-box regression)', () => {
    // 治本：共享「非开关型复选框」规则的每一条都排除 ToggleSwitch 内部视觉隐藏的输入，
    // 否则它会被画成 17×17 方框，disabled 的 opacity 覆盖 opacity:0 后钉在视口显形。
    const shared = controls.match(/:where\(\.cursor-model-dialog[^)]*\) input\[type="checkbox"\]/g) ?? []
    const excluded = controls.match(/:where\(\.cursor-model-dialog[^)]*\) input\[type="checkbox"\]:not\(:where\(\.toggle-switch input\)\)/g) ?? []
    expect(shared.length).toBeGreaterThan(0)
    expect(excluded.length).toBe(shared.length)
    // 加固：视觉隐藏配方保证它画不出（clip-path）也点不到（pointer-events）。
    expect(styles).toMatch(/\.toggle-switch input\s*\{[^}]*clip-path:\s*inset\(50%\)/)
    expect(styles).toMatch(/\.toggle-switch input\s*\{[^}]*pointer-events:\s*none/)
  })

  it('keeps the settings sections readable under clear card transparency, like the session pane', () => {
    expect(settings).toMatch(/html\[data-card-transparency="clear"\] \.settings-section\s*\{[^}]*var\(--surface-solid\) 74%/)
  })

  it('keeps custom controls and run-page primary actions on the new signal-orange system', () => {
    expect(controls).toMatch(/input\[type="checkbox"\][^{]*:checked\s*\{[^}]*background-color:\s*var\(--accent\)/)
    expect(controls).toMatch(/select:not\(\[multiple\]\):focus\s*\{[^}]*var\(--accent-border-strong\)/)
    // 运行页只用共享的 .primary-button（信号橙）；破坏性确认走红色，且不是主按钮样式。
    expect(styles).toMatch(/\.primary-button\s*\{[^}]*background:\s*var\(--accent\)/)
    expect(run).toMatch(/\.run-sheet__confirm\s*\{[^}]*background:\s*var\(--red\)/)
    expect(run).toMatch(/\.run-header__ghost\.is-danger\s*\{[^}]*color:\s*var\(--red\)/)
    expect(run).not.toContain('.lobby-command__primary')
  })

  it('defines distinct model-provider identities without reusing status colors', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'moonshot', 'zhipu', 'cursor']) {
      expect(styles).toContain(`--provider-${provider}-fg`)
      expect(styles).toContain(`.provider-${provider}`)
    }
    // 会话名册：厂商色只落在模型名前的 7px 色块上，文字保持中性，不给整行染色。
    expect(styles).toMatch(/\.session-row__model > i\s*\{[^}]*var\(--model-provider-fg/)
    expect(styles).not.toMatch(/\.session-row__model\s*\{[^}]*var\(--model-provider-fg/)
    expect(styles).toMatch(/\.composer-model\s*\{[^}]*var\(--plate-ink/)
  })

  it('keeps the session roster on the inspector language: one frame, hairlines, accent only for selection', () => {
    // 行不再自带边框 / 阴影；选中态 = 左缘光刃（亮→深渐变 + --accent-glow 余晖）+ 自左缘晕开的淡橙；
    // 状态色只在 --rail-state 驱动的状态点上；选中底色与 hover 的中性灰不再共享（区分度的根因约束）。
    expect(styles).toMatch(/\.session-row\s*\{[^}]*background:\s*transparent;\s*border:\s*0;/s)
    expect(styles).toMatch(/\.session-row::before\s*\{[^}]*width:\s*3px;[^}]*background:\s*linear-gradient\(to bottom, var\(--accent-bright\), var\(--accent-deep\)\)[^}]*box-shadow:[^}]*var\(--accent-glow\)/s)
    expect(styles).toMatch(/\.session-row\.is-selected\s*\{\s*background:\s*linear-gradient\(to right, color-mix\(in srgb, var\(--accent\) 7%, transparent\), transparent\)/)
    expect(styles).not.toMatch(/\.session-row\.is-selected\s*\{[^}]*var\(--surface-soft\)/)
    expect(styles).toContain('--accent-glow: light-dark(')
    // 四色状态灯：待命绿 · 干活琥珀（独立信号色，不是主题橙）· 需关注蓝 · 离线红；分组书签脊同一映射。
    for (const scope of ['session-row', 'session-group']) {
      expect(styles).toMatch(new RegExp(`\\.${scope}\\.is-waiting\\s*\\{\\s*--rail-state:\\s*var\\(--color-text-success\\)`))
      expect(styles).toMatch(new RegExp(`\\.${scope}\\.is-active\\s*\\{\\s*--rail-state:\\s*var\\(--signal-busy\\)`))
      expect(styles).toMatch(new RegExp(`\\.${scope}\\.is-attention\\s*\\{\\s*--rail-state:\\s*var\\(--color-text-info\\)`))
      expect(styles).toMatch(new RegExp(`\\.${scope}\\.is-offline\\s*\\{\\s*--rail-state:\\s*var\\(--color-text-danger\\)`))
    }
    expect(styles).toContain('--signal-busy: light-dark(')
    expect(styles).not.toMatch(/--signal-busy:[^;]*var\(--accent/)
    // 呼吸灯呼吸的是光晕（box-shadow 2 → 4px），灯芯不闪（块内不得出现 opacity）。
    const pulse = /@keyframes rail-pulse \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
    expect(pulse).toContain('box-shadow: 0 0 0 4px')
    expect(pulse).not.toContain('opacity')
    expect(styles).toMatch(/\.session-list__slot \+ \.session-list__slot\s*\{[^}]*border-top:\s*1px solid var\(--color-border-tertiary\)/)
    // 名册正文有阅读面下限（透明卡片模式下仍可读）；吸顶分组标题实底，滚过的行不会透出来。
    expect(styles).toMatch(/\.session-pane\s*\{[^}]*--rail-reading-opacity:\s*max\(0\.92, var\(--card-opacity\)\)/s)
    expect(styles).toMatch(/\.session-list\s*\{[^}]*var\(--rail-reading-opacity\)/s)
    expect(styles).toMatch(/\.session-group__header\s*\{[^}]*position:\s*sticky[^}]*background:\s*var\(--surface-solid\)/s)
    // 上下文光环：三档天色；reduced-motion 下脉冲与弧长过渡都关闭，光刃的生长过渡也直接落位。
    expect(styles).toMatch(/\.session-row__ring\.is-dusk \.session-row__ring-arc\s*\{\s*stroke:\s*var\(--sky-dusk\)/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.session-row\.is-active \.session-row__state > i\s*\{\s*animation:\s*none/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.session-row::before[^{]*\{\s*transition:\s*none/)
    expect(styles).not.toContain('.rail-session-card')
    expect(styles).not.toContain('.session-filters')
  })

  it('animates sidebar tracks without removing grid cells or squeezing their content', () => {
    expect(styles).toContain('.resizable-columns--2.is-first-pane-collapsed { grid-template-columns: minmax(0, 0px) 0px minmax(var(--resizable-final-min), 1fr); }')
    expect(styles).toContain('.shell-columns, .workspace-dock { transition: grid-template-columns 240ms cubic-bezier(0.2, 0.8, 0.2, 1); }')
    expect(styles).toContain('.session-sidebar-pane > * { position: absolute; inset: 0 auto 0 0; width: var(--resizable-pane-0); }')
    expect(styles).toContain('body.is-resizing-columns .resizable-columns { transition: none; }')
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.shell-columns, \.workspace-dock \{ transition: none; \}/)
    expect(styles).toContain('.session-sidebar-pane > * { position: static; width: auto; }')
  })

  it('unifies composer model and parameters without coloured badge boxes', () => {
    expect(styles).toContain('.composer-model-params > i { font: inherit; font-style: normal; white-space: nowrap; }')
    expect(styles).not.toContain('.composer-model > i.is-')
    expect(styles).toMatch(/\.model-logo-slot::after\s*\{[^}]*height: 18px;[^}]*var\(--plate-edge/)
    expect(styles).toMatch(/\.composer-model-params\s*\{[^}]*height: 18px;[^}]*var\(--plate-edge/)
  })

  it('keeps context pressure colours independent from session connectivity', () => {
    expect(styles).toMatch(/\.session-row__ring-arc\s*\{\s*stroke: var\(--color-text-success\)/)
    expect(styles).toContain('.session-row__ring.is-afternoon .session-row__ring-arc { stroke: var(--sky-afternoon); }')
    expect(styles).toContain('.session-row__ring.is-dusk .session-row__ring-arc { stroke: var(--sky-dusk); }')
    expect(styles).not.toContain('.session-row.is-offline .session-row__ring-arc')
  })

  it('keeps composer action labels visible and wraps instead of clipping on narrow layouts', () => {
    expect(styles).not.toMatch(/\.composer-tool span\s*\{\s*display:\s*none/)
    expect(styles).toMatch(/\.composer-topbar__left\s*\{[^}]*flex-wrap: wrap/)
    expect(styles).toMatch(/\.composer-tool\s*\{[^}]*flex: 0 0 auto/)
    expect(styles).toContain('--plate-bg: #eee2d3;')
  })

  it('keeps native window controls outside content while centering navigation on macOS and Windows', () => {
    expect(styles).toContain('html[data-platform="darwin"] { --window-control-safe-left: 84px; }')
    expect(styles).toContain('html[data-platform="darwin"][data-native-fullscreen="true"] { --window-control-safe-left: 0px; }')
    expect(styles).toContain('html[data-platform="win32"] { --window-control-safe-right: 138px; }')
    expect(styles).toMatch(/\.topbar\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0 calc\(var\(--window-control-safe-right\) \+ var\(--topbar-gutter\)\)/s)
    expect(styles).toMatch(/\.topbar-nav\s*\{[^}]*translateX\(calc\(\(var\(--window-control-safe-right\) - var\(--window-control-safe-left\)\) \/ 2\)\)/s)
    expect(styles).not.toMatch(/\.topbar__actions\s*\{[^}]*margin-right:\s*var\(--window-control-safe-right\)/)
    expect(styles).not.toContain('margin: 0 calc(var(--window-control-safe-right) / 2)')
  })

  it('uses segmented run-page step connectors and honours reduced motion', () => {
    // 四步流程：连接线从节点右侧起、到下一节点前止，最后一步没有连接线。
    expect(run).toMatch(/\.run-steps li::before\s*\{[^}]*left:\s*calc\(50% \+ 14px\)/s)
    expect(run).toContain('.run-steps li:last-child::before { display: none; }')
    // 模式分段控件：指示块用 transform 位移，reduced-motion 下不做过渡。
    expect(run).toMatch(/\.run-mode-switch__indicator\s*\{[^}]*transition:\s*transform/s)
    expect(run).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.run-mode-switch__indicator[^{]*\{\s*transition:\s*none/)
    // 可折叠插槽（确认面 / 提示条）靠 grid-template-rows 过渡展开，reduced-motion 下同样直接落位。
    expect(run).toMatch(/\.run-slot\s*\{[^}]*transition:\s*grid-template-rows/s)
    expect(run).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.run-slot[^{]*\{\s*transition:\s*none/)
    expect(run).not.toContain('box-shadow: inset 3px 0 0 var(--accent)')
    expect(lobby).toContain('.account-browser__connection-row')
  })

  it('keeps tool identity colors theme-aware and the todo list on the Cursor-native monochrome design', () => {
    // 工具身份色板：明暗双值（light-dark）成对出现，卡体不染色
    for (const kind of ['read', 'search', 'edit', 'write', 'command', 'browser', 'mcp', 'todo']) {
      expect(styles).toMatch(new RegExp(`\\.cursor-native-tool\\.is-${kind}, \\.process-turn-step\\.is-${kind}, \\.session-row__activity\\.is-${kind} \\{[^}]*--tool-hue:\\s*light-dark\\(`))
    }
    // Cursor 原生 todo：实心圆反色 spinner + 透明度阶梯（单色纪律）
    expect(styles).toMatch(/\.todo-spinner\s*\{[^}]*background:\s*var\(--text\)[^}]*border-radius:\s*50%/)
    expect(styles).toContain('@keyframes todo-spin')
    expect(styles).toMatch(/\.process-turn-step__todos li\.is-completed\s*\{[^}]*opacity:\s*\.5[^}]*line-through/)
    expect(styles).toMatch(/\.process-turn-step__todos li\.is-pending\s*\{[^}]*opacity:\s*\.4/)
    // reduced-motion 必须豁免 todo 的 spinner 与淡入动画
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.todo-spinner svg,\s*\n\s*\.process-turn-step__todos li\s*\{[^}]*animation:\s*none/)
  })
})
