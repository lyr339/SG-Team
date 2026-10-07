import { runInNewContext } from 'node:vm'
import { CURSOR_STREAM_HOOK_EXPRESSION } from '../../src/infrastructure/cursor/cursor-stream-observer'
/** Actual embedded hook in an isolated page model; no browser, socket or network. */
export function usageEmissionHook(data: () => Record<string, unknown>, usage?: (payload: string) => void) {
  class Manager { loadedComposers = { ids: ['composer-a'] }; markDirty(): void {} }
  const frames: Array<Record<string, any>> = [], writes: string[] = []
  const context = { Promise, queueMicrotask, setTimeout, clearTimeout, globalThis: {
    __sgComposerService: { composerDataService: { composerDataHandleManager: new Manager(), getComposerDataIfLoaded: data } },
    __sgTeamProcessThrottleMs: 0, sgTeamStream: (id: string) => writes.push(id), sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload)),
    ...(usage ? { __sgTeamUsage: usage } : {})
  } }
  runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
  return { context, frames, writes, flush: async () => { await Promise.resolve(); await Promise.resolve() },
    schedule: () => (context.globalThis as Record<string, any>).__sgTeamProcessSchedule('composer-a') }
}
