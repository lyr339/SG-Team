// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS } from '../src/domain/account-automation'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'
import type { SettingsPageProps } from '../src/renderer/src/settings/settings-view'

function fakeCardText(email = 'ElliotMooreeza@outlook.com'): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const jwt = `${segment({ alg: 'HS256' })}.${segment({ sub: 'auth0|user_01M25', exp: 1_794_218_127 })}.sig`
  return [email, 'mail-pass', 'cursor-pass', 'sub@ouleyx.cc', 'sub-pass', `user_01M25::${jwt}`].join('----')
}

describe('导入来源：卡号粘贴表单', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    history.replaceState(null, '', '#account:import')
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
      accounts: [],
      busy: false,
      error: '',
      onSave: async () => {},
      onSelect: async () => {},
      onRemove: async () => {},
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, browserHost: 'fingerprint', bitProfileId: 'roxy-1' },
      automationRun: { phase: 'idle', message: '', startedAt: 0 },
      ...overrides
    }
  }

  const textarea = (): HTMLTextAreaElement => container.querySelector<HTMLTextAreaElement>('.settings-add-form textarea')!
  const labelInput = (): HTMLInputElement => container.querySelector<HTMLInputElement>('.settings-add-form input')!
  const submitButton = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.lobby-account__save')!

  async function openForm(): Promise<void> {
    const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('手动粘贴'))!
    await act(async () => toggle.click())
  }

  async function paste(text: string): Promise<void> {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('粘贴卡号：识别预览、备注跟随邮箱、提交走卡号通道并亮出反馈', async () => {
    const onSaveCard = vi.fn(async (_input: { card: string }) => ({ outcome: 'created' as const, label: 'ElliotMooreeza@outlook.com' }))
    const onSave = vi.fn(async () => {})
    await act(async () => root.render(<SettingsPage {...props({ onSaveCard, onSave })} />))
    await openForm()

    await paste(fakeCardText())
    const preview = container.querySelector('.settings-card-preview')!
    expect(preview.textContent).toContain('识别为卡号：ElliotMooreeza@outlook.com')
    expect(preview.textContent).toContain('Token 有效期至 2026/11/9')
    expect(preview.textContent).toContain('含辅邮')
    expect(labelInput().value).toBe('ElliotMooreeza@outlook.com')
    expect(submitButton().textContent).toBe('导入卡号')

    await act(async () => submitButton().click())
    expect(onSaveCard).toHaveBeenCalledTimes(1)
    expect(onSaveCard.mock.calls[0]![0].card).toBe(fakeCardText())
    expect(onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已导入账号「ElliotMooreeza@outlook.com」')
    // 成功后表单清空
    expect(textarea().value).toBe('')
  })

  it('同一账号再粘贴：反馈为更新语义', async () => {
    const onSaveCard = vi.fn(async () => ({ outcome: 'updated' as const, label: 'ElliotMooreeza@outlook.com' }))
    await act(async () => root.render(<SettingsPage {...props({ onSaveCard })} />))
    await openForm()
    await paste(fakeCardText())
    await act(async () => submitButton().click())
    expect(container.textContent).toContain('已更新账号「ElliotMooreeza@outlook.com」的 Token 与登录凭据')
  })

  it('卡内 Token 已过期：自动登录成功/失败的反馈分色呈现', async () => {
    const refreshed = vi.fn(async () => ({ outcome: 'created' as const, label: 'a@b.co', tokenRefreshed: true }))
    await act(async () => root.render(<SettingsPage {...props({ onSaveCard: refreshed })} />))
    await openForm()
    await paste(fakeCardText())
    await act(async () => submitButton().click())
    expect(container.querySelector('.settings-add-form__ok')?.textContent).toContain('已用凭据自动登录刷新')

    // 表单在首次提交后保持展开且字段已清空：换 onSaveCard 实现后直接再粘贴
    const failed = vi.fn(async () => ({ outcome: 'created' as const, label: 'a@b.co', loginError: '自动登录超时' }))
    await act(async () => root.render(<SettingsPage {...props({ onSaveCard: failed })} />))
    await paste(fakeCardText())
    await act(async () => submitButton().click())
    const warn = container.querySelector('.settings-add-form__warn')
    expect(warn?.textContent).toContain('自动登录未成功')
    expect(warn?.textContent).toContain('自动登录超时')
  })

  it('卡号字段非法时行内报错且禁止提交', async () => {
    const onSaveCard = vi.fn(async () => ({ outcome: 'created' as const, label: 'x' }))
    await act(async () => root.render(<SettingsPage {...props({ onSaveCard })} />))
    await openForm()
    await paste('a@b.co----x----y')
    expect(container.querySelector('.settings-add-form__error')?.textContent).toContain('6 段')
    expect(submitButton().disabled).toBe(true)
    expect(onSaveCard).not.toHaveBeenCalled()
  })

  it('单独 Token 仍走旧通道（需备注），卡号识别后改过的备注不被覆盖', async () => {
    const onSave = vi.fn(async () => {})
    await act(async () => root.render(<SettingsPage {...props({ onSave })} />))
    await openForm()

    // 纯 Token：无预览，备注必填，按钮为「保存账号」
    await paste('user_abc::plain-token-value')
    expect(container.querySelector('.settings-card-preview')).toBeNull()
    expect(submitButton().textContent).toBe('保存账号')
    expect(submitButton().disabled).toBe(true)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(labelInput(), '工作账号 A')
      labelInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submitButton().disabled).toBe(false)
    await act(async () => submitButton().click())
    expect(onSave).toHaveBeenCalledWith({ label: '工作账号 A', token: 'user_abc::plain-token-value' })

    // 先识别卡号（备注自动=邮箱）→ 用户改备注 → 重新粘贴另一卡号：备注保留用户改动
    await paste(fakeCardText())
    expect(labelInput().value).toBe('ElliotMooreeza@outlook.com')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(labelInput(), '我的主号')
      labelInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await paste(fakeCardText('second@x.co'))
    expect(labelInput().value).toBe('我的主号')
  })

  it('卡号改贴单独 Token：未触碰过的自动备注被清掉，不残留旧邮箱', async () => {
    await act(async () => root.render(<SettingsPage {...props()} />))
    await openForm()
    await paste(fakeCardText())
    expect(labelInput().value).toBe('ElliotMooreeza@outlook.com')
    // 改贴单独 Token：自动填充的邮箱备注清空，回到「必填备注」的 Token 路径
    await paste('user_abc::plain-token-value')
    expect(labelInput().value).toBe('')
    expect(submitButton().disabled).toBe(true)
  })
})
