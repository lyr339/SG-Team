import { describe, expect, it, vi } from 'vitest'
import { CursorStreamObserver } from '../src/infrastructure/cursor/cursor-stream-observer'
import { UsageBindingFixtureSocket } from '../scripts/fixtures/usage-binding-socket'
import { UsageBindingNotifications } from '../src/application/notifications/usage-binding-notifications'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import { usageEmissionHook } from '../scripts/fixtures/usage-emission-hook'
const base = () => ({ chatGenerationUUID: 'generation-a', status: 'generating', fullConversationHeadersOnly: [], conversationMap: {}, turnTokenUsage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } })
describe('original hook emission diagnostics before a usage payload exists', () => {
  it('carries an extract-only hint in the same original process frame when a native count getter throws', async () => {
    const data = base(); Object.defineProperty(data, 'turnTokenUsage', { get: () => { throw Error('PRIVATE native getter') } })
    const usage: string[] = [], hook = usageEmissionHook(() => data, value => usage.push(value)); await hook.flush()
    expect(usage).toHaveLength(0)
    expect(hook.frames[0]?.usageEmission).toEqual({ version: 1, reason: 'extract' })
    expect(JSON.stringify(hook.frames)).not.toContain('PRIVATE')
  })
  it('reports an unavailable original usage binding without inventing zero tokens or changing process payload', async () => {
    const hook = usageEmissionHook(base); await hook.flush()
    expect(hook.frames[0]?.usageEmission).toEqual({ version: 1, reason: 'emit' })
    expect(hook.frames[0]?.composerId).toBe('composer-a')
  })
  it('does not call a throwing original emitter twice and sends no raw exception in the fallback hint', async () => {
    let calls = 0
    const hook = usageEmissionHook(base, () => { calls++; throw Error('PRIVATE emitter') }); await hook.flush()
    expect(calls).toBe(1); expect(hook.frames[0]?.usageEmission).toEqual({ version: 1, reason: 'emit' })
    expect(JSON.stringify(hook.frames)).not.toContain('PRIVATE')
  })
  it('absence of a positive payload is normal waiting, not an inferred quota, token or sender failure', async () => {
    const hook = usageEmissionHook(() => ({ fullConversationHeadersOnly: [], conversationMap: {} })); await hook.flush()
    expect(hook.frames[0]?.usageEmission).toBeUndefined()
  })
})

function receiver() {
  const h = notificationSourceHarness(), team = notificationTeam(); let at = 10000
  team.workspaces = [{ id: 'workspace-a', name: 'PRIVATE workspace', path: '/isolated/workspace', createdAt: 1, updatedAt: 1 }]
  const source = new UsageBindingNotifications(h.owner, () => at); source.setTeam(team)
  const socket = new UsageBindingFixtureSocket(), processes = vi.fn(), counts = vi.fn(), samples = vi.fn()
  const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
    locateComposerService: async () => true, disarmLegacyPatch: async () => undefined, usageObserver: source, onProcessEvent: processes, onUsageEvent: counts, onUsageSample: samples })
  const process = (frame: Record<string, unknown>, executionContextId = 1) => socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'sgTeamProcess', executionContextId, payload: JSON.stringify(frame) } }))
  return { h, source, socket, observer, process, processes, counts, samples, at: (value: number) => { at = value },
    close: async () => { observer.dispose(); await source.close(); await h.owner.close() } }
}
describe('emission hints enter the existing verified binding episode, never accounting', () => {
  it.each(['extract', 'emit'] as const)('accepts only repeated %s failures from a verified bound page and recovers only on a real valid usage payload', async reason => {
    const f = receiver()
    try {
      await f.observer.attach(); const commands = f.socket.sent.length
      const frame = { composerId: 'composer-a', observedAt: 1000, usageEmission: { version: 1, reason }, isGenerating: false, response: { id: 'native-response', text: 'PRIVATE original response' } }
      f.process(frame); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
      f.at(16000); f.process(frame); await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(1)
      const first = f.h.ledger.page().records[0]!
      expect(first.detail).toContain(reason === 'extract' ? '页面未能提取原用量载荷' : '页面未确认原 binding 发出载荷')
      expect(f.processes).toHaveBeenCalledTimes(2); expect(f.counts).not.toHaveBeenCalled(); expect(f.samples).not.toHaveBeenCalled()
      f.at(17000); f.process({ ...frame, usageEmission: undefined }); f.socket.usage({ c: 'composer-a', i: 0, o: 0 })
      await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
      f.at(18000); f.socket.usage({ c: 'composer-a', g: 'generation-a', i: 100, o: 10, r: 0, w: 0, t: 18000 }); await f.source.source.flush()
      expect(f.h.ledger.page().records[0]).toMatchObject({ id: first.id, state: 'resolved' })
      expect(f.counts).toHaveBeenCalledTimes(2) // unchanged original legacy zero callback + real payload, never diagnostic counts
      expect(f.socket.sent).toHaveLength(commands); expect(JSON.stringify(f.h.ledger.page())).not.toContain('PRIVATE')
    } finally { await f.close() }
  })
  it('ignores stale/foreign contexts, unbound identities and malformed hints without changing original process callbacks', async () => {
    const f = receiver()
    try {
      await f.observer.attach()
      const frame = { composerId: 'composer-a', observedAt: 1000, usageEmission: { version: 1, reason: 'extract' } }
      for (const at of [10000, 16000]) { f.at(at); f.process(frame, 99); f.process({ ...frame, composerId: 'other-composer' }); f.process({ ...frame, usageEmission: { ...frame.usageEmission, token: 'PRIVATE' } }) }
      await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
      expect(f.processes).toHaveBeenCalledTimes(6); expect(f.counts).not.toHaveBeenCalled()
      f.source.reset(); f.at(20000); f.process(frame); f.at(26000); f.process(frame); await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(1)
    } finally { await f.close() }
  })
  it('a broken diagnostic does not prevent the original process event from reaching its consumer', async () => {
    const f = receiver()
    try {
      await f.observer.attach(); vi.spyOn(f.source, 'begin').mockImplementation(() => { throw Error('PRIVATE observer') })
      f.process({ composerId: 'composer-a', isGenerating: false, usageEmission: { version: 1, reason: 'emit' } })
      expect(f.processes).toHaveBeenCalledOnce(); expect(f.counts).not.toHaveBeenCalled()
    } finally { await f.close() }
  })
})
