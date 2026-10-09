// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DisclosureChevron, DisclosureSummary } from '../src/renderer/src/DisclosureSummary'
import { ChevronDownIcon } from '../src/renderer/src/UiIcons'

const rootPath = join(process.cwd(), 'src/renderer/src')
const read = (name: string) => readFileSync(join(rootPath, name), 'utf8')

describe('shared disclosure controls', () => {
  it('preserves native details toggling, summary attributes, one hidden glyph and selectable body markup', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host), toggle = vi.fn()
    try {
      await act(async () => root.render(<details onToggle={toggle}><DisclosureSummary title="完整标题">历史保留与完整性</DisclosureSummary><p>可以正常选择与复制的正文</p></details>))
      const details = host.querySelector('details')!, summary = host.querySelector('summary')!
      expect(summary.title).toBe('完整标题')
      expect(summary.textContent).toBe('历史保留与完整性')
      expect(summary.querySelectorAll('svg')).toHaveLength(1)
      expect(summary.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
      expect(summary.querySelector('svg')!.getAttribute('focusable')).toBe('false')
      expect(summary.hasAttribute('aria-expanded')).toBe(false)
      await act(async () => summary.click())
      expect(details.open).toBe(true)
      await act(async () => summary.click())
      expect(details.open).toBe(false)
      expect(details.querySelector('p')!.textContent).toContain('正常选择与复制')
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('uses the same stable path for open/closed content, dropdowns and native selects', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(<><DisclosureChevron open={false}/><DisclosureChevron open/><ChevronDownIcon/></>))
      const icons = [...host.querySelectorAll('svg')]
      expect(icons.map(icon => icon.querySelector('path')!.getAttribute('d'))).toEqual(['m4 6 4 4 4-4','m4 6 4 4 4-4','m4 6 4 4 4-4'])
      expect(icons.map(icon => icon.getAttribute('viewBox'))).toEqual(['0 0 16 16','0 0 16 16','0 0 16 16'])
      expect(icons.map(icon => icon.getAttribute('stroke-width'))).toEqual(['1.5','1.5','1.5'])
      expect(icons[0]!.dataset.open).toBe('false')
      expect(icons[1]!.dataset.open).toBe('true')
      expect(read('assets/chevron-down.svg')).toContain('d="m4 6 4 4 4-4"')
      expect(read('controls.css')).toContain("url('./assets/chevron-down.svg')")
    } finally { await act(async () => root.unmount()) }
  })

  it('prevents only control-label selection without cancelling events or clearing document ranges', () => {
    const css = read('disclosure-controls.css')
    expect(css).toMatch(/:where\(button, summary\)\s*\{[^}]*user-select:none/)
    expect(css).toContain('summary::marker')
    expect(css).toContain('summary::-webkit-details-marker')
    expect(css).toContain('prefers-reduced-motion:reduce')
    expect(css).not.toMatch(/body\s*\{|\*\s*\{/)
    expect(read('DisclosureSummary.tsx')).not.toMatch(/preventDefault|removeAllRanges|onMouseDown|onPointerDown|useState/)
    const styles = read('notifications/notifications.css')
    expect(styles).toMatch(/\.notification-history-policy__content\s*\{[^}]*position:absolute;[^}]*user-select:text/)
    expect(styles).toContain('max-block-size:min(160px,calc(100dvh - 160px))')
  })

  it('routes every application native summary through the shared primitive, not a system triangle', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes:true }).flatMap(entry => entry.isDirectory()
      ? files(join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : [])
    for (const file of files(rootPath).filter(file => !file.endsWith('DisclosureSummary.tsx'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/<summary(?:\s|>)/)
    }
    for (const name of ['run/run.css', 'settings/update.css']) expect(read(name)).not.toMatch(/summary::before/)
  })
})
