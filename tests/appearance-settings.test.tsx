// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from '../src/renderer/src/AppearanceSettings'
import {
  ACCENT_PRESETS,
  APPEARANCE_STORAGE_KEY,
  applyAppearancePreferences,
  isDiscreteAppearanceChange,
  normalizeAccent,
  normalizeCardOpacity,
  persistAppearancePreferences,
  readAppearancePreferences
} from '../src/renderer/src/appearance-preferences'

describe('appearance preferences', () => {
  it('normalizes, persists and reapplies card opacity', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }

    expect(normalizeCardOpacity(-1)).toBe(0)
    expect(normalizeCardOpacity(1.4)).toBe(1)
    expect(normalizeCardOpacity(0.456)).toBe(0.46)

    persistAppearancePreferences({ cardOpacity: 0.46, colorMode: 'dark', accent: 'dai-blue' }, storage)
    expect(values.has(APPEARANCE_STORAGE_KEY)).toBe(true)
    expect(readAppearancePreferences(storage)).toEqual({ cardOpacity: 0.46, colorMode: 'dark', accent: 'dai-blue' })

    const root = document.createElement('div')
    applyAppearancePreferences({ cardOpacity: 0, colorMode: 'light', accent: 'sg-orange' }, root)
    expect(root.style.getPropertyValue('--card-opacity')).toBe('0.00')
    expect(root.dataset.cardTransparency).toBe('clear')
    expect(root.dataset.colorMode).toBe('light')
  })

  it('主题色：未知 id 回默认；旧存档缺字段回默认（向后兼容）', () => {
    expect(normalizeAccent('dai-blue')).toBe('dai-blue')
    expect(normalizeAccent('neon-pink')).toBe('sg-orange')
    expect(normalizeAccent(undefined)).toBe('sg-orange')
    const storage = {
      getItem: () => JSON.stringify({ cardOpacity: 0.9, colorMode: 'system' }) // v1 旧档无 accent
    }
    expect(readAppearancePreferences(storage).accent).toBe('sg-orange')
  })

  it('主题色应用：非默认预设写三个覆盖变量，切回默认逐一移除（样式表回归唯一事实源）', () => {
    const root = document.createElement('div')
    applyAppearancePreferences({ cardOpacity: 0.9, colorMode: 'system', accent: 'luoshen-violet' }, root)
    const violet = ACCENT_PRESETS.find((preset) => preset.id === 'luoshen-violet')!
    expect(root.style.getPropertyValue('--anthropic-orange')).toBe(violet.base)
    expect(root.style.getPropertyValue('--accent-deep')).toBe(`light-dark(${violet.deep[0]}, ${violet.deep[1]})`)
    expect(root.style.getPropertyValue('--accent-bright')).toBe(`light-dark(${violet.bright[0]}, ${violet.bright[1]})`)

    applyAppearancePreferences({ cardOpacity: 0.9, colorMode: 'system', accent: 'sg-orange' }, root)
    expect(root.style.getPropertyValue('--anthropic-orange')).toBe('')
    expect(root.style.getPropertyValue('--accent-deep')).toBe('')
    expect(root.style.getPropertyValue('--accent-bright')).toBe('')
  })

  it('预设色板：默认拾光橙打头且锚点与出厂值逐字一致；数量在 6~8 之间', () => {
    expect(ACCENT_PRESETS[0]).toMatchObject({
      id: 'sg-orange',
      base: '#ff6b35',
      deep: ['#dc4718', '#ff8a61'],
      bright: ['#ff6b35', '#ff8056']
    })
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(ACCENT_PRESETS.length).toBeLessThanOrEqual(8)
    // id 唯一
    expect(new Set(ACCENT_PRESETS.map((preset) => preset.id)).size).toBe(ACCENT_PRESETS.length)
  })

  it('离散换肤判定：主题色与深浅模式走 View Transition，透明度拖杆不拍快照', () => {
    expect(isDiscreteAppearanceChange({ accent: 'dai-blue' })).toBe(true)
    expect(isDiscreteAppearanceChange({ colorMode: 'dark' })).toBe(true)
    expect(isDiscreteAppearanceChange({ accent: 'ink-jade', colorMode: 'light' })).toBe(true)
    expect(isDiscreteAppearanceChange({ cardOpacity: 0.45 })).toBe(false)
    expect(isDiscreteAppearanceChange({})).toBe(false)
  })
})

