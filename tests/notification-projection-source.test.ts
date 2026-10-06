import { describe, expect, it, vi } from 'vitest'
import { NotificationProjectionSource } from '../src/application/notifications/projection-source'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { NotificationRepositoryLifecycle } from '../src/application/notification-repository'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function lifecycleHarness(path = ':memory:') {
  let receive!: (event: NotificationRepositoryLifecycle) => void
  const h = notificationSourceHarness(path, listener => { receive = listener; return () => {} })
  return { ...h, lifecycle: (event: NotificationRepositoryLifecycle) => receive(event) }
}

describe('shared projection durability transport', () => {
  it('known private checkpoint invalidation fences an already returned but delayed read and reloads without a false history gap', async () => {
    const h = notificationSourceHarness(), projected = vi.fn()
    const baselines: boolean[] = []
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { const old = h.ledger.sourceState(key); entered(); await gate; return old })
    const source = new NotificationProjectionSource<number, { value: number; repaired?: boolean }>(h.owner, value => value as { value: number; repaired?: boolean } | undefined,
      (old, value, baseline) => { baselines.push(baseline); return { state: { ...old, value }, drafts: [] } }, String, projected)
    try {
      source.observe('source:a', 1); await waiting
      h.ledger.commitSource('source:a', 0, { value: 0, repaired: true }, [], 1)
      source.invalidateCheckpoint('source:a'); release(); await source.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 2, data: { value: 1, repaired: true } })
      expect(projected).toHaveBeenCalledExactlyOnceWith(1, { value: 1, repaired: true })
      expect(h.port.sourceState).toHaveBeenCalledTimes(2); expect(h.owner.status().historyIncomplete).toBe(false)
      source.observe('source:a', 2); await source.flush(); expect(baselines).toEqual([true, false])
    } finally { release(); await source.close(); await h.owner.close() }
  })
  it('a delayed successful ACK cannot cache over a newer external private CAS or release the stale projected callback', async () => {
    const h = notificationSourceHarness(), projected = vi.fn()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { const result = h.ledger.commitSource(...args); entered(); await gate; return result })
    const source = new NotificationProjectionSource<number, { value: number; repaired?: boolean }>(h.owner, value => value as { value: number; repaired?: boolean } | undefined,
      (old, value) => ({ state: { ...old, value }, drafts: [] }), String, projected)
    try {
      source.observe('source:a', 1); await waiting
      h.ledger.commitSource('source:a', 1, { value: 1, repaired: true }, [], 1)
      source.invalidateCheckpoint('source:a'); release(); await source.flush()
      expect(h.ledger.sourceState('source:a').revision).toBe(2)
      expect(projected).toHaveBeenCalledExactlyOnceWith(1, { value: 1, repaired: true })
      const reads = vi.mocked(h.port.sourceState).mock.calls.length
      source.observe('source:a', 1); await source.flush(); expect(h.port.sourceState).toHaveBeenCalledTimes(reads)
      expect(h.owner.status().historyIncomplete).toBe(false)
    } finally { release(); await source.close(); await h.owner.close() }
  })
  it('a new private storage generation invalidates cached identical source input and reprojects from the actual checkpoint, quietly and only on another real frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-projection-epoch-')), path = join(dir, 'notifications.sqlite'), h = lifecycleHarness(path)
    const baselines: boolean[] = []
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value, baseline) => { baselines.push(baseline); return { state: value, drafts: [] } }, String)
    let database: DatabaseSync | undefined
    try {
      h.lifecycle({ state: 'recovered', generation: 1 }); await h.owner.flush()
      expect(h.owner.sourceStorageEpoch()).toBe(0) // Original first ready, not a false lost initialization.
      source.observe('source:a', 1); source.observe('source:b', 2); await source.flush()
      const initialQueries = vi.mocked(h.port.sourceState).mock.calls.length
      source.observe('source:a', 1); await source.flush(); expect(h.port.sourceState).toHaveBeenCalledTimes(initialQueries)
      h.lifecycle({ state: 'unavailable', generation: 1 })
      database = new DatabaseSync(path)
      database.exec("DELETE FROM desktop_notification_sources WHERE source_key IN ('source:a','source:b')")
      database.close(); database = undefined
      h.lifecycle({ state: 'recovered', generation: 2 }); await h.owner.flush()
      expect(h.owner.sourceStorageEpoch()).toBe(1)
      expect(h.port.sourceState).toHaveBeenCalledTimes(initialQueries) // No timer or automatic source replay.
      source.observe('source:a', 1); source.observe('source:b', 2); await source.flush()
      expect(h.port.sourceState).toHaveBeenCalledTimes(initialQueries + 2)
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 1, data: 1 })
      expect(h.ledger.sourceState('source:b')).toMatchObject({ revision: 1, data: 2 })
      expect(baselines).toEqual([true, true, true, true])
      const after = vi.mocked(h.port.sourceState).mock.calls.length
      for (let index = 0; index < 300; index++) { source.observe('source:a', 1); source.observe('source:b', 2) }
      await source.flush(); expect(h.port.sourceState).toHaveBeenCalledTimes(after)
    } finally { database?.close(); await source.close(); await h.owner.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('a late old private read cannot cache or deduplicate away a matching genuine frame already received for the new generation', async () => {
    const h = lifecycleHarness(), projected = vi.fn()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async () => { entered(); await held; return { revision: 91, data: 999 } })
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value) => ({ state: value, drafts: [] }), String, projected)
    try {
      source.observe('source:a', 1); await waiting
      h.lifecycle({ state: 'unavailable', generation: 1 }); h.lifecycle({ state: 'recovered', generation: 2 })
      source.observe('source:a', 1); release(); await source.flush(); await h.owner.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 1, data: 1 })
      expect(h.port.sourceState).toHaveBeenCalledTimes(2)
      expect(projected).toHaveBeenCalledExactlyOnceWith(1, 1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('a late old applied confirmation is an unknown outcome, not a projected callback or live announcement in the replacement generation', async () => {
    const h = lifecycleHarness(), projected = vi.fn(), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    let release!: (value: any) => void, entered!: () => void
    const waiting = new Promise<void>(done => { entered = done }), held = new Promise<any>(done => { release = done })
    vi.mocked(h.port.commitSource).mockImplementationOnce(async () => { entered(); return await held })
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value) => ({ state: value, drafts: [] }), String, projected)
    try {
      source.observe('source:a', 1); await waiting
      h.lifecycle({ state: 'unavailable', generation: 1 }); h.lifecycle({ state: 'recovered', generation: 2 })
      release({ applied: true, source: { revision: 91, data: 1 }, changes: [] }); await source.flush(); await h.owner.flush()
      expect(projected).not.toHaveBeenCalled(); expect(events.filter(event => event.announcement)).toHaveLength(0)
      source.observe('source:a', 1); await source.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 1, data: 1 }); expect(projected).toHaveBeenCalledExactlyOnceWith(1, 1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('original source requests accepted during unavailable can wait for replacement readiness without being falsely rejected as old requests', async () => {
    const h = lifecycleHarness()
    let release!: () => void
    const held = new Promise<void>(done => { release = done })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { await held; return h.ledger.sourceState(key) })
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value) => ({ state: value, drafts: [] }), String)
    try {
      h.lifecycle({ state: 'unavailable', generation: 1 })
      source.observe('source:a', 1)
      h.lifecycle({ state: 'recovered', generation: 2 }); release(); await source.flush(); await h.owner.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 1, data: 1 }); expect(h.port.sourceState).toHaveBeenCalledOnce()
    } finally { await source.close(); await h.owner.close() }
  })
  it('publishes a private projection callback only after proven state, including unknown-ACK reload, and callback failures do not invalidate committed state', async () => {
    const h = notificationSourceHarness(), projected = vi.fn(), original = h.port.commitSource.bind(h.port)
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value) => ({ state: value, drafts: [] }), String, projected)
    try {
      vi.mocked(h.port.commitSource).mockRejectedValueOnce(Error('not written'))
      source.observe('source:a', 1); await source.flush(); expect(projected).not.toHaveBeenCalled()
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('ACK lost') })
      source.observe('source:a', 1); await source.flush(); expect(projected).not.toHaveBeenCalled()
      source.observe('source:a', 1); await source.flush(); expect(projected).toHaveBeenCalledExactlyOnceWith(1, 1)
      projected.mockImplementationOnce(() => { throw Error('observer failure after commit') })
      source.observe('source:a', 2); await source.flush()
      expect(h.ledger.sourceState('source:a').data).toBe(2)
      const loads = vi.mocked(h.port.sourceState).mock.calls.length
      source.observe('source:a', 3); await source.flush(); expect(h.port.sourceState).toHaveBeenCalledTimes(loads)
    } finally { await source.close(); await h.owner.close() }
  })
  it('a failed continuation retains only the committed partial checkpoint and resumes on the next real frame', async () => {
    const h = notificationSourceHarness()
    let writes = 0
    vi.mocked(h.port.commitSource).mockImplementation(async (key, expected, data, drafts, now) => {
      if (++writes === 2) throw Error('second batch rejected')
      return h.ledger.commitSource(key, expected, data, drafts, now)
    })
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (old = 0, input) => ({ state: Math.min(input, old + 100), drafts: [], complete: old + 100 >= input }), String)
    try {
      source.observe('source:a', 230); await source.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 1, data: 100 })
      source.observe('source:a', 230); await source.flush()
      expect(h.ledger.sourceState('source:a')).toMatchObject({ revision: 3, data: 230 })
    } finally { source.stop(); await h.owner.close() }
  })
  it('preserves A/B/A transitions and coalesces equivalent interleaved heartbeats during a slow load', async () => {
    const h = notificationSourceHarness()
    let ready!: () => void
    const gate = new Promise<void>(resolve => { ready = resolve })
    vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { await gate; return h.ledger.sourceState(key) })
    const source = new NotificationProjectionSource<number, { values: number[] }>(h.owner, value => value as { values: number[] } | undefined,
      (old, value) => ({ state: old?.values.at(-1) === value ? old : { values: [...old?.values ?? [], value] }, drafts: [] }), String)
    try {
      source.observe('source:a', 0); source.observe('source:b', 0)
      for (let index = 0; index < 500; index++) { source.observe('source:a', 0); source.observe('source:b', 0) }
      source.observe('source:a', 1); source.observe('source:a', 0); ready(); await source.flush()
      expect(h.ledger.sourceState('source:a').data).toEqual({ values: [0, 1, 0] })
      expect((await h.owner.page()).historyIncomplete).toBe(false)
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      source.observe('source:a', 0); await source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(count)
    } finally { source.stop(); await h.owner.close() }
  })
  it('does not advance a failed checkpoint; retries only on a new source frame and reloads unknown outcomes', async () => {
    const h = notificationSourceHarness(); const reduce = vi.fn((old: number | undefined, value: number) => ({ state: value, drafts: [] }))
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined, reduce, String)
    try {
      vi.mocked(h.port.commitSource).mockRejectedValueOnce(Error('store not writable'))
      source.observe('source:a', 1); await source.flush()
      expect(h.ledger.sourceState('source:a').revision).toBe(0)
      expect(h.port.commitSource).toHaveBeenCalledTimes(1)
      source.observe('source:a', 1); await source.flush()
      expect(h.ledger.sourceState('source:a').data).toBe(1)
      expect(h.port.sourceState).toHaveBeenCalledTimes(2)
      expect((await h.owner.page()).historyIncomplete).toBe(true)
    } finally { source.stop(); await h.owner.close() }
  })
  it('rebases a CAS conflict from the actual durable source instead of overwriting it', async () => {
    const h = notificationSourceHarness()
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (key, expected, data, drafts, now) => {
      h.ledger.commitSource(key, expected, { values: [10] }, [], now)
      return h.ledger.commitSource(key, expected, data, drafts, now)
    })
    const source = new NotificationProjectionSource<number, { values: number[] }>(h.owner, value => value as { values: number[] } | undefined,
      (old, value) => ({ state: { values: [...old?.values ?? [], value] }, drafts: [] }), String)
    try {
      source.observe('source:a', 20); await source.flush()
      expect(h.ledger.sourceState('source:a').data).toEqual({ values: [10, 20] })
    } finally { source.stop(); await h.owner.close() }
  })
  it('consumes one wake baseline even when the first wake frame is otherwise unchanged', async () => {
    const h = notificationSourceHarness(); const baselines: boolean[] = []
    const source = new NotificationProjectionSource<number, number>(h.owner, value => value as number | undefined,
      (_old, value, baseline) => { baselines.push(baseline); return { state: value, drafts: [] } }, String)
    try {
      source.observe('source:a', 0); await source.flush()
      source.quietNextObservation(); source.observe('source:a', 0); await source.flush()
      source.observe('source:a', 1); await source.flush()
      expect(baselines).toEqual([true, true, false])
    } finally { source.stop(); await h.owner.close() }
  })
})
