import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationQuitBarrier, drainNotificationsForQuit } from '../src/main/notification-quit-barrier'
import { NotificationRuntimeJournal } from '../src/infrastructure/notifications/runtime-journal'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NotificationProjectionSource } from '../src/application/notifications/projection-source'
import { SessionLifecycleNotifications } from '../src/application/notifications/session-lifecycle-notifications'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

describe('actual notification drain admission and durability boundary', () => {
  let folder: string
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'sg-notification-quit-test-')) })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))
  const draft = (key: string, revision: number): NotificationDraft => ({ key, category: 'sessions', source: '会话', title: key, attention: 'notice', state: 'resolved',
    tone: 'info', scope: {}, sourceRevision: revision, occurredAt: 100, announce: true })
  it('seals producers before desktop disposal, preserves their accepted queue and emits no quit-time alert', async () => {
    const path = join(folder, 'notifications.sqlite3'), h = notificationSourceHarness(path)
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { await gate; return h.ledger.sourceState(key) })
    const events: NotificationPush[] = []; h.owner.subscribe(event => events.push(event))
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value, _baseline, revision) => ({ state: value, drafts: value ? [draft(`accepted:${value}`, revision)] : [] }), String)
    source.observe('source:quit', 0); source.observe('source:quit', 1); source.observe('source:quit', 2)
    const dispose = vi.fn(() => source.observe('source:quit', 3))
    const draining = drainNotificationsForQuit(h.owner, [() => source.close()], dispose)
    expect(dispose).toHaveBeenCalledOnce(); release(); expect(await draining).toBe(true)
    const restored = new SqliteNotificationRepository(path)
    try {
      expect(restored.page().records.map(record => record.key).sort()).toEqual(['accepted:1', 'accepted:2'])
      expect(restored.sourceState('source:quit')).toMatchObject({ revision: 3, data: 2 })
      expect(events.some(event => event.announcement)).toBe(false)
    } finally { restored.close() }
  })
  it('received lifecycle transitions still drain when shutdown happens during suspend', async () => {
    const path = join(folder, 'notifications.sqlite3'), h = notificationSourceHarness(path)
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { await gate; return h.ledger.sourceState(key) })
    const source = new SessionLifecycleNotifications(h.owner, () => 10_000, () => 'quit-incident')
    source.observe(notificationFrame(), notificationTeam())
    source.observe(notificationFrame({ sessions: [notificationSession({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })] }), notificationTeam())
    source.suspend()
    const closing = drainNotificationsForQuit(h.owner, [() => source.close()], () => {})
    release(); expect(await closing).toBe(true)
    const restored = new SqliteNotificationRepository(path)
    try { expect(restored.page().records[0]?.title).toContain('已离线') } finally { restored.close() }
  })
  it('an existing plain-result write finishes before ledger close, but close never admits new work', async () => {
    const path = join(folder, 'notifications.sqlite3'), h = notificationSourceHarness(path)
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    vi.spyOn(h.port, 'put').mockImplementationOnce(async (value, now) => { await gate; return h.ledger.put(value, now) })
    h.owner.offer(draft('before-quit', 1))
    const closing = h.owner.close(); h.owner.offer(draft('after-close', 1))
    release(); await closing
    const restored = new SqliteNotificationRepository(path)
    try { expect(restored.page().records.map(record => record.key)).toEqual(['before-quit']) } finally { restored.close() }
  })
  it('a source failure cannot become a confirmed shutdown merely because the owner eventually closed', async () => {
    const h = notificationSourceHarness(), failing = vi.fn(async () => { throw Error('unconfirmed source') }), stop = vi.fn()
    expect(await drainNotificationsForQuit(h.owner, [failing], stop)).toBe(false)
    expect(stop).toHaveBeenCalledOnce(); expect(h.owner.status()).toMatchObject({ historyIncomplete: true, shutdownConfirmed: false })
  })
  it('observer-handled store failure is still unconfirmed, not silently treated as a successful drain', async () => {
    const h = notificationSourceHarness()
    vi.mocked(h.port.commitSource).mockRejectedValueOnce(Error('write not confirmed'))
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined, (_old, state) => ({ state, drafts: [] }), String)
    source.observe('source:failed', 1)
    expect(await drainNotificationsForQuit(h.owner, [() => source.close()], () => {})).toBe(false)
    expect(h.owner.status().historyIncomplete).toBe(true)
  })
  it('an earlier known history gap is retained without falsely saying this clean drain failed', async () => {
    const h = notificationSourceHarness(); h.owner.reportHistoryGap()
    await h.owner.sourceState('ready-again')
    expect(await drainNotificationsForQuit(h.owner, [], () => {})).toBe(true)
    expect(h.owner.status()).toMatchObject({ historyIncomplete: true, shutdownConfirmed: true })
  })
  it('does not report confirmed closing until the repository has actually acknowledged close', async () => {
    const h = notificationSourceHarness(); let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    vi.spyOn(h.port, 'close').mockImplementationOnce(async () => { await gate; h.ledger.close() })
    const closing = h.owner.close(); await Promise.resolve(); await Promise.resolve()
    expect(h.owner.status().shutdownConfirmed).toBe(false)
    release(); await closing; expect(h.owner.status().shutdownConfirmed).toBe(true)
  })
})

