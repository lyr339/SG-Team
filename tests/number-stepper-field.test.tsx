// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NumberStepperField } from '../src/renderer/src/lobby/NumberStepperField'

describe('NumberStepperField 数值步进输入', () => {
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

  type Props = Parameters<typeof NumberStepperField>[0]
  const propsFor = (overrides: Partial<Props> = {}): Props => ({
    value: 10,
    min: 0.5,
    max: 60,
    step: 0.5,
    unit: '秒',
    label: '倒计时秒数',
    onChange: () => {},
    ...overrides
  })

  const render = async (props: Props): Promise<void> => {
    await act(async () => root.render(<NumberStepperField {...props} />))
  }

  const input = (): HTMLInputElement => container.querySelector<HTMLInputElement>('input[role="spinbutton"]')!
  const decreaseButton = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[aria-label="减少"]')!
  const increaseButton = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[aria-label="增加"]')!

  const pointerDown = async (button: HTMLButtonElement): Promise<void> => {
    await act(async () => button.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true })))
  }
  const pointerUp = async (button: HTMLButtonElement): Promise<void> => {
    await act(async () => button.dispatchEvent(new window.Event('pointerup', { bubbles: true, cancelable: true })))
  }

  it('展示格式化值与单位，暴露 spinbutton 语义', async () => {
    await render(propsFor({ value: 10.5 }))
    expect(input().value).toBe('10.5')
    expect(input().getAttribute('aria-valuemin')).toBe('0.5')
    expect(input().getAttribute('aria-valuemax')).toBe('60')
    expect(input().getAttribute('aria-valuenow')).toBe('10.5')
    expect(container.textContent).toContain('秒')
    // 整数值不带无意义尾零
    await render(propsFor({ value: 10 }))
    expect(input().value).toBe('10')
  })

  it('点按 − / + 按步进增减；到边界时对应按钮禁用', async () => {
    const onChange = vi.fn()
    await render(propsFor({ value: 10, onChange }))
    await pointerDown(increaseButton())
    expect(onChange).toHaveBeenLastCalledWith(10.5)
    await pointerUp(increaseButton())
    await pointerDown(decreaseButton())
    expect(onChange).toHaveBeenLastCalledWith(9.5)
    await pointerUp(decreaseButton())

    // 边界：min 时 − 禁用，max 时 + 禁用
    await render(propsFor({ value: 0.5, onChange }))
    expect(decreaseButton().disabled).toBe(true)
    expect(increaseButton().disabled).toBe(false)
    await render(propsFor({ value: 60, onChange }))
    expect(increaseButton().disabled).toBe(true)
    expect(decreaseButton().disabled).toBe(false)
  })

  it('长按连续步进：400ms 后每 80ms 重复，松开即停', async () => {
    vi.useFakeTimers()
    try {
      let value = 10
      const onChange = vi.fn((next: number) => { value = next })
      await render(propsFor({ value, onChange }))
      await pointerDown(increaseButton())
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenLastCalledWith(10.5)

      // 长按期间父级以新值重渲染（受控回环）
      await act(async () => {
        root.render(<NumberStepperField {...propsFor({ value, onChange })} />)
        vi.advanceTimersByTime(400)
      })
      await act(async () => {
        root.render(<NumberStepperField {...propsFor({ value, onChange })} />)
        vi.advanceTimersByTime(160)
      })
      expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3)

      const callsBeforeRelease = onChange.mock.calls.length
      await pointerUp(increaseButton())
      await act(async () => vi.advanceTimersByTime(1_000))
      expect(onChange.mock.calls.length).toBe(callsBeforeRelease)
    } finally {
      vi.useRealTimers()
    }
  })

  it('直接输入：Enter 提交钳制并对齐步进；失焦同样提交', async () => {
    const onChange = vi.fn()
    await render(propsFor({ value: 10, onChange }))

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      input().focus()
      setter.call(input(), '12.3')
      input().dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    // 编辑态原样显示草稿，不被父级值覆盖
    expect(input().value).toBe('12.3')
    await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    // 12.3 对齐到 0.5 网格 = 12.5
    expect(onChange).toHaveBeenCalledWith(12.5)

    await act(async () => {
      input().focus()
      setter.call(input(), '999')
      input().dispatchEvent(new window.Event('input', { bubbles: true }))
      input().blur()
    })
    // 超出 max 钳制到 60
    expect(onChange).toHaveBeenLastCalledWith(60)
  })

  it('无效输入与 Escape 都还原为当前值，不触发 onChange', async () => {
    const onChange = vi.fn()
    await render(propsFor({ value: 10, onChange }))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

    await act(async () => {
      input().focus()
      setter.call(input(), 'abc')
      input().dispatchEvent(new window.Event('input', { bubbles: true }))
      input().blur()
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('10')

    await act(async () => {
      input().focus()
      setter.call(input(), '25')
      input().dispatchEvent(new window.Event('input', { bubbles: true }))
      input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('10')
  })

  it('键盘 ↑ / ↓ 直接步进并退出编辑态', async () => {
    const onChange = vi.fn()
    await render(propsFor({ value: 10, onChange }))
    await act(async () => input().focus())
    await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })))
    expect(onChange).toHaveBeenLastCalledWith(10.5)
    await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(onChange).toHaveBeenLastCalledWith(9.5)
  })

  it('disabled 时输入框与按钮全部禁用', async () => {
    await render(propsFor({ disabled: true }))
    expect(input().disabled).toBe(true)
    expect(decreaseButton().disabled).toBe(true)
    expect(increaseButton().disabled).toBe(true)
  })

  it('键盘 Space/Enter 派发的 click（detail=0）可步进；鼠标 click 不双步进', async () => {
    const onChange = vi.fn()
    await render(propsFor({ value: 10, onChange }))

    // 键盘激活：click 事件 detail 为 0
    await act(async () => increaseButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(10.5)

    // 鼠标激活序列：pointerdown 已步进一次，随后的 click（detail=1）不得再步进
    await pointerDown(increaseButton())
    await pointerUp(increaseButton())
    await act(async () => increaseButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith(10.5)
  })
})
