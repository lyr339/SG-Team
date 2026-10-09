import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, renderThemePaletteCSS, themeRoles } from '../src/renderer/src/theme-palette'

const root = join(process.cwd(), 'src/renderer/src')
const cssFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? cssFiles(join(directory, entry.name)) : entry.name.endsWith('.css') ? [join(directory, entry.name)] : [])
const luminance = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
const contrast = (fore: string, back: string) => {
  const a = luminance(fore), b = luminance(back)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

describe('complete appearance role palettes', () => {
  it('keeps stable preference IDs and a generated default fallback from the same colour source', () => {
    expect(ACCENT_PRESETS.map(preset => preset.id)).toEqual(['sg-orange', 'dai-blue', 'bamboo-teal', 'luoshen-violet', 'rouge-rose', 'ink-jade'])
    const generated = renderThemePaletteCSS()
    expect(readFileSync(join(root, 'theme-palette.generated.css'), 'utf8')).toBe(generated)
    expect(generated).toContain(':root, html[data-accent="sg-orange"]')
    for (const preset of ACCENT_PRESETS) {
      expect(generated).toContain(`html[data-accent="${preset.id}"]`)
      expect(generated).toContain(`[data-accent-choice="${preset.id}"]`)
      expect(generated).toContain(`--choice-fill: light-dark(${preset.base}, ${preset.ink[1]})`)
      expect(contrast(preset.base, '#ffffff')).toBeGreaterThanOrEqual(3)
      expect(contrast(preset.ink[1], '#181d25')).toBeGreaterThanOrEqual(3)
    }
    expect(generated).not.toContain('--choice-wash')
    expect(readFileSync(join(root, 'foundation.css'), 'utf8')).toContain("@import './theme-palette.generated.css'")
    for (const entry of ['main.tsx', 'preview/preview-main.tsx']) expect(readFileSync(join(root, entry), 'utf8')).toContain('foundation.css')
  })

  it.each(ACCENT_PRESETS)('$label supplies identical roles with safe day/night text, actions, focus and selections', preset => {
    const roles = themeRoles(preset)
    expect(Object.keys(roles)).toEqual(Object.keys(themeRoles(ACCENT_PRESETS[0]!)))
    for (const mode of [0, 1] as const) {
      const panel = mode === 0 ? '#ffffff' : '#181d25'
      for (const background of [panel, roles['--accent-wash']![mode], roles['--accent-soft']![mode], roles['--accent-selected']![mode]]) {
        expect(contrast(roles['--accent-deep']![mode], background), `${preset.id}: text on ${background}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const role of ['--action-primary-bg', '--action-primary-hover-bg', '--action-primary-pressed-bg', '--accent-bubble', '--theme-solid-code-bg']) {
        expect(contrast(roles['--action-primary-text']![mode], roles[role]![mode]), `${preset.id}: ${role}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const background of [panel, roles['--color-background-secondary']![mode], roles['--color-background-tertiary']![mode]]) {
        expect(contrast(roles['--color-ring-primary']![mode], background), `${preset.id}: focus on ${background}`).toBeGreaterThanOrEqual(3)
      }
      expect(contrast(roles['--theme-selection-text']![mode], roles['--theme-selection-bg']![mode])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(roles['--theme-solid-selection-text']![mode], roles['--theme-solid-selection-bg']![mode])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('does not make semantic/provider/diff/data colours or neutral native chrome theme-dependent', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(Object.keys(themeRoles(preset)).join(' ')).not.toMatch(/provider-|diff-|usage-|signal-|color-(text|background)-(success|danger|warning|info)|color-background-primary/)
    }
  })

  it('has exactly one owner for the theme roles, not page-local solid-action or bubble formulas', () => {
    const managed = Object.keys(themeRoles(ACCENT_PRESETS[0]!)).filter(role => !role.startsWith('--color-background-'))
    for (const file of cssFiles(root).filter(file => !file.endsWith('theme-palette.generated.css'))) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/var\(--anthropic-orange\)/)
      for (const role of managed) expect(source, `${file}: ${role}`).not.toMatch(new RegExp(`${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`))
    }
  })
})
