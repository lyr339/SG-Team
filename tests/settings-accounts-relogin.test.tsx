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

  it('仅卡号导入的账号展示入口；点击触发自动登录并置忙，完成后恢复', async () => {
    let resolveLogin!: () => void
    const onReloginAccount = vi.fn(() => new Promise<void>((resolve) => { resolveLogin = resolve }))
    await act(async () => root.render(<SettingsPage {...props({ onReloginAccount })} />))

    const buttons = [...container.querySelectorAll('button')]
    const relogin = buttons.find((button) => button.textContent === '重新登录')!
    // 无凭据账号没有入口
    expect(buttons.filter((button) => button.textContent === '重新登录')).toHaveLength(1)

    await act(async () => relogin.click())
    expect(onReloginAccount).toHaveBeenCalledWith('account:card')
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === '登录中…')).toBeTruthy()

    await act(async () => resolveLogin())
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === '重新登录')).toBeTruthy()
  })

  it('未装配自动登录（onReloginAccount 缺省）时任何账号都不展示入口', async () => {
    await act(async () => root.render(<SettingsPage {...props()} />))
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '重新登录')).toBe(false)
  })
})
