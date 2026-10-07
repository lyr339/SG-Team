import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const css = readFileSync(join(process.cwd(), 'src/renderer/src/notifications/notifications.css'), 'utf8')
const controls = readFileSync(join(process.cwd(), 'src/renderer/src/controls.css'), 'utf8')
const center = readFileSync(join(process.cwd(), 'src/renderer/src/notifications/NotificationCenter.tsx'), 'utf8')
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
    expect(select).toContain('box-sizing: border-box')
    expect(select).toContain('white-space: nowrap')
    expect(select).not.toMatch(/max-width:\s*\d+px/)
    expect(rule('.notification-panel__toolbar')).toContain('flex-wrap: wrap')
    expect(rule('.notification-tabs')).toContain('flex: none')
    expect(rule('.notification-tabs button')).toContain('white-space: nowrap')
  })
  it('budgets both shared native insets and a full em of spare text space, not only the outer field width', () => {
    // This checks the CSS contract, not a native browser paint. Screenshot/DOM
    // inspection must separately verify the real selected text and focus state.
    const insets = ['left', 'right'].map(side => Number(controls.match(new RegExp(`padding-${side}:\\s*(\\d+)px !important`))![1]))
    const cases = [
      { selector: '.notification-panel__toolbar select', values: 'all|current', labels: ['所有工作区', '当前工作区'], borders: 0 },
      { selector: '.notification-session-preference select', values: 'default|focus|quiet', labels: ['默认', '重点关注', '安静'], borders: 2 }
    ]
    for (const sample of cases) {
      const minimum = rule(sample.selector).match(/min-inline-size:\s*calc\((\d+)em \+ (\d+)px\)/)!
      expect(minimum).not.toBeNull()
      const labels = [...center.matchAll(new RegExp(`<option value="(?:${sample.values})">([^<]+)<\\/option>`, 'g'))].map(match => match[1]!)
      expect(labels).toEqual(sample.labels)
      for (const fontSize of [12, 14, 16, 18]) {
        const contentWidth = Number(minimum[1]) * fontSize + Number(minimum[2]) - insets.reduce((sum, inset) => sum + inset, 0) - sample.borders
        const requiredWidth = Math.max(...labels.map(label => [...label].length)) * fontSize
        expect(contentWidth - requiredWidth).toBeGreaterThanOrEqual(fontSize)
      }
    }
  })
  it('bounds quiet-hour fields and lets footer actions wrap instead of cropping their text', () => {
    expect(rule('.notification-hours')).toContain('minmax(0, 8em)')
    expect(rule('.notification-hours')).toContain('max-width: 100%')
    expect(rule('.notification-hours input')).toContain('width: 100%')
    expect(rule('.notification-hours input')).toContain('min-width: 0')
    expect(rule('.notification-panel__footer-actions')).toContain('flex-wrap: wrap')
  })
  it('moves the entire session selector to a new row before squeezing its label into single-character lines', () => {
    expect(rule('.notification-session-preference')).toContain('flex-wrap: wrap')
    expect(rule('.notification-session-preference > span')).toContain('flex: 1 0 auto')
    expect(rule('.notification-session-preference select')).toContain('flex: none')
    expect(rule('.notification-session-preference select')).toContain('margin-left: auto')
    expect(rule('.notification-session-preference small')).toContain('flex: 1 0 100%')
  })
})
