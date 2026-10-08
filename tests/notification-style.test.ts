import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const file = (path: string) => readFileSync(join(process.cwd(), 'src/renderer/src', path), 'utf8')
const css = file('notifications/notifications.css'), center = file('notifications/NotificationCenter.tsx')
const styles = file('styles.css'), theme = file('claude-theme.css'), shared = file('feedback/feedback.css')
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1]?.replace(/\s+/g, '') ?? ''
describe('polished notification presentation contracts', () => {
  it('uses neutral framing, explicit existing font tokens and no status rail or decorative glow', () => {
    for (const selector of ['.notification-panel', '.notification-toast']) {
      const block = rule(selector)
      expect(block).toContain('background:var(--surface-solid)'); expect(block).toContain('border:1pxsolidvar(--color-border-secondary)')
      expect(block).not.toMatch(/border-left|linear-gradient|999px|infinite/)
    }
    expect(css).not.toMatch(/--fs-(14|16)/); expect(css).not.toContain('transition: all')
    for (const [, token] of css.matchAll(/var\((--font-[\w-]+)\)/g)) expect(theme).toContain(token + ':')
    expect(css).toContain('prefers-reduced-motion:reduce'); expect(css).toContain('calc(100vw - 24px)')
  })
  it('uses theme-owned selectors, not platform-painted native filter/preference menus', () => {
    expect(center).not.toMatch(/<select|<option/)
    expect(center).toContain('ariaLabel="通知工作区范围"'); expect(center).toContain('ariaLabel="此会话的提醒偏好"')
    expect(rule('.notification-panel__toolbar')).toContain('flex-wrap:wrap')
    expect(rule('.notification-panel__toolbar .notification-scope')).toContain('max-width:100%')
    expect(rule('.notification-session-preference .menu-select')).toContain('flex:none')
    expect(rule('.notification-session-preference .menu-select')).toContain('margin-left:auto')
    expect(styles).toContain('button[role="option"]:focus-visible')
    // Geometry and painted menu states are separately verified in the browser;
    // this is only the source contract, not a screenshot substitute.
    for (const [selector, count, padding] of [['.notification-scope .menu-select__button',5,40],['.notification-session-preference .menu-select__button',4,42]] as const) {
      const budget=rule(selector).match(/min-inline-size:calc\((\d+)em\+(\d+)px\)/)!
      expect(budget).not.toBeNull(); expect(Number(budget[1])).toBeGreaterThanOrEqual(count+1); expect(Number(budget[2])).toBe(padding)
    }
  })
  it('keeps list scrolling separate from footer actions and removes nested detail scrolling', () => {
    expect(rule('.notification-panel__body')).toContain('overflow-y:auto'); expect(rule('.notification-panel__body')).toContain('overscroll-behavior:contain')
    expect(rule('.notification-row__detail > p')).not.toMatch(/max-height|overflow-y/)
    expect(rule('.notification-panel__footer-actions')).toContain('flex-wrap:wrap')
    expect(rule('.notification-hours')).toContain('max-width:360px'); expect(rule('.notification-hours input')).toContain('width:100%')
  })
  it('stabilizes tab width and empty/loading geometry without removing the panel entry animation', () => {
    expect(rule('.notification-tabs button')).toContain('min-inline-size:calc(3em+18px)')
    expect(rule('.notification-empty')).toContain('min-block-size:132px')
    expect(rule('.notification-empty')).toContain('box-sizing:border-box')
    expect(css).toContain('.notification-tabs button:hover:not([aria-selected="true"])')
    expect(rule('.notification-panel')).toContain('animation:notification-enter160msease-out')
  })
  it('does not change the history disclosure trigger box or make the trigger itself a scroll child when opened', () => {
    const open = css.match(/\.notification-history-policy\[open\]\s*\{([^}]+)\}/)?.[1] ?? ''
    expect(open).not.toMatch(/padding|margin|overflow|block-size/)
    expect(rule('.notification-history-policy__content')).toContain('overflow-y:auto')
    expect(rule('.notification-history-policy__content')).toContain('scrollbar-gutter:stable')
    expect(file('notifications/NotificationHistoryNotice.tsx')).toContain('notification-history-policy__content')
  })
  it('keeps scrollbar allocation stable in the same-pattern long disclosures and their scroll surfaces', () => {
    const settings = file('settings/settings.css').replace(/\s+/g, '')
    expect(settings).toMatch(/\.settings-page\{[^}]*scrollbar-gutter:stable/)
    expect(settings).toMatch(/\.settings-notice__details>div\{[^}]*max-height:180px;overflow-y:auto;scrollbar-gutter:stable/)
    expect(settings).not.toMatch(/\.settings-notice__details\.is-open>div\{/)
    expect(file('notifications/team-memory-inspection.css').replace(/\s+/g, '')).toMatch(/\.memory-inspection__scroll\{[^}]*scrollbar-gutter:stable/)
    expect(file('team/collaboration-map.css').replace(/\s+/g, '')).toMatch(/\.collaboration-dialog__body\{[^}]*scrollbar-gutter:stable/)
  })
  it('aligns the Toast icon, title and dismiss action in a real header rather than fixed margin guesses', () => {
    expect(file('notifications/NotificationCard.tsx')).toContain('notification-toast__header')
    expect(file('notifications/NotificationToast.tsx')).toContain('<NotificationCard')
    expect(file('UpdateReminder.tsx')).toContain('<NotificationCard')
    expect(rule('.notification-toast__header')).toContain('grid-template-columns:18pxminmax(0,1fr)30px')
    expect(css).not.toContain('margin-top: 20px'); expect(shared).not.toMatch(/border-left|linear-gradient/)
  })
})
