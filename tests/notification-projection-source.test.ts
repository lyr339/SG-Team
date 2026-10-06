import { describe, expect, it, vi } from 'vitest'
import { NotificationProjectionSource } from '../src/application/notifications/projection-source'
import { notificationSourceHarness } from './notification-source-fixtures'

describe('shared projection durability transport', () => {
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
