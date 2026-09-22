// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAozai } from '../src/renderer/src/settings/SettingsAozai'

describe('处理服务设置', () => {
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
    processingStatuses: {
      aozai: { providerId: 'aozai', label: '奥仔', saved: true, maskedCode: '••••card', unit: 'points', remaining: 87, capacity: 100, costPerOperation: 3 },
      henxin: { providerId: 'henxin', label: '痕心', saved: true, maskedCode: '••••CA23', unit: 'uses', remaining: 5, capacity: 5, costPerOperation: 1 }
    },
    processingBusy: false,
    automationSettings: { enabled: false, delaySec: 10, postProcessDelaySec: 10, processingProvider: 'aozai' },
    onSaveAutomationSettings: () => {},
    onSaveProcessingCredential: async () => {},
    onClearProcessingCredential: async () => {},
    onRefreshProcessingBalance: async () => {},
    onProcessToken: async () => {},
    ...overrides
  })

  const render = async (props: Props): Promise<void> => {
    await act(async () => root.render(<SettingsAozai {...props} />))
  }
  const manualTextarea = (): HTMLTextAreaElement =>
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="手动处理的 Session Token"]')!
  const manualButton = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.account-aozai__manual-input button')!
  const typeToken = async (value: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(manualTextarea(), value)
      manualTextarea().dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  it('提交时携带所选服务商并清空输入框', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined)
    await render(propsFor({ onProcessToken: onProcess }))
    await typeToken('  user_abc::jwt-token  ')
    await act(async () => manualButton().click())
    expect(onProcess).toHaveBeenCalledWith('aozai', 'user_abc::jwt-token')
    expect(manualTextarea().value).toBe('')
  })

  it('空 token 不可提交；busy 时输入和快捷键均被拦截', async () => {
    const onProcess = vi.fn()
    await render(propsFor({ onProcessToken: onProcess }))
    expect(manualButton().disabled).toBe(true)
    await typeToken('user_abc::jwt-token')
    await act(async () => root.render(<SettingsAozai {...propsFor({ onProcessToken: onProcess, processingBusy: true })} />))
    expect(manualTextarea().disabled).toBe(true)
    expect(manualButton().disabled).toBe(true)
    await act(async () => manualTextarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })))
    expect(onProcess).not.toHaveBeenCalled()
  })

  it('回调失败时保留 Token', async () => {
    const onProcess = vi.fn().mockRejectedValue(new Error('网络错误'))
    await render(propsFor({ onProcessToken: onProcess }))
    await typeToken('user_abc::jwt-token')
    await act(async () => manualButton().click())
    expect(manualTextarea().value).toBe('user_abc::jwt-token')
  })

  it('奥仔显示服务端点数与动态单价，字段缺失时不猜固定值', async () => {
    await render(propsFor())
    expect(container.textContent).toContain('剩余 87 点')
    expect(container.textContent).toContain('每次 3 点')

    const statuses = propsFor().processingStatuses!
    await render(propsFor({ processingStatuses: { ...statuses, aozai: { ...statuses.aozai, costPerOperation: undefined } } }))
    expect(container.textContent).toContain('单次扣费以服务端为准')
  })

  it('切换痕心时保存设置，显示次数余额和单会话说明', async () => {
    const onSave = vi.fn()
    await render(propsFor({ onSaveAutomationSettings: onSave }))
    const henxin = [...container.querySelectorAll<HTMLButtonElement>('.processing-provider-tabs button')]
      .find((button) => button.textContent?.includes('痕心'))!
    await act(async () => henxin.click())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ processingProvider: 'henxin' }))

    await render(propsFor({ automationSettings: { enabled: false, delaySec: 10, postProcessDelaySec: 10, processingProvider: 'henxin' } }))
    expect(container.textContent).toContain('剩余 5 次')
    expect(container.textContent).toContain('单网页会话')
    expect(manualButton().textContent).toBe('提交给痕心')
  })

  it('所选服务未保存卡密或缺少回调时不渲染手动区', async () => {
    const statuses = propsFor().processingStatuses!
    await render(propsFor({ processingStatuses: { ...statuses, aozai: { providerId: 'aozai', label: '奥仔', unit: 'points', saved: false } } }))
    expect(container.querySelector('.account-aozai__manual')).toBeNull()
    await render(propsFor({ onProcessToken: undefined }))
    expect(container.querySelector('.account-aozai__manual')).toBeNull()
  })
})
