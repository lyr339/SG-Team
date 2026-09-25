// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAccounts } from '../src/renderer/src/settings/SettingsAccounts'
import type { CursorAccountMetadata } from '../src/domain/cursor-account'

/**
 * 账号行操作列的「⋯」溢出菜单。
 * 它存在的首要理由是布局：行内按钮数固定为 无感切换 / 切换并重启 / 删除，
 * 不再随账号状态在 4~6 个之间浮动——一行的横向预算有限，次要动作进弹层后
 * 操作列宽度可预期，常驻按钮在所有行里右缘对齐。
 */
describe('账号行：次要操作溢出菜单', () => {
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

  const account = (overrides: Partial<CursorAccountMetadata> = {}): CursorAccountMetadata => ({
    id: 'acc-1', label: 'a@x.co', maskedToken: '••••abcd', active: false, createdAt: 0, updatedAt: 0, ...overrides
  })

  type Props = Parameters<typeof SettingsAccounts>[0]
  const render = async (overrides: Partial<Props> = {}): Promise<void> => {
    const props: Props = {
      accounts: [account()],
      busy: false,
      onSave: async () => {},
      onSelect: async () => {},
      onRemove: async () => {},
      ...overrides
    }
    await act(async () => root.render(<SettingsAccounts {...props} />))
  }

  const trigger = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.account-actions-menu__trigger')
  const openMenu = async (): Promise<void> => { await act(async () => trigger()!.click()) }
  const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.account-actions-menu')
  const items = (): string[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>('.account-actions-menu button')].map((b) => b.textContent ?? '')
  const item = (text: string): HTMLButtonElement =>
    [...document.body.querySelectorAll<HTMLButtonElement>('.account-actions-menu button')]
      .find((b) => b.textContent === text)!

  const aozaiProps = {
    processingStatuses: {
      aozai: { providerId: 'aozai', label: '奥仔', unit: 'points', saved: true },
      henxin: { providerId: 'henxin', label: '痕心', unit: 'uses', saved: false }
    } as Props['processingStatuses'],
    automationSettings: { enabled: false, delaySec: 10, postProcessDelaySec: 10, processingProvider: 'aozai' as const },
    onProcessAccount: vi.fn(async () => {})
  }

  it('三个次要动作都在菜单里，行内只剩切换 / 删除；点「处理」把账号 id 交给回调并收起菜单', async () => {
    const onProcessAozaiAccount = vi.fn(async () => {})
    await render({
      accounts: [account({ hasCredentials: true })],
      onReloginAccount: async () => {},
      onStartProUpgrade: async () => {},
      onSwitchLiveAccount: async () => {},
      onRestartWithAccount: async () => {},
      processingStatuses: {
        aozai: { providerId: 'aozai', label: '奥仔', unit: 'points', saved: true, remaining: 87, costPerOperation: 3 },
        henxin: { providerId: 'henxin', label: '痕心', unit: 'uses', saved: false }
      } as Props['processingStatuses'],
      automationSettings: { enabled: false, delaySec: 10, postProcessDelaySec: 10, processingProvider: 'aozai' },
      onProcessAccount: onProcessAozaiAccount
    })

    // 行内按钮：无感切换 + 切换并重启 + 删除 + 行尾的 ⋯，恰好四个，与账号是否当前无关。
    const inline = [...container.querySelectorAll<HTMLButtonElement>('.account-row__actions > button')]
    expect(inline.map((b) => b.textContent)).toEqual(['无感切换', '切换并重启', '删除', ''])
    expect(inline[3]!.className).toContain('account-actions-menu__trigger')

    await openMenu()
    expect(items()).toEqual(['重新登录', '升级 Pro', '奥仔处理'])
    expect(item('奥仔处理').title).toContain('扣 3 点')

    await act(async () => item('奥仔处理').click())
    expect(onProcessAozaiAccount).toHaveBeenCalledWith('aozai', 'acc-1')
    expect(menu()).toBeNull()
  })

  it('当前账号与非当前账号的行内按钮数一致（少的是菜单里的「无感切换」而非行内错位）', async () => {
    const common = {
      accounts: [account({ active: false }), account({ id: 'acc-2', label: 'b@x.co', active: true })],
      onStartProUpgrade: async () => {},
      onSwitchLiveAccount: async () => {},
      onRestartWithAccount: async () => {}
    }
    await render(common)
    const rows = [...container.querySelectorAll('.account-row__actions')]
    expect(rows).toHaveLength(2)
    // 非当前行多一个最左的「无感切换」；操作列右缘锚定，常驻的 切换并重启 / 删除 / ⋯ 在两行里对齐。
    expect([...rows[0]!.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['无感切换', '切换并重启', '删除', ''])
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['切换并重启', '删除', ''])
  })

  it('没有任何次要动作时不渲染「⋯」；Escape 与点击外部都能收起菜单', async () => {
    await render({ onRestartWithAccount: async () => {} })
    expect(trigger()).toBeNull()

    await render({ ...aozaiProps, onRestartWithAccount: async () => {} })
    expect(trigger()).not.toBeNull()

    await openMenu()
    expect(menu()).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(menu()).toBeNull()

    await openMenu()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    await act(async () => { outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()
    outside.remove()
  })

  it('动作进行中时触发器改显进度文案并禁用——菜单收起也看得见在跑', async () => {
    let release!: () => void
    const onStartProUpgrade = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    await render({ onStartProUpgrade, onRestartWithAccount: async () => {} })

    await openMenu()
    await act(async () => item('升级 Pro').click())
    expect(menu()).toBeNull()
    expect(trigger()!.textContent).toBe('结账中…')
    expect(trigger()!.disabled).toBe(true)

    await act(async () => release())
    expect(trigger()!.disabled).toBe(false)
    expect(trigger()!.textContent).toBe('')
  })
})
