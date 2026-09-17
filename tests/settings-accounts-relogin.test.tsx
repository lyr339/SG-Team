// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'
import type { SettingsPageProps } from '../src/renderer/src/settings/settings-view'

describe('账号卡片：重新登录（凭据自动登录）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    history.replaceState(null, '', '#account:accounts')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function props(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
    return {
      accounts: [
        { id: 'account:card', label: 'card@x.co', maskedToken: '••••abcd', active: true, createdAt: 1, updatedAt: 1, email: 'card@x.co', hasCredentials: true },
        { id: 'account:plain', label: 'plain@x.co', maskedToken: '••••efgh', active: false, createdAt: 2, updatedAt: 2 }
      ],
      busy: false,
      error: '',
      onSave: async () => {},
      onSelect: async () => {},
      onRemove: async () => {},
      ...overrides
    }
  }

  // 「重新登录」是次要动作，收在账号卡操作行的「⋯」里（弹层 portal 到 document.body）。
  const triggers = (): HTMLButtonElement[] =>
    [...container.querySelectorAll<HTMLButtonElement>('.account-actions-menu__trigger')]
  const menuItem = (text: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>('.account-actions-menu button')]
      .find((button) => button.textContent === text)

  it('仅卡号导入的账号展示入口；点击触发自动登录并置忙，完成后恢复', async () => {
    let resolveLogin!: () => void
    const onReloginAccount = vi.fn(() => new Promise<void>((resolve) => { resolveLogin = resolve }))
    await act(async () => root.render(<SettingsPage {...props({ onReloginAccount })} />))

    // 无凭据账号没有任何次要动作，连「⋯」都不出现
    expect(triggers()).toHaveLength(1)
    await act(async () => triggers()[0]!.click())
    const relogin = menuItem('重新登录')!
    expect(relogin).not.toBeUndefined()

    await act(async () => relogin.click())
    expect(onReloginAccount).toHaveBeenCalledWith('account:card')
    // 菜单收起，进度提到触发器上
    expect(document.body.querySelector('.account-actions-menu')).toBeNull()
    expect(triggers()[0]!.textContent).toBe('登录中…')

    await act(async () => resolveLogin())
    await act(async () => triggers()[0]!.click())
    expect(menuItem('重新登录')).not.toBeUndefined()
  })

  it('未装配自动登录（onReloginAccount 缺省）时任何账号都不展示入口', async () => {
    await act(async () => root.render(<SettingsPage {...props()} />))
    expect(triggers()).toHaveLength(0)
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '重新登录')).toBe(false)
  })
})
