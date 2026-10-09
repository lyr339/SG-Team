/** Theme identity is not a workflow status or a model provider colour.
 * Stable IDs keep existing appearance preferences compatible. All palettes
 * supply the same roles; components never derive their own solid-action hue. */
export interface AccentPreset {
  id: string
  label: string
  description: string
  base: string
  ink: readonly [light: string, dark: string]
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'sg-orange', label: '拾光橙', description: '温润铜橙，保留拾光的辨识度', base: '#a64c2c', ink: ['#974127', '#e5ad94'] },
  { id: 'dai-blue', label: '雾蓝', description: '克制的灰蓝，适合长时间阅读', base: '#3d628f', ink: ['#355781', '#a8c3e5'] },
  { id: 'bamboo-teal', label: '青墨', description: '低饱和青色，清晰而安静', base: '#276d70', ink: ['#205c61', '#9dd1d0'] },
  { id: 'luoshen-violet', label: '烟紫', description: '柔和灰紫，不使用荧光高亮', base: '#72518e', ink: ['#63427f', '#c9b3df'] },
  { id: 'rouge-rose', label: '玫瑰', description: '沉稳玫瑰色，与错误红保持语义分离', base: '#96516c', ink: ['#85435d', '#dfb1c4'] },
  { id: 'ink-jade', label: '石墨', description: '中性蓝灰，让内容而非装饰成为重点', base: '#536271', ink: ['#455361', '#bdc8d4'] }
] as const

export const DEFAULT_ACCENT_ID = ACCENT_PRESETS[0]!.id
export type ThemeColourPair = readonly [light: string, dark: string]

/** sRGB mixing matches CSS color-mix(in srgb). Used only when generating the
 * checked-in stylesheet, never during React rendering or a theme interaction. */
function mix(foreground: string, background: string, amount: number): string {
  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return '#' + [1, 3, 5].map(offset => Math.round(channel(foreground, offset) * amount + channel(background, offset) * (1 - amount)).toString(16).padStart(2, '0')).join('')
}

export function themeRoles(preset: AccentPreset): Record<string, ThemeColourPair> {
  const lightPanel = '#ffffff', darkPanel = '#181d25'
  const lightCanvas = mix(preset.base, '#f2f5f9', .035), darkCanvas = mix(preset.ink[1], '#121720', .025)
  const accent: ThemeColourPair = [preset.base, preset.ink[1]]
  const wash: ThemeColourPair = [mix(preset.base, lightPanel, .065), mix(preset.ink[1], darkPanel, .09)]
  const soft: ThemeColourPair = [mix(preset.base, lightPanel, .13), mix(preset.ink[1], darkPanel, .16)]
  const selected: ThemeColourPair = [mix(preset.base, lightPanel, .1), mix(preset.ink[1], darkPanel, .13)]
  return {
    '--accent': accent,
    '--accent-deep': preset.ink,
    '--accent-bright': accent,
    '--action-primary-bg': [preset.base, preset.base],
    '--action-primary-hover-bg': [mix(preset.base, '#11151c', .88), mix(preset.base, '#11151c', .88)],
    '--action-primary-pressed-bg': [mix(preset.base, '#11151c', .76), mix(preset.base, '#11151c', .76)],
    '--action-primary-text': ['#ffffff', '#ffffff'],
    '--accent-bubble': [preset.base, preset.base],
    '--theme-solid-code-bg': [mix(preset.base, '#11151c', .86), mix(preset.base, '#11151c', .86)],
    '--accent-wash': wash,
    '--accent-soft': soft,
    '--accent-selected': selected,
    '--accent-border-strong': accent,
    '--accent-border': [mix(preset.base, lightPanel, .46), mix(preset.ink[1], darkPanel, .46)],
    '--accent-border-soft': [mix(preset.base, lightPanel, .26), mix(preset.ink[1], darkPanel, .26)],
    '--color-ring-primary': accent,
    '--theme-selection-bg': [mix(preset.base, lightPanel, .22), mix(preset.ink[1], darkPanel, .24)],
    '--theme-selection-text': ['#171b24', '#f4f7fb'],
    '--theme-solid-selection-bg': ['#ffffff', '#ffffff'],
    '--theme-solid-selection-text': [preset.base, preset.base],
    // The content panel and native titlebar stay neutral. Canvas and interaction
    // surfaces receive a restrained tint instead of saturating the whole page.
    '--color-background-secondary': [lightCanvas, darkCanvas],
    '--color-background-tertiary': [mix(preset.base, '#edf2f7', .03), mix(preset.ink[1], '#0b1017', .02)],
    '--theme-backdrop': [`color-mix(in srgb, ${lightCanvas} 48%, transparent)`, `color-mix(in srgb, ${darkCanvas} 42%, transparent)`]
  }
}

/** One source for the complete palette. Generation is explicit; a test checks
 * that the committed CSS matches this source, including the default fallback. */
export function renderThemePaletteCSS(): string {
  return '/* Generated from theme-palette.ts. Run npm run theme:generate; do not edit. */\n' + ACCENT_PRESETS.map((preset, index) => {
    const selector = index === 0 ? `:root, html[data-accent="${preset.id}"]` : `html[data-accent="${preset.id}"]`
    const declarations = Object.entries(themeRoles(preset)).map(([role, [light, dark]]) => `  ${role}: ${light === dark ? light : `light-dark(${light}, ${dark})`};`).join('\n')
    return `${selector} {\n${declarations}\n}\n`
  }).join('\n') + '\n' + ACCENT_PRESETS.map(preset =>
    `.appearance-accent__swatch[data-accent-choice="${preset.id}"] {\n  --choice-fill: light-dark(${preset.base}, ${preset.ink[1]});\n}\n`
  ).join('\n')
}
