// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAozai } from '../src/renderer/src/settings/SettingsAozai'

describe('奥仔手动处理区', () => {
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

  type Props = Parameters<typeof SettingsAozai>[0]
  const propsFor = (overrides: Partial<Props> = {}): Props => ({
    aozaiStatus: { saved: true, maskedCode: '••••card', type: '次卡', remaining: 5 },
    aozaiBusy: false,
    onSaveAozaiCard: async () => {},
    onClearAozaiCard: async () => {},
    onRefreshAozaiBalance: async () => {},
    onProcessAozaiToken: async () => {},
    ...overrides
  })

  const render = async (props: Props): Promise<void> => {
    await act(async () => root.render(<SettingsAozai {...props} />))
  }

  const manualTextarea = (): HTMLTextAreaElement =>
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="手动处理的 Session Token"]')!
  const manualButton = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.account-aozai__manual button')!

  const typeToken = async (value: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(manualTextarea(), value)
      manualTextarea().dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  it('提交时把 trim 后的 token 交给回调并清空输入框', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined)
    await render(propsFor({ onProcessAozaiToken: onProcess }))

    await typeToken('  user_abc::jwt-token  ')
    expect(manualButton().disabled).toBe(false)
    await act(async () => manualButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(onProcess).toHaveBeenCalledTimes(1)
    expect(onProcess).toHaveBeenCalledWith('user_abc::jwt-token')
    expect(manualTextarea().value).toBe('')
  })

  it('空 token 与空白 token 都不可提交', async () => {
    const onProcess = vi.fn()
    await render(propsFor({ onProcessAozaiToken: onProcess }))

    expect(manualButton().disabled).toBe(true)
    await typeToken('   ')
    expect(manualButton().disabled).toBe(true)
    expect(onProcess).not.toHaveBeenCalled()
  })

  it('busy 时输入框与按钮一并禁用', async () => {
    await render(propsFor({ aozaiBusy: true }))
    expect(manualTextarea().disabled).toBe(true)
    expect(manualButton().disabled).toBe(true)
    expect(manualButton().textContent).toBe('处理中…')
  })

  it('busy 时 ⌘/Ctrl+Enter 快捷键同样被拦截（快捷键不经过按钮 disabled）', async () => {
    const onProcess = vi.fn()
    // 先在非 busy 态输入 token，再切到 busy 态按快捷键
    await render(propsFor({ onProcessAozaiToken: onProcess }))
    await typeToken('user_abc::jwt-token')
    await act(async () => root.render(<SettingsAozai {...propsFor({ onProcessAozaiToken: onProcess, aozaiBusy: true })} />))
    await act(async () => {
      manualTextarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(onProcess).not.toHaveBeenCalled()
  })

  it('回调失败时保留输入框内容（错误由父级展示）', async () => {
    const onProcess = vi.fn().mockRejectedValue(new Error('网络错误'))
    await render(propsFor({ onProcessAozaiToken: onProcess }))

    await typeToken('user_abc::jwt-token')
    await act(async () => manualButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(onProcess).toHaveBeenCalledTimes(1)
    expect(manualTextarea().value).toBe('user_abc::jwt-token')
  })

  it('无卡密或缺少回调时不渲染手动区', async () => {
    await render(propsFor({ aozaiStatus: { saved: false } }))
    expect(container.querySelector('.account-aozai__manual')).toBeNull()

    await act(async () => root.render(<SettingsAozai {...propsFor({ onProcessAozaiToken: undefined })} />))
    expect(container.querySelector('.account-aozai__manual')).toBeNull()
  })
})
