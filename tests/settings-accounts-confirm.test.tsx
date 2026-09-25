// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAccounts } from '../src/renderer/src/settings/SettingsAccounts'
import type { CursorAccountMetadata } from '../src/domain/cursor-account'

/**
 * 账号行的二次确认与切换进度反馈。
 * 二次确认是一个转瞬的提问：整张列表同一时刻只问一件事，Esc / 点别处 / 10s 未决都收回；
 * 「切换中…」只落在发起切换的那一行，其他行只是禁用、文案不变。
 */
describe('账号行：二次确认与切换反馈', () => {
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
    vi.useRealTimers()
  })

  const accounts: CursorAccountMetadata[] = [
    { id: 'acc-a', label: 'a@x.co', maskedToken: '••••aaaa', active: true, createdAt: 0, updatedAt: 0 },
    { id: 'acc-b', label: 'b@x.co', maskedToken: '••••bbbb', active: false, createdAt: 0, updatedAt: 0 },
    { id: 'acc-c', label: 'c@x.co', maskedToken: '••••cccc', active: false, createdAt: 0, updatedAt: 0 }
  ]

  type Props = Parameters<typeof SettingsAccounts>[0]
  const propsFor = (overrides: Partial<Props> = {}): Props => ({
    accounts,
    busy: false,
    onSave: async () => {},
    onSelect: async () => {},
    onRemove: async () => {},
    onRestartWithAccount: async () => {},
    onSwitchLiveAccount: async () => {},
    switchPumpStatus: { kind: 'installed', managed: false, message: '兼容可用', config: { port: 51_824, key: 'key', revision: 2 } },
    ...overrides
  })
  const render = async (overrides: Partial<Props> = {}): Promise<void> => {
    await act(async () => root.render(<SettingsAccounts {...propsFor(overrides)} />))
  }

  const row = (index: number): HTMLElement => container.querySelectorAll<HTMLElement>('.account-row')[index]!
  const button = (index: number, selector: string): HTMLButtonElement => row(index).querySelector<HTMLButtonElement>(selector)!
  const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
  const confirming = (): number => container.querySelectorAll('.account-row__actions .is-confirming').length

  it('同一时刻只有一个待确认：再点另一枚会顶掉前一个', async () => {
    const onRemove = vi.fn(async () => {})
    await render({ onRemove })

    await click(button(1, '.account-remove'))
    expect(button(1, '.account-remove').textContent).toBe('确认')
    expect(confirming()).toBe(1)

    await click(button(2, '.lobby-account__inject'))
    expect(button(2, '.lobby-account__inject').textContent).toBe('确认重启')
    expect(button(1, '.account-remove').textContent).toBe('删除')
    expect(confirming()).toBe(1)
    expect(onRemove).not.toHaveBeenCalled()

    // 顶掉后的那一枚要重新走两步，不会因为之前点过一次就直接执行。
    await click(button(1, '.account-remove'))
    expect(onRemove).not.toHaveBeenCalled()
    await click(button(1, '.account-remove'))
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('acc-b')
    expect(confirming()).toBe(0)
  })

  it('Esc 与点在待确认按钮之外都会收回；按在待确认按钮自身上不收回', async () => {
    const onRestart = vi.fn(async () => {})
    await render({ onRestartWithAccount: onRestart })

    await click(button(1, '.lobby-account__inject'))
    expect(confirming()).toBe(1)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(confirming()).toBe(0)
    expect(button(1, '.lobby-account__inject').textContent).toBe('切换并重启')

    await click(button(1, '.lobby-account__inject'))
    // 真实点击先有 pointerdown：落在待确认按钮上不收回，随后的 click 才是确认。
    await act(async () => { button(1, '.lobby-account__inject').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(confirming()).toBe(1)
    await act(async () => { row(0).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(confirming()).toBe(0)
    expect(onRestart).not.toHaveBeenCalled()
  })

  it('10 秒未决自动收回；再点一次重新计时', async () => {
    vi.useFakeTimers()
    await render()

    await click(button(1, '.account-remove'))
    await act(async () => { vi.advanceTimersByTime(9_000) })
    expect(button(1, '.account-remove').textContent).toBe('确认')

    // 换成另一枚：计时从头开始。
    await click(button(2, '.account-remove'))
    await act(async () => { vi.advanceTimersByTime(9_000) })
    expect(button(2, '.account-remove').textContent).toBe('确认')
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(button(2, '.account-remove').textContent).toBe('删除')
    expect(confirming()).toBe(0)
  })

  it('「切换中…」只落在发起切换的那一行，其他行禁用但文案不变；busy 归零即复原', async () => {
    const onSwitchLiveAccount = vi.fn(async () => {})
    await render({ onSwitchLiveAccount })

    await click(button(1, '.account-switch-live'))
    expect(onSwitchLiveAccount).toHaveBeenCalledExactlyOnceWith('acc-b')
    // 宿主随即置忙（真实 App 里与点击同一批次渲染）。
    await render({ onSwitchLiveAccount, busy: true })
    expect(button(1, '.account-switch-live').textContent).toBe('切换中…')
    expect(button(1, '.account-switch-live').className).toContain('is-busy')
    expect(button(2, '.account-switch-live').textContent).toBe('无感切换')
    expect(button(2, '.account-switch-live').disabled).toBe(true)
    expect(button(2, '.lobby-account__inject').textContent).toBe('切换并重启')

    await render({ onSwitchLiveAccount, busy: false })
    expect(button(1, '.account-switch-live').textContent).toBe('无感切换')
    expect(button(1, '.account-switch-live').className).not.toContain('is-busy')

    // 其他原因置忙（如删除、导入）时没有任何一行显示「切换中…」。
    await render({ onSwitchLiveAccount, busy: true })
    expect(container.textContent).not.toContain('切换中…')
  })

  it('确认重启后只有那一行显示「切换中…」', async () => {
    const onRestartWithAccount = vi.fn(async () => {})
    await render({ onRestartWithAccount })

    await click(button(2, '.lobby-account__inject'))
    await click(button(2, '.lobby-account__inject'))
    expect(onRestartWithAccount).toHaveBeenCalledExactlyOnceWith('acc-c')
    await render({ onRestartWithAccount, busy: true })
    expect(button(2, '.lobby-account__inject').textContent).toBe('切换中…')
    expect(button(1, '.lobby-account__inject').textContent).toBe('切换并重启')
    expect(button(0, '.lobby-account__inject').textContent).toBe('切换并重启')
    expect(confirming()).toBe(0)
  })
})