describe('bounded Electron quit reentry gate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('coalesces repeated quit requests and permits only the resumed quit after draining', async () => {
    let release!: (confirmed: boolean) => void
    const drain = vi.fn(() => new Promise<boolean>(done => { release = done })), settled = vi.fn(), resumeQuit = vi.fn()
    const barrier = new NotificationQuitBarrier({ drain, settled, resumeQuit })
    const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() }
    barrier.handle(first); barrier.handle(second)
    expect(first.preventDefault).toHaveBeenCalledOnce(); expect(second.preventDefault).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledOnce()
    release(true); await vi.runAllTimersAsync()
    expect(settled).toHaveBeenCalledWith({ confirmed: true, reason: 'drained' }); expect(resumeQuit).toHaveBeenCalledOnce()
    const resumed = { preventDefault: vi.fn() }; barrier.handle(resumed); expect(resumed.preventDefault).not.toHaveBeenCalled()
  })
  it('times out without forcing replay, and a late success cannot overwrite the unconfirmed outcome or quit twice', async () => {
    let release!: (confirmed: boolean) => void
    const drain = vi.fn(() => new Promise<boolean>(done => { release = done })), settled = vi.fn(), resumeQuit = vi.fn()
    const barrier = new NotificationQuitBarrier({ drain, settled, resumeQuit, timeoutMs: 50 })
    barrier.handle({ preventDefault: vi.fn() }); await vi.advanceTimersByTimeAsync(50)
    expect(settled).toHaveBeenCalledWith({ confirmed: false, reason: 'timeout' }); expect(resumeQuit).toHaveBeenCalledOnce()
    release(true); await vi.runAllTimersAsync()
    expect(settled).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledOnce(); expect(resumeQuit).toHaveBeenCalledOnce()
  })
  it('diagnostic failure or synchronous drain failure cannot trap quit or recurse in the original event', async () => {
    const resumeQuit = vi.fn(), settled = vi.fn(() => { throw Error('diagnostic disk full') })
    const barrier = new NotificationQuitBarrier({ drain: () => { throw Error('source close failed') }, settled, resumeQuit })
    barrier.handle({ preventDefault: vi.fn() }); expect(resumeQuit).not.toHaveBeenCalled()
    await vi.runAllTimersAsync(); expect(resumeQuit).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledWith({ confirmed: false, reason: 'failed' })
  })
})

describe('private runtime quit evidence', () => {
  let folder: string
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'sg-notification-journal-test-')) })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))
  it('clean shutdown restores without a historical-gap warning and stores no source/user data', () => {
    const path = join(folder, 'runtime.json'), journal = new NotificationRuntimeJournal(path, () => 100)
    expect(journal.open()).toEqual({ historyIncomplete: false }); expect(journal.open()).toEqual({ historyIncomplete: false }); journal.finish(true, false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, runtimeId: expect.any(String), startedAt: 100, closedAt: 100, historyIncomplete: false })
    expect(new NotificationRuntimeJournal(path, () => 200).open()).toEqual({ historyIncomplete: false })
  })
  it('crash/forced exit and deadline escape leave possible-gap evidence, not fabricated missing events or automatic recovery', () => {
    const path = join(folder, 'runtime.json'), first = new NotificationRuntimeJournal(path, () => 100)
    first.open()
    const restored = new NotificationRuntimeJournal(path, () => 200)
    expect(restored.open()).toMatchObject({ historyIncomplete: true, gapId: expect.any(String) }); restored.finish(false, true)
    expect(JSON.parse(readFileSync(path, 'utf8')).closedAt).toBeUndefined()
    const third = new NotificationRuntimeJournal(path, () => 300)
    expect(third.open()).toMatchObject({ historyIncomplete: true, gapId: expect.any(String) }); third.finish(true, false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ closedAt: 300, historyIncomplete: true })
  })
  it('corrupt previous evidence is preserved rather than overwritten as a clean session', () => {
    const path = join(folder, 'runtime.json'); writeFileSync(path, '{ broken')
    const journal = new NotificationRuntimeJournal(path)
    expect(() => journal.open()).toThrow(); expect(() => journal.finish(true, false)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
  })
  it('an oversized corrupt marker is read within a hard byte bound and preserved', () => {
    const path = join(folder, 'runtime.json'), bytes = 'x'.repeat(6_000); writeFileSync(path, bytes)
    expect(() => new NotificationRuntimeJournal(path).open()).toThrow('过大')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
})
