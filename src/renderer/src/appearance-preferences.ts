export interface AppearancePreferences {
  cardOpacity: number
  colorMode: 'system' | 'light' | 'dark'
  /** 主题色预设 id；缺省/未知一律回拾光橙。 */
  accent: string
  /** 背景预设 id；缺省/未知一律回折光。 */
  background: string
}

/**
 * 背景预设。每套浅 / 深各一张 16:9 位图，图片 URL 只写在 styles.css（`--bg-<id>-light/dark`），
 * 这里只维护 id 与文案；选中非默认预设时 `<html data-background>` 切换两张图，
 * 深浅切换仍由既有的 color-mode 规则决定。选默认 = 移除属性，样式表仍是唯一事实源。
 */
export interface BackgroundPreset {
  id: string
  label: string
  /** 一句话画面描述，作为色卡 title。 */
  description: string
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: 'refraction', label: '折光', description: '一道玻璃光环，中间留白' },
  { id: 'aurora', label: '极光', description: '多条极光丝带斜贯整幅' },
  { id: 'mesh', label: '流体', description: '大块色域互相渗染' },
  { id: 'prism', label: '棱镜', description: '几束硬边彩光斜切交叠' }
] as const

export const DEFAULT_BACKGROUND_ID = BACKGROUND_PRESETS[0]!.id

/**
 * 主题色预设。基色进派生链（--accent-soft/wash/border 与焦点环由 color-mix 自动跟随），
 * 深读 / 明亮两组锚点逐色人工校过浅深双主题对比度——不做运行时对比度计算。
 * 色相刻意避开状态色语义区间（绿=健康、蓝=运行、琥珀=阻塞、红=错误）：
 * 黛蓝取灰调钢蓝与运行态的鲜亮长春花蓝拉开，胭脂取洋红向与错误红拉开。
 * 拾光橙的锚点与 claude-theme.css / styles.css 出厂值逐字一致：选默认 = 移除覆盖，
 * 样式表仍是唯一事实源。
 */
export interface AccentPreset {
  id: string
  label: string
  /** 基色（浅深共用），覆盖 --anthropic-orange。 */
  base: string
  /** --accent-deep 的 [浅色, 深色] 锚点（文本级强调）。 */
  deep: readonly [string, string]
  /** --accent-bright 的 [浅色, 深色] 锚点。 */
  bright: readonly [string, string]
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'sg-orange', label: '拾光橙', base: '#ff6b35', deep: ['#dc4718', '#ff8a61'], bright: ['#ff6b35', '#ff8056'] },
  { id: 'dai-blue', label: '黛蓝', base: '#4173b3', deep: ['#31609c', '#93b6e4'], bright: ['#4173b3', '#6d99cf'] },
  { id: 'bamboo-teal', label: '竹月', base: '#2e8fa3', deep: ['#1f7386', '#82c6d5'], bright: ['#2e8fa3', '#57aebf'] },
  { id: 'luoshen-violet', label: '洛神紫', base: '#9c59cf', deep: ['#8140b4', '#c5a0e9'], bright: ['#9c59cf', '#b47fdd'] },
  { id: 'rouge-rose', label: '胭脂', base: '#cf4f8e', deep: ['#b03674', '#e69cc3'], bright: ['#cf4f8e', '#dd77a9'] },
  { id: 'ink-jade', label: '墨玉', base: '#5f6f80', deep: ['#48586a', '#adbccb'], bright: ['#5f6f80', '#8595a6'] }
] as const

export const DEFAULT_ACCENT_ID = ACCENT_PRESETS[0]!.id

export const APPEARANCE_STORAGE_KEY = 'shiguang.appearance.v1'
export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  cardOpacity: 0.9,
  colorMode: 'system',
  accent: DEFAULT_ACCENT_ID,
  background: DEFAULT_BACKGROUND_ID
}

export function normalizeColorMode(value: unknown): AppearancePreferences['colorMode'] {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function normalizeAccent(value: unknown): string {
  return typeof value === 'string' && ACCENT_PRESETS.some((preset) => preset.id === value) ? value : DEFAULT_ACCENT_ID
}

export function normalizeBackground(value: unknown): string {
  return typeof value === 'string' && BACKGROUND_PRESETS.some((preset) => preset.id === value) ? value : DEFAULT_BACKGROUND_ID
}

/**
 * 离散换肤（主题色 / 背景 / 深浅模式）适合 View Transition 全站交叉淡化；
 * 透明度滑杆连续拖动不拍快照——高频调用 transition 会掉帧。
 */
export function isDiscreteAppearanceChange(patch: Partial<AppearancePreferences>): boolean {
  return 'accent' in patch || 'background' in patch || 'colorMode' in patch
}

export function normalizeCardOpacity(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE_PREFERENCES.cardOpacity
  return Math.min(1, Math.max(0, Math.round(numeric * 100) / 100))
}

export function readAppearancePreferences(storage?: Pick<Storage, 'getItem'>): AppearancePreferences {
  try {
    const source = storage ?? window.localStorage
    const saved = source.getItem(APPEARANCE_STORAGE_KEY)
    if (!saved) return DEFAULT_APPEARANCE_PREFERENCES
    const parsed = JSON.parse(saved) as Partial<AppearancePreferences>
    return {
      cardOpacity: normalizeCardOpacity(parsed.cardOpacity),
      colorMode: normalizeColorMode(parsed.colorMode),
      accent: normalizeAccent(parsed.accent),
      background: normalizeBackground(parsed.background)
    }
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES
  }
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root?: Pick<HTMLElement, 'style' | 'dataset'>
): void {
  const target = root ?? document.documentElement
  const cardOpacity = normalizeCardOpacity(preferences.cardOpacity)
  target.style.setProperty('--card-opacity', cardOpacity.toFixed(2))
  target.dataset.cardTransparency = cardOpacity === 0 ? 'clear' : cardOpacity < 0.5 ? 'light' : 'solid'
  target.dataset.colorMode = normalizeColorMode(preferences.colorMode)
  const background = normalizeBackground(preferences.background)
  // 默认背景：移除属性，styles.css 的出厂两张图保持唯一事实源。
  if (background === DEFAULT_BACKGROUND_ID) delete target.dataset.background
  else target.dataset.background = background
  const preset = ACCENT_PRESETS.find((candidate) => candidate.id === normalizeAccent(preferences.accent)) ?? ACCENT_PRESETS[0]!
  if (preset.id === DEFAULT_ACCENT_ID) {
    // 默认主题：移除覆盖，claude-theme.css / styles.css 保持唯一事实源。
    target.style.removeProperty('--anthropic-orange')
    target.style.removeProperty('--accent-deep')
    target.style.removeProperty('--accent-bright')
  } else {
    target.style.setProperty('--anthropic-orange', preset.base)
    target.style.setProperty('--accent-deep', `light-dark(${preset.deep[0]}, ${preset.deep[1]})`)
    target.style.setProperty('--accent-bright', `light-dark(${preset.bright[0]}, ${preset.bright[1]})`)
  }
}

export function persistAppearancePreferences(
  preferences: AppearancePreferences,
  storage?: Pick<Storage, 'setItem'>
): void {
  try {
    const target = storage ?? window.localStorage
    target.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
      cardOpacity: normalizeCardOpacity(preferences.cardOpacity),
      colorMode: normalizeColorMode(preferences.colorMode),
      accent: normalizeAccent(preferences.accent),
      background: normalizeBackground(preferences.background)
    }))
  } catch {
    // Appearance still applies for the current process when persistent storage is unavailable.
  }
}
