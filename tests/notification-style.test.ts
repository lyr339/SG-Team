import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const css = readFileSync(join(process.cwd(), 'src/renderer/src/notifications/notifications.css'), 'utf8')
const rule = (selector: string) => css.match(new RegExp(`${selector.replaceAll('.', '\\.')} \\{([^}]+)\\}`))?.[1] ?? ''
describe('quiet notification surfaces', () => {
  it('uses neutral uniform framing, comfortable text and no status-coloured rail, glow or capsule', () => {
    for (const selector of ['.notification-panel', '.notification-toast']) {
      const block = rule(selector)
      expect(block).toContain('background: var(--surface-solid)')
      expect(block).toContain('border: 1px solid var(--color-border-secondary)')
      expect(block).not.toMatch(/border-left|linear-gradient|999px|infinite/)
    }
    expect(css).toContain('font-size: var(--fs-14)')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('calc(100vw - 24px)')
    expect(css).not.toContain('transition: all')
  })
  it('lets native range labels keep their intrinsic width including the shared arrow padding', () => {
    const select = rule('.notification-panel__toolbar select')
    expect(select).toContain('width: auto')
    expect(select).toContain('max-width: 100%')
    expect(select).toContain('flex: none')
    expect(select).toContain('line-height: 1.4')
    expect(select).not.toMatch(/max-width:\s*\d+px/)
    expect(rule('.notification-panel__toolbar')).toContain('flex-wrap: wrap')
    expect(rule('.notification-tabs')).toContain('flex: none')
    expect(rule('.notification-tabs button')).toContain('white-space: nowrap')
  })
  it('bounds quiet-hour fields and lets footer actions wrap instead of cropping their text', () => {
    expect(rule('.notification-hours')).toContain('minmax(0, 8em)')
    expect(rule('.notification-hours')).toContain('max-width: 100%')
    expect(rule('.notification-hours input')).toContain('width: 100%')
    expect(rule('.notification-hours input')).toContain('min-width: 0')
    expect(rule('.notification-panel__footer-actions')).toContain('flex-wrap: wrap')
  })
})