describe('AppearanceSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('offers a true zero-opacity state and reports live slider changes', async () => {
    const onChange = vi.fn<(value: number) => void>()
    const onColorModeChange = vi.fn<(value: 'system' | 'light' | 'dark') => void>()
    await act(async () => {
      root.render(
        <AppearanceSettings
          cardOpacity={0.9}
          colorMode="system"
          onCardOpacityChange={onChange}
          onColorModeChange={onColorModeChange}
          onClose={() => {}}
        />
      )
    })

    const slider = container.querySelector<HTMLInputElement>('#card-opacity')!
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('100')
    expect(container.textContent).toContain('完全透明')

    const darkMode = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '深色')!
    await act(async () => darkMode.click())
    expect(onColorModeChange).toHaveBeenLastCalledWith('dark')

    const zeroPreset = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '通透')!
    await act(async () => zeroPreset.click())
    expect(onChange).toHaveBeenLastCalledWith(0)

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(slider, '37')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(0.37)
    // 未传 onAccentChange：主题色行不出现（老调用方零变更）。
    expect(container.querySelector('.appearance-accent')).toBeNull()
  })

  it('主题色行：渲染全部预设色卡，当前项标注 aria-pressed 并写出名字，点击回调预设 id', async () => {
    const onAccentChange = vi.fn<(accent: string) => void>()
    await act(async () => {
      root.render(
        <AppearanceSettings
          cardOpacity={0.9}
          colorMode="system"
          accent="bamboo-teal"
          onCardOpacityChange={() => {}}
          onColorModeChange={() => {}}
          onAccentChange={onAccentChange}
          onClose={() => {}}
        />
      )
    })

    const swatches = [...container.querySelectorAll<HTMLButtonElement>('.appearance-accent__swatch')]
    expect(swatches).toHaveLength(ACCENT_PRESETS.length)
    const active = swatches.filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(active).toHaveLength(1)
    expect(active[0]!.getAttribute('aria-label')).toBe('竹月')
    expect(container.querySelector('.appearance-accent em')?.textContent).toBe('竹月')

    const daiBlue = swatches.find((button) => button.getAttribute('aria-label') === '黛蓝')!
    await act(async () => daiBlue.click())
    expect(onAccentChange).toHaveBeenLastCalledWith('dai-blue')
  })

  it('主题色行：未知 id 按默认拾光橙——选中环与名字指向同一预设', async () => {
    await act(async () => {
      root.render(
        <AppearanceSettings
          cardOpacity={0.9}
          colorMode="system"
          accent="neon-pink"
          onCardOpacityChange={() => {}}
          onColorModeChange={() => {}}
          onAccentChange={() => {}}
          onClose={() => {}}
        />
      )
    })

    const active = container.querySelectorAll('.appearance-accent__swatch[aria-pressed="true"]')
    expect(active).toHaveLength(1)
    expect(active[0]!.getAttribute('aria-label')).toBe('拾光橙')
    expect(container.querySelector('.appearance-accent em')?.textContent).toBe('拾光橙')
  })

  it('主题色行：←/→ 方向键在色卡间漫游，移动即选中（环绕）', async () => {
    const onAccentChange = vi.fn<(accent: string) => void>()
    await act(async () => {
      root.render(
        <AppearanceSettings
          cardOpacity={0.9}
          colorMode="system"
          accent="sg-orange"
          onCardOpacityChange={() => {}}
          onColorModeChange={() => {}}
          onAccentChange={onAccentChange}
          onClose={() => {}}
        />
      )
    })

    const group = container.querySelector<HTMLDivElement>('.appearance-accent [role="group"]')!
    const swatches = [...container.querySelectorAll<HTMLButtonElement>('.appearance-accent__swatch')]
    const first = swatches.find((button) => button.getAttribute('aria-label') === '拾光橙')!
    const second = swatches[1]!

    // 从首项出发：→ 移到第二项并选中；← 从首项环绕到末项
    await act(async () => first.focus())
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(second)
    expect(onAccentChange).toHaveBeenLastCalledWith(ACCENT_PRESETS[1]!.id)

    await act(async () => first.focus())
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(swatches[swatches.length - 1]!)
    expect(onAccentChange).toHaveBeenLastCalledWith(ACCENT_PRESETS[ACCENT_PRESETS.length - 1]!.id)

    // 其它键不干预
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onAccentChange).toHaveBeenCalledTimes(2)
  })
})
