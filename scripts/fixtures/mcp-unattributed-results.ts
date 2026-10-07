import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createUnifiedChannelServer } from '../../src/mcp/unified-channel-server'
import { DesktopSessionService } from '../../src/application/desktop-session-service'
import { emptyCursorTelemetrySnapshot } from '../../src/domain/cursor-telemetry'
import { notificationFrame, notificationSession, notificationTeam } from './notification-session-data'
import type { CursorNativeProcessEvent } from '../../src/infrastructure/cursor/cursor-stream-observer'

/** The real desktop projection, with only isolated readers and no production transport or timers. */
export function originalMcpDesktopFixture() {
  const team = notificationTeam(), counts = { telemetry: 0, inspect: 0 }
  team.bindings[0]!.composerId = 'fixture-composer'
  team.workspaces = [{ id: 'workspace-a', name: 'isolated', path: '/isolated/unread-native-workspace', createdAt: 1, updatedAt: 1 }]
  const bridge = notificationFrame({ sessions: [notificationSession({ composerId: 'fixture-composer' })] })
  const service = new DesktopSessionService({ getSnapshot: () => bridge, subscribe: () => () => {}, sendMessage: () => { throw Error('fixture must not send a message') } },
    { getSnapshot: () => team, subscribe: () => () => {}, recordComposerBinding: () => { throw Error('fixture must not change binding') } },
    { readWorkspace: () => { counts.telemetry++; return emptyCursorTelemetrySnapshot() } }, undefined,
    { inspectComposerRuntime: async () => { counts.inspect++; return {} } })
  service.setNativeProcessStreamStatus({ state: 'connected', detail: 'isolated fixture', updatedAt: 1000 })
  service.refreshTelemetry()
  return { team, service, counts, receive: (frame: CursorNativeProcessEvent, at: number) => {
    service.notifyNativeProcessSnapshot({ ...frame, observedAt: at })
    return service.getSnapshot()
  } }
}
/** Actual installed SDK error surfacing, without a business service, socket or real model. */
export async function originalUnattributedMcpResults() {
  let runtimeCalls = 0
  const server = createUnifiedChannelServer({ runtimeFor: () => { runtimeCalls++; throw Object.assign(Error('PRIVATE runtime read'), { code: 'EIO' }) },
    channelServiceFor: () => { throw Error('fixture must not invoke communication') } })
  const client = new Client({ name: 'isolated-unattributed-fixture', version: '1.0.0' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  const invalidArguments = { channel_id: 1, action: 'claim' }, runtimeArguments = { channel_id: '1', action: 'claim' }
  try {
    await server.connect(right); await client.connect(left)
    const invalid = await client.callTool({ name: 'team_task', arguments: invalidArguments })
    const callsBeforeRuntime = runtimeCalls
    const failedRuntime = await client.callTool({ name: 'team_task', arguments: runtimeArguments })
    return { invalid, failedRuntime, invalidArguments, runtimeArguments, callsBeforeRuntime, runtimeCalls }
  } finally { await client.close(); await server.close() }
}
