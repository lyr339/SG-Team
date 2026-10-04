import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const css = readFileSync(join(process.cwd(), 'src/renderer/src/notifications/notifications.css'), 'utf8')
describe('quiet notification surfaces', () => {
  it('uses neutral uniform framing, comfortable text and no status-coloured rail, glow or capsule', () => {
    for (const selector of ['.notification-panel', '.notification-toast']) {
      const block = css.match(new RegExp(`${selector.replaceAll('.', '\\.')} \\{([^}]+)\\}`))?.[1] ?? ''
      expect(block).toContain('background: var(--surface-solid)')
      expect(block).toContain('border: 1px solid var(--color-border-secondary)')
      expect(block).not.toMatch(/border-left|linear-gradient|999px|infinite/)
    }
    expect(css).toContain('font-size: var(--fs-14)')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('calc(100vw - 24px)')
    expect(css).not.toContain('transition: all')
  })
})
