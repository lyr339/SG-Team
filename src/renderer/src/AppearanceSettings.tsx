import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  DEFAULT_ACCENT_ID,
  DEFAULT_BACKGROUND_ID
} from './appearance-preferences'

interface AppearanceSettingsProps {
  cardOpacity: number
  colorMode: 'system' | 'light' | 'dark'
  /** 主题色预设 id；缺省按拾光橙。 */
  accent?: string
  /** 背景预设 id；缺省按折光。 */
  background?: string
  onCardOpacityChange: (value: number) => void
  onColorModeChange: (value: 'system' | 'light' | 'dark') => void
  onAccentChange?: (accent: string) => void
  onBackgroundChange?: (background: string) => void
  onClose: () => void
}

const PRESETS = [
  { label: '通透', value: 0 },
  { label: '轻盈', value: 0.45 },
  { label: '柔和', value: 0.72 },
  { label: '实色', value: 1 }
] as const

/** 选项组惯例：←/→ 在选项间漫游（环绕），移动即选中——主题色色卡与背景缩略卡共用。 */
function roamOptionsWithArrowKeys(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
  const index = buttons.findIndex((button) => button === document.activeElement)
  if (index < 0) return
  event.preventDefault()
  const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]!.focus()
  buttons[next]!.click()
}

export function AppearanceSettings({
  cardOpacity,
  colorMode,
  accent = DEFAULT_ACCENT_ID,
  background = DEFAULT_BACKGROUND_ID,
  onCardOpacityChange,
  onColorModeChange,
  onAccentChange,
  onBackgroundChange,
  onClose
}: AppearanceSettingsProps): React.JSX.Element {
  const percentage = Math.round(cardOpacity * 100)
  // 未知 id 与默认同待遇：选中环与右侧名字始终指向同一个预设。
  const activeAccent = ACCENT_PRESETS.find((preset) => preset.id === accent) ?? ACCENT_PRESETS[0]!
  const activeBackground = BACKGROUND_PRESETS.find((preset) => preset.id === background) ?? BACKGROUND_PRESETS[0]!

  return (
    <section className="appearance-popover" aria-label="外观设置">
      <header>
        <div>
          <strong>外观</strong>
          <span>让内容保持清晰，也让背景自由透出来。</span>
        </div>
        <button onClick={onClose} aria-label="关闭外观设置">×</button>
      </header>

      <div className="appearance-mode">
        <span>显示模式</span>
        <div aria-label="显示模式">
          {([
            ['system', '跟随系统'],
            ['light', '浅色'],
            ['dark', '深色']
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={colorMode === value ? 'is-active' : ''}
              onClick={() => onColorModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {onBackgroundChange ? (
        <div className="appearance-background">
          <div>
            <span>背景</span>
            <em>{activeBackground.label}</em>
          </div>
          <div role="group" aria-label="背景" onKeyDown={roamOptionsWithArrowKeys}>
            {BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`appearance-background__tile${activeBackground.id === preset.id ? ' is-active' : ''}`}
                data-preset={preset.id}
                title={preset.description}
                aria-label={preset.label}
                aria-pressed={activeBackground.id === preset.id}
                onClick={() => onBackgroundChange(preset.id)}
              >
                <i aria-hidden="true" />
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {onAccentChange ? (
        <div className="appearance-accent">
          <div>
            <span>主题色</span>
            <em>{activeAccent.label}</em>
          </div>
          <div role="group" aria-label="主题色" onKeyDown={roamOptionsWithArrowKeys}>
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`appearance-accent__swatch${activeAccent.id === preset.id ? ' is-active' : ''}`}
                style={{ '--swatch': preset.base } as React.CSSProperties}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={activeAccent.id === preset.id}
                onClick={() => onAccentChange(preset.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="appearance-opacity">
        <div>
          <label htmlFor="card-opacity">卡片透明度</label>
          <output htmlFor="card-opacity">{percentage}%</output>
        </div>
        <input
          id="card-opacity"
          type="range"
          min="0"
          max="100"
          step="1"
          value={percentage}
          onChange={(event) => onCardOpacityChange(Number(event.currentTarget.value) / 100)}
        />
        <div className="appearance-opacity__ends" aria-hidden="true">
          <span>完全透明</span>
          <span>完全实色</span>
        </div>
      </div>

      <div className="appearance-presets" aria-label="透明度预设">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={Math.abs(cardOpacity - preset.value) < 0.01 ? 'is-active' : ''}
            onClick={() => onCardOpacityChange(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  )
}
