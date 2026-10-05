import { it, expect } from 'vitest'
import { verifyOriginalMcpWrites } from '../scripts/fixtures/notification-mcp'
import { notificationSourceHarness } from './notification-source-fixtures'
it('preserves original MCP/SQLite results through both real native hook shapes without business reads, writes or retries from observation', async () => {
  const h = notificationSourceHarness()
  try { expect(await verifyOriginalMcpWrites(h.owner)).toMatchObject({ realOriginalMcpServer: true, realNativeHookModernAndLegacy: true, definitions: 9 }) }
  finally { await h.owner.close() }
})
