// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAccounts } from '../src/renderer/src/settings/SettingsAccounts'
import { SettingsAutomation } from '../src/renderer/src/settings/SettingsAutomation'
import type { AccountAutomationSettings } from '../src/domain/account-automation'
import { DEFAULT_CURSOR_CHECKOUT_PROFILE } from '../src/domain/cursor-checkout-profile'
import type { CursorAccountMetadata } from '../src/domain/cursor-account'

describe('升级 Pro：账号卡片按钮 + 自动化页账单资料表单', () => {
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

  const account: CursorAccountMetadata = {
    id: 'acc-1',
    label: 'free@example.com',
    maskedToken: '••••abcd',
    active: true,
    createdAt: 0,
    updatedAt: 0
  }

  type AccountsProps = Parameters<typeof SettingsAccounts>[0]
  const accountsPropsFor = (overrides: Partial<AccountsProps> = {}): AccountsProps => ({
    accounts: [account],
    busy: false,
    onSave: async () => {},
    onSelect: async () => {},
    onRemove: async () => {},
    ...overrides
  })

  const automationSettingsFor = (overrides: Partial<AccountAutomationSettings> = {}): AccountAutomationSettings => ({
    enabled: false,
    delaySec: 30,
    postProcessDelaySec: 30,
    checkoutProfile: { ...DEFAULT_CURSOR_CHECKOUT_PROFILE },
    ...overrides
  })

  type AutomationProps = Parameters<typeof SettingsAutomation>[0]
  const automationPropsFor = (overrides: Partial<AutomationProps> = {}): AutomationProps => ({
    accounts: [],
    automationSettings: automationSettingsFor(),
    onSaveAutomationSettings: async () => {},
    ...overrides
  })

  const renderAccounts = async (props: AccountsProps): Promise<void> => {
    await act(async () => root.render(<SettingsAccounts {...props} />))
  }
  const renderAutomation = async (props: AutomationProps): Promise<void> => {
    await act(async () => root.render(<SettingsAutomation {...props} />))
  }

  // 「升级 Pro」是次要动作，收在账号卡操作行的「⋯」里（弹层 portal 到 document.body）。
  const menuTrigger = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.account-actions-menu__trigger')
  const openMenu = async (): Promise<void> => { await act(async () => menuTrigger()!.click()) }
  const menuItem = (text: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>('.account-actions-menu button')]
      .find((button) => button.textContent?.includes(text))

  const checkoutInput = (label: string): HTMLInputElement => {
    const span = [...container.querySelectorAll<HTMLSpanElement>('.settings-checkout-form label > span')]
      .find((el) => el.textContent === label)
    if (!span) throw new Error(`未找到账单资料字段：${label}`)
    return span.parentElement!.querySelector('input')!
  }

  const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  it('账号卡片：「⋯」里点「升级 Pro」按账号粒度置忙并把账号 id 交给回调', async () => {
    let release!: () => void
    const onStartProUpgrade = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    await renderAccounts(accountsPropsFor({ onStartProUpgrade }))

    await openMenu()
    const item = menuItem('升级 Pro')!
    expect(item).not.toBeUndefined()
    expect(item.disabled).toBe(false)
    await act(async () => item.click())

    expect(onStartProUpgrade).toHaveBeenCalledTimes(1)
    expect(onStartProUpgrade).toHaveBeenCalledWith('acc-1')
    // 菜单收起，进度文案提到触发器上——不点开也看得见在跑。
    expect(document.body.querySelector('.account-actions-menu')).toBeNull()
    expect(menuTrigger()!.textContent).toBe('结账中…')
    expect(menuTrigger()!.disabled).toBe(true)

    await act(async () => release())
    expect(menuTrigger()!.disabled).toBe(false)
    await openMenu()
    expect(menuItem('升级 Pro')!.disabled).toBe(false)
  })

  it('账号卡片：未提供回调时连「⋯」都不渲染；结果反馈亮在账号区', async () => {
    await renderAccounts(accountsPropsFor())
    expect(menuTrigger()).toBeNull()

    await renderAccounts(accountsPropsFor({
      onStartProUpgrade: async () => {},
      proUpgradeFeedback: { ok: true, message: '结账页已提交，请在指纹浏览器窗口中用支付宝扫码完成付款' }
    }))
    expect(container.querySelector('.account-aozai__ok')?.textContent).toContain('扫码完成付款')

    await renderAccounts(accountsPropsFor({
      onStartProUpgrade: async () => {},
      proUpgradeFeedback: { ok: false, message: '账单资料不完整（缺邮编）' }
    }))
    expect(container.querySelector('.account-aozai__fail')?.textContent).toContain('缺邮编')
  })

  it('账单资料表单：字段受控于设置，编辑即保存（其余字段保持不变）', async () => {
    const onSaveAutomationSettings = vi.fn().mockResolvedValue(undefined)
    await renderAutomation(automationPropsFor({ onSaveAutomationSettings }))

    expect(checkoutInput('账单姓名').value).toBe('Li Ming')
    expect(checkoutInput('省份').value).toBe('湖北省')
    expect(checkoutInput('地址行 2（可选）').value).toBe('')

    await typeInto(checkoutInput('城市'), '长沙市')
    expect(onSaveAutomationSettings).toHaveBeenCalledTimes(1)
    expect(onSaveAutomationSettings).toHaveBeenCalledWith(expect.objectContaining({
      checkoutProfile: { ...DEFAULT_CURSOR_CHECKOUT_PROFILE, city: '长沙市' }
    }))
  })

  it('账单资料表单：缺字段亮警示（报出缺项），完整时亮可发起提示', async () => {
    await renderAutomation(automationPropsFor({
      automationSettings: automationSettingsFor({
        checkoutProfile: { ...DEFAULT_CURSOR_CHECKOUT_PROFILE, postalCode: '' }
      })
    }))
    expect(container.querySelector('.settings-add-form__warn')?.textContent).toContain('缺邮编')

    await renderAutomation(automationPropsFor())
    expect(container.querySelector('.settings-add-form__warn')).toBeNull()
    expect(container.querySelector('.settings-add-form__ok')?.textContent).toContain('资料完整')
  })

  it('账单资料表单：无设置或保存回调时不渲染（不受奥仔卡密状态影响）', async () => {
    await renderAutomation(automationPropsFor({ automationSettings: undefined }))
    expect(container.querySelector('.settings-checkout-form')).toBeNull()

    // 奥仔未就绪（自动化控制区收起为提示），账单资料区仍可用
    await renderAutomation(automationPropsFor({ aozaiStatus: { saved: false } }))
    expect(container.querySelector('.settings-checkout-form')).not.toBeNull()
  })
})
