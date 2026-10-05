import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/infrastructure/fs/store-file'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { UsageStorageNotifications } from '../src/application/notifications/usage-storage-notifications'
import { readUsageStorageState } from '../src/domain/usage-storage-notification'
import { notificationSourceHarness } from './notification-source-fixtures'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'
const usage = { composerId: 'fixture', turns: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: .01, pricedModel: 'private-model', lastTurnAt: 100 }

describe('original usage file outcomes, not token-estimate changes or a new persistence workflow', () => {
  it('keeps healthy values and exact original load/save counts; corruption is not historical zero and successful saves cannot reconstruct it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-usage-health-')), h = notificationSourceHarness(), source = new UsageStorageNotifications(h.owner, () => 10000)
    const store = new CursorUsageStore(join(dir, 'usage.json'), source), writes = vi.spyOn(files, 'writeStoreFileSync'), reads = vi.spyOn(files, 'readStoreJsonSync')
    try {
      expect(store.load()).toEqual({}); await source.source.flush(); expect(h.ledger.page().summary.total).toBe(0)
      store.save({ fixture: usage }); expect(store.load().fixture?.inputTokens).toBe(100)
      await source.source.flush(); expect(h.ledger.page().summary.total).toBe(0)
      expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2)
      writeFileSync(store.path, '{private malformed raw original')
      expect(store.load()).toEqual({}); await source.source.flush()
      expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(true)
      const lost = h.ledger.page().records[0]!
      expect(lost).toMatchObject({ eventType: 'usage.storage-history', state: 'active', subjectState: 'history-unconfirmed' })
      expect(lost.detail).toContain('留档'); expect(lost.detail).toContain('不能把空统计')
      store.save({ fixture: usage }); expect(store.load().fixture?.inputTokens).toBe(100)
      await source.source.flush(); expect(h.ledger.page().records).toEqual([lost])
      expect(writes).toHaveBeenCalledTimes(2); expect(reads).toHaveBeenCalledTimes(4)
      expect(JSON.stringify(h.ledger.page())).not.toMatch(/private|sg-usage-health-|usage\.json/)
    } finally { writes.mockRestore(); reads.mockRestore(); await source.close(); await h.owner.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('retains valid partial rows and the original file rather than re-reading or quarantining it again for notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-usage-partial-')), h = notificationSourceHarness(), source = new UsageStorageNotifications(h.owner, () => 10000)
    const store = new CursorUsageStore(join(dir, 'usage.json'), source)
    try {
      const text = JSON.stringify({ version: 4, sessions: { good: usage, bad: { malformed: 'private row' } } })
      writeFileSync(store.path, text)
      expect(Object.keys(store.load())).toEqual(['good']); await source.source.flush()
      expect(readFileSync(store.path, 'utf8')).toBe(text); expect(readdirSync(dir)).toEqual(['usage.json'])
      expect(h.ledger.page().records[0]?.detail).toContain('跳过了无法验证')
      const reads = vi.spyOn(files, 'readStoreJsonSync')
      try { source.observe({ kind: 'save', result: 'confirmed' }); await source.source.flush(); expect(reads).not.toHaveBeenCalled() } finally { reads.mockRestore() }
      expect(h.ledger.page().summary.unread).toBe(1)
    } finally { await source.close(); await h.owner.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('propagates the identical original save exception despite a throwing observer, and never lets observer failure quarantine a healthy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-usage-isolation-')), error = Object.assign(Error('private original EACCES'), { code: 'EACCES' })
    const unavailable = vi.fn(() => { throw Error('broken gap listener') })
    const store = new CursorUsageStore(join(dir, 'usage.json'), { observe: () => { throw Error('broken observer') }, unavailable })
    const writer = vi.spyOn(files, 'writeStoreFileSync')
    try {
      writer.mockImplementationOnce(() => { throw error })
      try { store.save({ fixture: usage }); throw Error('missing original error') } catch (actual) { expect(actual).toBe(error) }
      store.save({ fixture: usage }); expect(store.load().fixture?.inputTokens).toBe(100)
      expect(readdirSync(dir)).toEqual(['usage.json']); expect(unavailable).toHaveBeenCalledTimes(3)
    } finally { writer.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('aggregates repeated original failures, distinguishes later cause/recovery/new episode and does not announce historical startup or normal token data', async () => {
    const h = notificationSourceHarness(), source = new UsageStorageNotifications(h.owner, () => 10000), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    try {
      source.observe({ kind: 'load', result: 'ready' }); await source.source.flush()
      for (let i = 0; i < 100; i++) source.observe({ kind: 'save', result: 'unconfirmed', reason: 'permission' })
      await source.source.flush(); expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 }); expect(events.filter(e => e.announcement)).toHaveLength(1)
      const first = h.ledger.page().records[0]!
      await h.owner.read(first.id, first.revision)
      source.observe({ kind: 'save', result: 'unconfirmed', reason: 'capacity' }); await source.source.flush()
      const changed = h.ledger.page().records[0]!
      expect(changed.id).toBe(first.id); expect(changed.eventId).not.toBe(first.eventId); expect(changed.detail).toContain('空间不足'); expect(h.ledger.page().summary.unread).toBe(1)
      source.observe({ kind: 'save', result: 'confirmed' }); await source.source.flush()
      expect(h.ledger.page().records[0]?.state).toBe('resolved')
      source.observe({ kind: 'save', result: 'unconfirmed', reason: 'readonly' }); await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
      await source.close()
      const restarted = new UsageStorageNotifications(h.owner, () => 20000)
      try {
        const count = events.filter(e => e.announcement).length
        restarted.observe({ kind: 'load', result: 'empty' }); restarted.observe({ kind: 'save', result: 'unconfirmed', reason: 'readonly' })
        await restarted.source.flush(); expect(h.ledger.page().summary.total).toBe(2); expect(events.filter(e => e.announcement)).toHaveLength(count)
      } finally { await restarted.close() }
    } finally { await source.close(); await h.owner.close() }
  })
  it('rechecks a missing private acknowledgement without retrying the original file IO', async () => {
    const h = notificationSourceHarness(), source = new UsageStorageNotifications(h.owner, () => 10000), original = h.port.commitSource.bind(h.port)
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('private ACK lost') })
    try {
      source.observe({ kind: 'save', result: 'unconfirmed', reason: 'permission' }); await source.source.flush()
      source.observe({ kind: 'save', result: 'unconfirmed', reason: 'permission' }); await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(1); expect(vi.mocked(h.port.sourceState)).toHaveBeenCalledTimes(2)
      expect(h.owner.status().historyIncomplete).toBe(true)
    } finally { await source.close(); await h.owner.close() }
  })
  it('captures the original final disposal persist failure before sealing the observer, with no quit-time announcement or duplicate save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-usage-quit-')), h = notificationSourceHarness(), source = new UsageStorageNotifications(h.owner, () => 10000)
    const store = new CursorUsageStore(join(dir, 'blocked-parent', 'usage.json'), source), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    let saves = 0
    const tracker = new CursorUsageTracker({ persistSnapshot: snapshot => { saves++; store.save(snapshot) } })
    try {
      mkdirSync(join(dir, 'blocked-parent')); store.load(); await source.source.flush()
      rmSync(join(dir, 'blocked-parent'), { recursive: true }); writeFileSync(join(dir, 'blocked-parent'), 'original fixture blocker')
      const rows: any[] = []
      h.owner.subscribe(e => { if (e.change?.record) rows.push(e.change.record) })
      expect(await drainNotificationsForQuit(h.owner, [() => Promise.resolve().then(() => source.close())], () => tracker.dispose())).toBe(true)
      expect(saves).toBe(1); expect(rows[0]).toMatchObject({ eventType: 'usage.storage-write', subjectState: 'unconfirmed' })
      expect(events.some(e => e.announcement)).toBe(false)
    } finally { await source.close(); await h.owner.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
it('rejects invalid private health checkpoints rather than treating false, null or wrong lanes as recovered', () => {
  for (const value of [{ version: 1, key: 'x', write: false }, { version: 1, key: 'x', history: null }, { version: 1, key: 'x', history: { key: 'usage-storage:write:'+'1'.repeat(64), at: 1, reasons: ['read'] } }])
    expect(() => readUsageStorageState(value, 'x')).toThrow()
})
