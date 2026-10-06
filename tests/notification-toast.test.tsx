// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationToast } from '../src/renderer/src/notifications/NotificationToast'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationRecord } from '../src/domain/notification'
import { mcpWriteReadIdentity, type McpWriteObservation } from '../src/domain/mcp-write-observation'

describe('single calm notification toast', () => {
  let host: HTMLDivElement; let root: Root; let store: NotificationStore; let api: NotificationApi; let release: () => void
  const record = (id: string): NotificationRecord => ({ id, key: id, source: '测试结果', category: 'storage', title: `${id} 清理完成`, scope: {}, tone: 'success', attention: 'notice', state: 'resolved',
    occurredAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), revision: 1, attentionRevision: 1, readRevision: 0, sourceRevision: 1 })
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const summary = { revision: 0, total: 0, unread: 0, pending: 0, clearable: 0 }
    api = { getNotificationPage: async () => ({ records: [], summary, reset: false }), getNotificationPreferences: async () => DEFAULT_NOTIFICATION_PREFERENCES,
      saveNotificationPreferences: async value => value, onNotificationChanged: () => () => {}, readNotification: vi.fn(), readAllNotifications: vi.fn(), archiveNotification: vi.fn(), clearReadNotifications: vi.fn() }
    store = new NotificationStore(api); release = store.acquire(); await Promise.resolve(); await Promise.resolve()
    await act(async () => root.render(<NotificationToast store={store} blocked={false} onOpen={() => {}} />))
  })
  afterEach(async () => { await act(async () => root.unmount()); release(); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
  const push = async (id: string, revision = 1) => {
    await act(async () => store.accept({ change: { changed: true, summary: { revision, total: revision, unread: revision, pending: 0, clearable: 0 }, record: record(id) },
      announcement: { id, expiresAt: Date.now() + 60_000 }, health: 'ready', historyIncomplete: false }))
  }
  it('presents one card and quiet mode closes it without recursive listener updates or marking it read', async () => {
    await push('first'); await push('second', 2)
    expect(document.querySelectorAll('.notification-toast')).toHaveLength(1)
    expect(document.querySelector('.notification-toast')!.textContent).toContain('first 清理完成')
    await act(async () => store.accept({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, quiet: true }, health: 'ready', historyIncomplete: false }))
    expect(document.querySelector('.notification-toast')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('muting the displayed category only in-app closes its toast without native policy changes or human reading', async () => {
    await push('first')
    await act(async () => store.accept({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, nativeEnabled: true, inAppMutedCategories: ['storage'] }, health: 'ready', historyIncomplete: false }))
    expect(document.querySelector('.notification-toast')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
    expect(store.snapshot().preferences.nativeEnabled).toBe(true)
  })
  it('hover pauses the remaining dwell time; the next queued card gets its own full timer', async () => {
    await push('first'); await push('second', 2)
    await act(async () => vi.advanceTimersByTime(3_000))
    await act(async () => document.querySelector('.notification-toast')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(8_000))
    expect(document.querySelector('.notification-toast')!.textContent).toContain('first 清理完成')
    await act(async () => document.querySelector('.notification-toast')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(2_100))
    expect(document.querySelector('.notification-toast')!.textContent).toContain('second 清理完成')
    await act(async () => vi.advanceTimersByTime(4_000))
    expect(document.querySelector('.notification-toast')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(1_100)); expect(document.querySelector('.notification-toast')).toBeNull()
  })
  it('does not replay expired ordinary success after returning from the background', async () => {
    await push('first')
    await act(async () => window.dispatchEvent(new Event('blur')))
    await act(async () => vi.advanceTimersByTime(70_000))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(document.querySelector('.notification-toast')).toBeNull()
  })
  it('reading a result in the center retires its paused toast instead of replaying it on close', async () => {
    await push('first')
    await act(async () => root.render(<NotificationToast store={store} blocked={true} onOpen={() => {}} />))
    await act(async () => store.accept({ change: { changed: true, record: { ...record('first'), readRevision: 1 }, summary: { revision: 2, total: 1, unread: 0, pending: 0, clearable: 1 } }, health: 'ready', historyIncomplete: false }))
    await act(async () => root.render(<NotificationToast store={store} blocked={false} onOpen={() => {}} />))
    expect(document.querySelector('.notification-toast')).toBeNull()
  })
  it('places the reminder above the composer instead of covering its send and attachment controls', async () => {
    const composer = document.createElement('section'); composer.className = 'workspace-composer'; document.body.append(composer)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ width: 500, height: 200, top: 400, bottom: 600, left: 0, right: 500, x: 0, y: 400, toJSON: () => ({}) })
    try {
      await push('first')
      expect((document.querySelector('.notification-toast') as HTMLElement).style.bottom).toBe(`${innerHeight - 400 + 12}px`)
    } finally { composer.remove() }
  })
  it('a visible exact run-page result stays in place instead of producing a duplicate global toast', async () => {
    const result = document.createElement('p'); result.dataset.notificationPage = 'run'; result.dataset.notificationResult = ''; result.dataset.notificationKey = 'first'; result.dataset.notificationEvent = 'final'
    document.body.append(result)
    vi.spyOn(result, 'getBoundingClientRect').mockReturnValue({ width: 500, height: 40, top: 100, bottom: 140, left: 0, right: 500, x: 0, y: 100, toJSON: () => ({}) })
    try {
      await act(async () => store.accept({ change: { changed: true, record: { ...record('first'), eventId: 'final', origin: { module: 'run' } }, summary: { revision: 1, total: 1, unread: 1, pending: 0, clearable: 0 } },
        announcement: { id: 'first', expiresAt: Date.now() + 60_000 }, health: 'ready', historyIncomplete: false }))
      expect(document.querySelector('.notification-toast')).toBeNull()
    } finally { result.remove() }
  })
  it('expanded exact native outputs suppress a grouped reminder only when every underlying result is visible; a collapsed header is not reading', async () => {
    const scope = { sessionId: 'session', channelId: '1', generation: '0', composerId: 'composer', bindingGeneration: 'binding' }
    const proof: McpWriteObservation = { tool: 'team_memory', action: 'propose', channelId: '1', agentSessionId: 'native-agent', status: 'unconfirmed', reason: 'storage' }
    const container = document.createElement('div')
    Object.assign(container.dataset, { notificationMcpScope: '', notificationSession: 'session', notificationChannel: '1', notificationGeneration: '0', notificationComposer: 'composer', notificationBinding: 'binding' })
    const outputs = [1, 2].map(i => { const e = document.createElement('pre'); Object.assign(e.dataset, { notificationMcpBlock: `block-${i}`, notificationMcpStatus: 'unconfirmed', notificationMcpChannel: '1', notificationMcpProof: mcpWriteReadIdentity(proof) }); container.append(e); return e })
    document.body.append(container)
    let hidden = false
    outputs.forEach((e, i) => vi.spyOn(e, 'getBoundingClientRect').mockImplementation(() => ({ width: 300, height: 70, top: hidden && i === 0 ? 2000 : 100, bottom: hidden && i === 0 ? 2070 : 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })))
    const originals = [1, 2].map(i => ({ ...record(`mcp-${i}`), eventType: 'mcp.write-result', subjectState: 'unconfirmed', scope,
      origin: { module: 'sessions' as const, sessionId: scope.sessionId }, target: { kind: 'session' as const, scope, blockId: `block-${i}`, mcpWrite: proof } }))
    const grouped = async (id: string, revision: number) => {
      await act(async () => originals.forEach(r => store.accept({ health: 'ready', historyIncomplete: false, change: { changed: true, record: r, summary: { revision, total: 2, unread: 2, pending: 0, clearable: 0 } } })))
      await act(async () => store.accept({ health: 'ready', historyIncomplete: false, change: { changed: true, record: originals[1], summary: { revision, total: 2, unread: 2, pending: 0, clearable: 0 } },
        announcement: { id, expiresAt: Date.now() + 60000, group: { title: '2 项结果待核对', source: '协作工具', detail: '摘要', recordIds: originals.map(r => r.id), target: { kind: 'session', scope } } } }))
    }
    try {
      await grouped('group-1', 1); expect(document.querySelector('.notification-toast')).toBeNull()
      hidden = true; await grouped('group-2', 2); expect(document.querySelector('.notification-toast')!.textContent).toContain('2 项结果待核对')
      expect(api.readNotification).not.toHaveBeenCalled() // Suppression itself is not a receipt.
    } finally { container.remove() }
  })
})
