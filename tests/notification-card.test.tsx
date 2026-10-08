// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { NotificationCard } from '../src/renderer/src/notifications/NotificationCard'
import { FeedbackLine } from '../src/renderer/src/feedback/FeedbackLine'
import { UpdateReminder } from '../src/renderer/src/UpdateReminder'
let host: HTMLDivElement, root: Root
beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'sgDesktop')
})
it('shares one readable Toast header with semantic icons, preserves props and never executes a source action by rendering', async () => {
  const dismiss = vi.fn(),
    action = vi.fn(),
    ref = vi.fn()
  await act(async () =>
    root.render(
      <NotificationCard
        title="处理未全部完成"
        source="自动化"
        detail="具体步骤与已完成结果保留。"
        tone="warning"
        actions={<button onClick={action}>查看详情</button>}
        onDismiss={dismiss}
        ref={ref}
        aria-hidden="false"
        data-test="surface"
      />,
    ),
  )
  const toast = host.querySelector<HTMLElement>('aside')!
  expect(toast.dataset.test).toBe('surface')
  expect(toast.getAttribute('aria-live')).toBe('polite')
  expect(host.querySelector('.notification-toast__header')?.textContent).toBe(
    '处理未全部完成',
  )
  expect(host.querySelector('.feedback-icon.is-warning')).not.toBeNull()
  expect(action).not.toHaveBeenCalled()
  expect(dismiss).not.toHaveBeenCalled()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="收起提醒"]')!.click(),
  )
  expect(dismiss).toHaveBeenCalledOnce()
  expect(action).not.toHaveBeenCalled()
})
it('forwards exact local result provenance and only dismisses through an explicit caller action', async () => {
  const dismiss = vi.fn(),
    ref = vi.fn()
  await act(async () =>
    root.render(
      <FeedbackLine
        tone="error"
        ref={ref}
        onDismiss={dismiss}
        data-notification-key="record:key"
        data-notification-event="record:version"
      >
        读取失败，原结果保留。
      </FeedbackLine>,
    ),
  )
  expect(
    host.querySelector('[role="alert"]')?.getAttribute('data-notification-key'),
  ).toBe('record:key')
  expect(host.querySelector('.feedback-icon.is-error')).not.toBeNull()
  expect(dismiss).not.toHaveBeenCalled()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click(),
  )
  expect(dismiss).toHaveBeenCalledOnce()
})
it('keeps rich text, actions and dismiss controls in separate slots without remounting on a result update', async () => {
  const dismiss = vi.fn(), action = vi.fn(), ref = vi.fn()
  const render = async (text: string) => act(async () => root.render(
    <FeedbackLine tone="warning" ref={ref} onDismiss={dismiss}
      data-notification-key="record:key" data-notification-event="record:version"
      action={<button type="button" onClick={action}>查看完整结果</button>}>
      <b>结果说明</b>{text}
    </FeedbackLine>
  ))
  await render('长说明'.repeat(150))
  const line = host.querySelector('.feedback-line')!
  const close = line.querySelector<HTMLButtonElement>(':scope > .feedback-close')!
  const operation = line.querySelector<HTMLButtonElement>('.feedback-line__action button')!
  expect(line.querySelector('.feedback-line__copy button')).toBeNull()
  expect(line.querySelector('.feedback-line__copy b')?.textContent).toBe('结果说明')
  expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(close.type).toBe('button')
  close.focus()
  await render('更新后的说明')
  expect(host.querySelector('.feedback-line')).toBe(line)
  expect(host.querySelector('.feedback-close')).toBe(close)
  expect(document.activeElement).toBe(close)
  expect(dismiss).not.toHaveBeenCalled()
  expect(action).not.toHaveBeenCalled()
  await act(async () => close.click())
  expect(dismiss).toHaveBeenCalledOnce()
  expect(action).not.toHaveBeenCalled()
  await act(async () => operation.click())
  expect(action).toHaveBeenCalledOnce()
  expect(dismiss).toHaveBeenCalledOnce()
})
it('fallback update reminder keeps its existing once-per-version lifecycle on the shared surface', async () => {
  vi.useFakeTimers()
  const open = vi.fn()
  const status: NonNullable<Parameters<typeof UpdateReminder>[0]['status']> = {
    reminderVersion: '9.9.9',
    currentVersion: '9.9.8',
    settings: { autoCheck: true, checkIntervalHours: 6 },
    launchedAfterUpdate: false,
    releaseUrl: 'https://example.test/release',
    state: {
      phase: 'available',
      release: { version: '9.9.9', releaseUrl: 'https://example.test/release' },
      checkedAt: Date.now(),
    },
  }
  await act(async () =>
    root.render(
      <UpdateReminder status={status} onOpen={open} autoHideMs={1000} />,
    ),
  )
  expect(
    host.querySelector('.update-reminder.notification-toast'),
  ).not.toBeNull()
  expect(host.textContent).toContain('9.9.9 可用')
  expect(open).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTime(1001))
  expect(host.querySelector('.update-reminder')).toBeNull()
  await act(async () =>
    root.render(
      <UpdateReminder
        status={{ ...status! }}
        onOpen={open}
        autoHideMs={1000}
      />,
    ),
  )
  expect(host.querySelector('.update-reminder')).toBeNull()
})

