import { describe, expect, it, vi } from 'vitest'
import type { NotificationService } from '../src/application/notification-service'
import type { NotificationPush } from '../src/domain/notification'
import { registerNotificationIpc } from '../src/main/register-notification-ipc'
import { IPC } from '../src/shared/desktop-api'
import type { NotificationDeliveryService } from '../src/application/notification-delivery-service'

const { handlers, trusted } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(), trusted: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, payload?: unknown) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } }))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: trusted }))

function harness(delivery?: Pick<NotificationDeliveryService, 'subscribe' | 'status' | 'openRequested'>) {
  handlers.clear(); trusted.mockReset()
  let listener!: (event: NotificationPush) => void
  const unsubscribe = vi.fn()
  const service = { acknowledgeHistoryGap: vi.fn(), page: vi.fn(), read: vi.fn(), readAll: vi.fn(), archive: vi.fn(), clearRead: vi.fn(), preferences: vi.fn(), savePreferences: vi.fn(),
    subscribe: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe }) }
  const send = vi.fn(); const window = { isDestroyed: () => false, webContents: { send } }
  const dispose = registerNotificationIpc(service as unknown as NotificationService, () => window as never, delivery)
  return { service, send, unsubscribe, dispose, emit: (event: NotificationPush) => listener(event),
    invoke: (channel: string, input?: unknown) => handlers.get(channel)!({}, input) }
}

describe('notification IPC permissions and data boundaries', () => {
  it('routes through the single delivery owner and exposes read-only status/open references, never native-show or business commands', async () => {
    let routed!: (event: NotificationPush) => void
    const stop = vi.fn(), delivery = { subscribe: vi.fn((listener: typeof routed) => { routed = listener; return stop }),
      status: () => ({ nativeSupported: true, state: 'ready' as const }), openRequested: () => ({ token: 'native:click', key: 'exact-key', recordId: 'original-id', revision: 3 }) }
    const h = harness(delivery)
    h.service.page.mockResolvedValue({ records: [], reset: false, summary: { revision: 3, total: 0, unread: 0, pending: 0, clearable: 0 } })
    await expect(h.invoke(IPC.notificationPage, { key: 'exact-key', limit: 1 })).resolves.toMatchObject({ delivery: { nativeSupported: true, state: 'ready' }, openRequested: { recordId: 'original-id' } })
    expect(h.service.subscribe).not.toHaveBeenCalled()
    routed({ health: 'ready', historyIncomplete: false, openRequested: delivery.openRequested() }); expect(h.send).toHaveBeenCalledOnce()
    expect([...handlers.keys()].some(key => /native.*show|deliver|execute|restart/.test(key))).toBe(false)
    h.dispose(); expect(stop).toHaveBeenCalledOnce()
  })
  it('history acknowledgement is a trusted exact-revision operation, not clearing/reading or a publish endpoint', () => {
    const h = harness()
    try {
      h.invoke(IPC.notificationAcknowledgeHistory, 7); expect(h.service.acknowledgeHistoryGap).toHaveBeenCalledWith(7)
      for (const invalid of ['7', -1, {}, Number.POSITIVE_INFINITY]) expect(() => h.invoke(IPC.notificationAcknowledgeHistory, invalid)).toThrow()
      trusted.mockImplementation(() => { throw Error('untrusted') })
      expect(() => h.invoke(IPC.notificationAcknowledgeHistory, 8)).toThrow('untrusted')
      expect(h.service.acknowledgeHistoryGap).toHaveBeenCalledOnce(); expect(h.service.read).not.toHaveBeenCalled(); expect(h.service.clearRead).not.toHaveBeenCalled()
      expect([...handlers.keys()].some(key => /prune|record.*gap|publish/.test(key))).toBe(false)
    } finally { h.dispose() }
  })
  it('allows only validated source identities in exact-result queries', () => {
    const { service, invoke, dispose } = harness()
    invoke(IPC.notificationPage, { sessionId: 'session-a', toolCallId: 'tool-a', entryId: 'reply:a', ignored: 'transcript' })
    expect(service.page).toHaveBeenCalledWith({ sessionId: 'session-a', toolCallId: 'tool-a', entryId: 'reply:a' })
    for (const key of ['sessionId', 'toolCallId', 'entryId']) expect(() => invoke(IPC.notificationPage, { [key]: { injected: true } })).toThrow()
    dispose()
  })
  it('authenticates every read and mutation and never exposes a renderer publish endpoint', () => {
    const { service, invoke, dispose } = harness()
    invoke(IPC.notificationPage, { filter: 'pending', workspaceId: 'workspace-a', limit: 40, ignored: 'raw transcript' })
    expect(service.page).toHaveBeenCalledWith({ filter: 'pending', workspaceId: 'workspace-a', limit: 40 })
    invoke(IPC.notificationRead, { id: 'record-1', revision: 7 })
    expect(service.read).toHaveBeenCalledWith('record-1', 7)
    expect(trusted).toHaveBeenCalledTimes(2)
    expect([...handlers.keys()].some(key => /publish|put|offer/.test(key))).toBe(false)
    dispose()
  })
  it('rejects malformed filters, excessive limits and stale-form invalid types before reaching storage', () => {
    const { service, invoke, dispose } = harness()
    for (const value of [{ filter: 'anything' }, { category: 'injected' }, { limit: 101 }, { cursor: { revision: NaN, offset: 0 } }, { workspaceId: 5 }]) {
      expect(() => invoke(IPC.notificationPage, value)).toThrow()
    }
    expect(() => invoke(IPC.notificationRead, { id: 'r', revision: -1 })).toThrow()
    expect(service.page).not.toHaveBeenCalled(); expect(service.read).not.toHaveBeenCalled()
    dispose()
  })
  it('requires explicit confirmation before clearing read history and forwards only the chosen scope', () => {
    const { service, invoke, dispose } = harness()
    expect(() => invoke(IPC.notificationClearRead, { query: {} })).toThrow('需要确认')
    invoke(IPC.notificationClearRead, { confirmed: true, query: { workspaceId: 'a' } })
    expect(service.clearRead).toHaveBeenCalledWith({ workspaceId: 'a' })
    dispose()
  })
  it('pushes independently of DesktopSnapshot and unregisters handlers and subscriptions', () => {
    const { emit, send, unsubscribe, dispose } = harness()
    const event: NotificationPush = { health: 'degraded', historyIncomplete: true }
    emit(event); expect(send).toHaveBeenCalledWith(IPC.notificationChanged, event)
    dispose(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(handlers.size).toBe(0)
  })
  it('rejects calls from an untrusted window before any storage access', () => {
    const { service, invoke, dispose } = harness()
    trusted.mockImplementation(() => { throw Error('untrusted') })
    expect(() => invoke(IPC.notificationPage)).toThrow('untrusted')
    expect(service.page).not.toHaveBeenCalled(); dispose()
  })
})
