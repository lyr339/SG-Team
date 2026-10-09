import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, themeRoles } from '../src/renderer/src/theme-palette'

const read = (name: string) => readFileSync(join(process.cwd(), 'src/renderer/src', name), 'utf8')
const styles = read('styles.css'), foundation = read('foundation.css'), actions = read('action-controls.css')
const rgb = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16))
const blend = (fore: number[], back: number[], opacity: number) => fore.map((value, index) => value * opacity + back[index]! * (1 - opacity))
const luminance = (values: number[]) => values.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
const contrast = (fore: number[], back: number[]) => (Math.max(luminance(fore), luminance(back)) + .05) / (Math.min(luminance(fore), luminance(back)) + .05)

describe('themes preserve complete component state contracts', () => {
  it('keeps six theme dots in one compact row with separate selection and keyboard focus rings', () => {
    expect(styles).toMatch(/\.appearance-accent > div\[role="group"\]\s*\{[^}]*display:flex;[^}]*gap:10px/)
    expect(styles).toMatch(/\.appearance-accent__swatch\s*\{[^}]*width:32px;[^}]*height:32px;[^}]*place-items:center;[^}]*border-radius:50%/)
    expect(styles).toMatch(/\.appearance-accent__swatch > i\s*\{[^}]*width:24px;[^}]*height:24px;[^}]*var\(--choice-fill\)/)
    expect(styles).toMatch(/\.appearance-accent__swatch\.is-active\s*\{[^}]*box-shadow:0 0 0 2px/)
    expect(styles).toMatch(/\.appearance-accent__swatch:focus-visible\s*\{[^}]*outline:2px[^}]*outline-offset:4px/)
    expect(styles).not.toContain('appearance-accent__preview')
  })
  it('owns common safe-action hover, pressed and visible focus states without overriding busy, disabled or danger controls', () => {
    expect(read('controls.css')).toContain("@import './action-controls.css'")
    expect(actions).toContain(':not(.is-danger):not(:disabled):not([aria-disabled="true"]):not([aria-busy="true"])')
    expect(actions).toMatch(/&:hover\s*\{[^}]*--action-primary-hover-bg/)
    expect(actions).toMatch(/&:active\s*\{[^}]*--action-primary-pressed-bg/)
    expect(actions).toContain('var(--surface-solid)')
    expect(actions).toContain('prefers-reduced-motion:reduce')
    expect(actions).toContain('.fresh-empty__actions > button:first-child')
    expect(actions).not.toContain('.fresh-empty button,')
    expect(actions).not.toMatch(/!important|transition:\s*all/)
  })
  it('keeps appearance controls out of snapshot hit-testing suppression during rapid real clicks', () => {
    expect(styles).toContain('view-transition-name:none')
    expect(styles).toMatch(/\.desktop-body\s*\{\s*view-transition-name:appearance-content/)
    expect(styles).toMatch(/::view-transition\s*\{\s*pointer-events:none/)
    expect(styles).toContain('animation-duration:140ms')
    expect(styles).not.toMatch(/\.topbar\s*\{[^}]*view-transition-name:/)
  })
  it('keeps code and tables readable inside a solid user message instead of inheriting white text onto a neutral surface', () => {
    expect(styles).toMatch(/\.chat-row--mine \.message-content pre code\s*\{[^}]*color:inherit;[^}]*background:transparent/)
    expect(styles).toMatch(/\.chat-row--mine \.message-content table\s*\{[^}]*color:var\(--text\)/)
    expect(styles).toMatch(/\.chat-row--mine \.message-content table code\s*\{[^}]*color:var\(--accent-deep\)/)
    expect(styles).toContain('--code-bg: var(--canvas-solid)')
    expect(styles).toContain('--code-text: var(--text)')
    expect(styles).toContain('.chat-row--mine .message-content table ::selection')
  })
  it('provides contrast-safe solid danger backgrounds independently of theme colours', () => {
    for (const name of ['--action-danger-bg', '--action-danger-hover-bg', '--action-danger-pressed-bg']) {
      const match = foundation.match(new RegExp(`${name}:\\s*light-dark\\((#[\\da-f]{6}),\\s*(#[\\da-f]{6})\\)`))!
      expect(match).not.toBeNull()
      for (const value of match.slice(1)) expect(contrast(rgb('#ffffff'), rgb(value))).toBeGreaterThanOrEqual(4.5)
    }
    expect(read('run/run.css')).toMatch(/\.run-sheet__confirm\.is-danger\s*\{[^}]*--action-danger-text[^}]*--action-danger-bg/)
    expect(actions).toMatch(/&:active\s*\{[^}]*--action-danger-pressed-bg/)
  })
  it('keeps both off-switch skins opaque and distinct from their thumb, even over transparent cards', () => {
    const track = foundation.match(/--color-control-track:\s*light-dark\((#[\da-f]{6}),\s*(#[\da-f]{6})\)/)!
    const thumb = foundation.match(/--color-control-thumb:\s*light-dark\((#[\da-f]{6}),\s*(#[\da-f]{6})\)/)!
    for (const mode of [1, 2]) expect(contrast(rgb(thumb[mode]!), rgb(track[mode]!))).toBeGreaterThanOrEqual(3)
    expect(styles).toMatch(/\.toggle-switch__track\s*\{[^}]*background:\s*var\(--color-control-track\)/)
    expect(read('notifications/notifications.css')).toMatch(/\.notification-preference > i\s*\{[^}]*background:var\(--color-control-track\)/)
  })
  it('bounds readable planes under extreme image pixels without rewriting saved opacity preferences', () => {
    expect(styles).toContain('calc(max(var(--card-opacity), .78) * 100%)')
    expect(foundation).toContain('--color-text-ghost: var(--color-text-tertiary)')
    const foreground = ['#566173', '#9ca8ba']
    for (const preset of ACCENT_PRESETS) for (const mode of [0, 1]) {
      const roles = themeRoles(preset), backdrop = roles['--theme-backdrop']![mode]!.match(/(#[\da-f]{6}) (\d+)%/)!
      const extreme = [mode ? 255 : 0, mode ? 255 : 0, mode ? 255 : 0]
      const under = blend(rgb(backdrop[1]!), extreme, Number(backdrop[2]) / 100)
      const plane = blend(rgb(mode ? '#181d25' : '#ffffff'), under, .78)
      expect(contrast(rgb(foreground[mode]!), plane), `${preset.id}: readable ${mode}`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('themes communication ink and actual account actions while retaining historical and in-progress semantics', () => {
    const graph = read('team/collaboration-map.css'), lobby = read('lobby/lobby.css')
    expect(graph).toContain('--collaboration-ink: var(--accent-deep)')
    expect(graph).toMatch(/\.collaboration-wire__silk\s*\{[^}]*stroke:\s*var\(--collaboration-ink\)/)
    expect(graph).toContain('--collaboration-history: light-dark(')
    expect(graph).not.toMatch(/stroke:\s*#[\da-f]{6}/)
    expect(styles).toMatch(/\.account-switch-live\s*\{[^}]*color:\s*var\(--accent-deep\)/)
    expect(lobby).toMatch(/\.lobby-account__inject\s*\{[^}]*color:\s*var\(--accent-deep\)/)
    expect(read('settings/settings.css')).toMatch(/\.account-row__actions > \.account-switch-live.is-busy:disabled\s*\{[^}]*var\(--color-text-info\)/)
  })
  it('keeps success and waiting status surfaces independent of a selectable theme, not just their text', () => {
    for (const selector of ['.fresh-notice--success', '.status-pill--waiting', '.task-card__handoff.is-completed']) {
      const rule = styles.split(`${selector} {`)[1]!.split('}')[0]!
      expect(rule).toContain('--color-text-success')
      expect(rule).toContain('--color-background-success')
      expect(rule).toContain('--color-border-success')
      expect(rule).not.toContain('--accent')
    }
  })
})
