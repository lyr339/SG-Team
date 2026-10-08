import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'src/renderer/src')
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const geometry = read('switch-geometry.css').replace(/\s+/g, '')
const styles = read('styles.css'), notices = read('notifications/notifications.css')
const files = (directory: string, suffix: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(directory, entry.name), suffix) : entry.name.endsWith(suffix) ? [join(directory, entry.name)] : [])
const rendererRelativePath = (file: string, directory = root) => file.slice(directory.length + 1).replaceAll('\\', '/')

describe('all switch skins share border-independent centering', () => {
  it('centers vertically and derives horizontal travel instead of maintaining magic pixel offsets', () => {
    expect(geometry).toContain('top:50%')
    expect(geometry).toContain('left:calc((var(--switch-height)-var(--switch-thumb-size))/2)')
    expect(geometry).toContain('transform:translate(var(--switch-travel),-50%)')
    expect(geometry).toContain('--switch-travel:calc(var(--switch-width)-var(--switch-height))')
    expect(geometry).toContain('width:var(--switch-width);height:var(--switch-height)')
    expect(geometry).toMatch(/\.notification-preference>i\)\{[^}]*padding:0;border:0/)
    expect(geometry).toMatch(/::before\{[^}]*inset:0;[^}]*border:1pxsolidvar\(--switch-edge\)/)
    expect(read('controls.css')).toContain("@import './switch-geometry.css'")
    for (const entry of ['main.tsx', 'preview/preview-main.tsx']) expect(read(entry)).toContain('controls.css')
  })
  it('retains the two original sizes and guarantees equal endpoint clearance without a layout-border term', () => {
    for (const [source, selector, width, height, thumb] of [[styles, '.toggle-switch__track', 36, 21, 15], [notices, '.notification-preference > i', 34, 20, 14]] as const) {
      const body = source.slice(source.indexOf(`${selector} {`)).split('}')[0]!
      expect(body).toMatch(new RegExp(`--switch-width:\\s*${width}px`))
      expect(body).toMatch(new RegExp(`--switch-height:\\s*${height}px`))
      expect(body).toMatch(new RegExp(`--switch-thumb-size:\\s*${thumb}px`))
      // Algebraic source contract only. Actual browser geometry is checked
      // separately across zoom, on/off, disabled, busy and both colour schemes.
      const clearance = (height - thumb) / 2, travel = width - height
      expect(clearance).toBe(3)
      expect(width - (clearance + travel + thumb)).toBe(clearance)
    }
  })
  it('has no per-page geometry override that can reintroduce border-rounded or mismatched travel', () => {
    for (const file of files(root, '.css').filter(file => !file.endsWith('switch-geometry.css'))) {
      const css = readFileSync(file, 'utf8')
      for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/toggle-switch__track|toggle-switch__thumb|notification-preference\b[^{}]*[>+]\s*i\b/.test(selector!)) continue
        expect(declarations, `${file}: ${selector}`).not.toMatch(/(?:^|[;\s])(?:top|left|right|bottom|width|height|transform|padding|border):/)
      }
    }
  })
  it('normalizes Windows and POSIX paths before excluding preview-only callers', () => {
    for (const [directory, separator] of [['C:\\workspace\\src', '\\'], ['/workspace/src', '/']] as const) {
      expect(rendererRelativePath(`${directory}${separator}preview${separator}switch-review.tsx`, directory)).toBe('preview/switch-review.tsx')
      expect(rendererRelativePath(`${directory}${separator}settings${separator}SettingsUpdate.tsx`, directory)).toBe('settings/SettingsUpdate.tsx')
    }
  })
  it('covers every shared switch caller and respects reduced motion for both painted outlines and thumbs', () => {
    const callers = files(root, '.tsx').filter(file => !rendererRelativePath(file).startsWith('preview/') && readFileSync(file, 'utf8').includes('<ToggleSwitch'))
    expect(callers.map(file => rendererRelativePath(file)).sort()).toEqual([
      'lobby/CursorModelConfigDialog.tsx', 'run/GroupComposer.tsx', 'run/RunSeats.tsx', 'settings/SettingsAutomation.tsx',
      'settings/SettingsCleanup.tsx', 'settings/SettingsMaintenance.tsx', 'settings/SettingsUpdate.tsx'
    ])
    expect(callers.reduce((count, file) => count + readFileSync(file, 'utf8').split('<ToggleSwitch').length - 1, 0)).toBe(14)
    expect(geometry).toContain('@media(prefers-reduced-motion:reduce)')
    expect(geometry).toContain('.notification-preference>i::after{transition:none!important')
    expect(geometry).not.toMatch(/scale\(|translateX\(\d/)
  })
})