it('pauses the fallback reminder while hovered and restores only the remaining lifetime', async () => {
  vi.useFakeTimers()
  const status: NonNullable<Parameters<typeof UpdateReminder>[0]['status']> = {
    reminderVersion: '9.9.9',
    currentVersion: '9.9.8',
    settings: { autoCheck: true, checkIntervalHours: 6 },
    launchedAfterUpdate: false,
    releaseUrl: 'https://example.test/release',
    state: {
      phase: 'available',
      release: { version: '9.9.9', releaseUrl: 'https://example.test/release' },
      checkedAt: Date.now(),
    },
  }
  await act(async () =>
    root.render(
      <UpdateReminder status={status} onOpen={() => {}} autoHideMs={1000} />,
    ),
  )
  await act(async () => vi.advanceTimersByTime(400))
  await act(async () =>
    host
      .querySelector('aside')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  )
  await act(async () => vi.advanceTimersByTime(2000))
  expect(host.querySelector('aside')).not.toBeNull()
  await act(async () =>
    host
      .querySelector('aside')!
      .dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
  )
  await act(async () => vi.advanceTimersByTime(500))
  expect(host.querySelector('aside')).not.toBeNull()
  await act(async () => vi.advanceTimersByTime(101))
  expect(host.querySelector('aside')).toBeNull()
})
it('does not hide a failed snooze or apply it to a different update version, and prevents double invocation', async () => {
  const status: NonNullable<Parameters<typeof UpdateReminder>[0]['status']> = {
    reminderVersion: '9.9.9',
    currentVersion: '9.9.8',
    settings: { autoCheck: true, checkIntervalHours: 6 },
    launchedAfterUpdate: false,
    releaseUrl: 'https://example.test/release',
    state: {
      phase: 'available',
      release: { version: '9.9.9', releaseUrl: 'https://example.test/release' },
      checkedAt: Date.now(),
    },
  }
  let reject!: (error: Error) => void
  const snooze = vi.fn(
    () =>
      new Promise<NonNullable<typeof status>>((_, bad) => {
        reject = bad
      }),
  )
  window.sgDesktop = {
    getAppUpdateStatus: async () => status,
    snoozeAppUpdate: snooze,
  } as unknown as Window['sgDesktop']
  await act(async () =>
    root.render(<UpdateReminder status={status} onOpen={() => {}} />),
  )
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === '稍后',
  )!
  await act(async () => {
    button.click()
    button.click()
  })
  expect(snooze).toHaveBeenCalledExactlyOnceWith({ expectedVersion: '9.9.9' })
  expect(button.disabled).toBe(true)
  await act(async () => reject(Error('save failed')))
  expect(host.querySelector('aside')).not.toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    '未能保存',
  )
})
