import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { registerChannelCommunicationTools } from '../src/mcp/channel-communication-tools'

afterEach(() => vi.useRealTimers())

async function fixture() {
  const repository = new SqliteChannelMessageRepository(':memory:')
  const service = new ChannelMessageService(repository)
  const server = new McpServer({ name: 'sg-progress-test', version: '1' })
  registerChannelCommunicationTools(server, { serviceFor: () => service })
  // Cursor's bundled SDK 1.25.1 negotiates this legacy wire protocol, not the SDK 2 modern era.
  const client = new Client({ name: 'cursor-policy-test', version: '1' }, { supportedProtocolVersions: ['2025-11-25'] })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { repository, client, close: async () => { await client.close(); await server.close(); repository.close() } }
}

describe('long polling with Cursor 3.21.12 idle timeout', () => {
  it('keeps a single call alive past 120s and still returns the normal five-minute keepalive', async () => {
    const { repository, client, close } = await fixture()
    vi.useFakeTimers()
    try {
      const progress = vi.fn()
      let result: Awaited<ReturnType<Client['callTool']>> | undefined
      const call = client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, {
        timeout: 120_000, resetTimeoutOnProgress: true, maxTotalTimeout: 3_600_000, onprogress: progress
      }).then((value) => { result = value; return value })
      await vi.advanceTimersByTimeAsync(240_000)
      expect(result).toBeUndefined()
      expect(progress).toHaveBeenCalledTimes(8)
      expect(repository.getPresence('1')).toMatchObject({ turnCount: 1, connectionPhase: 'waiting' })
      await vi.advanceTimersByTimeAsync(61_000)
      expect((await call).isError).not.toBe(true)
      expect(repository.getPresence('1')).toMatchObject({ turnCount: 1, connectionPhase: 'keepalive' })
      const count = progress.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(progress).toHaveBeenCalledTimes(count)
    } finally { await close() }
  })

  it('keeps parallel channels isolated and stops progress after real message delivery', async () => {
    const { repository, client, close } = await fixture()
    vi.useFakeTimers()
    try {
      const progress1 = vi.fn(), progress2 = vi.fn()
      let result1: unknown, result2: unknown
      const options = { timeout: 120_000, resetTimeoutOnProgress: true, maxTotalTimeout: 3_600_000 }
      const first = client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { ...options, onprogress: progress1 })
        .then((value) => { result1 = value; return value })
      const second = client.callTool({ name: 'check_messages', arguments: { channel_id: '2' } }, { ...options, onprogress: progress2 })
        .then((value) => { result2 = value; return value })
      await vi.advanceTimersByTimeAsync(150_000)
      expect(result1).toBeUndefined(); expect(result2).toBeUndefined()
      repository.enqueueOutbound('1', 'only channel one')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(JSON.stringify(await first)).toContain('only channel one')
      expect(result2).toBeUndefined()
      const deliveredProgress = progress1.mock.calls.length
      repository.enqueueOutbound('2', 'only channel two')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(JSON.stringify(await second)).toContain('only channel two')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(progress1).toHaveBeenCalledTimes(deliveredProgress)
    } finally { await close() }
  })

  it('propagates client cancellation and releases timers and poll abort listeners', async () => {
    const { repository, client, close } = await fixture()
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const progress = vi.fn()
      const call = client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, {
        timeout: 120_000, resetTimeoutOnProgress: true, onprogress: progress, signal: controller.signal
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(90_000)
      controller.abort()
      await vi.advanceTimersByTimeAsync(1_000)
      await call
      expect(repository.getPresence('1')).toMatchObject({ connectionPhase: 'tool_aborted', waiting: false })
      const count = progress.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(progress).toHaveBeenCalledTimes(count)
      expect(vi.getTimerCount()).toBe(0)
    } finally { await close() }
  })
})
