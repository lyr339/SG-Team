import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { observedMcpWrite, mcpWriteReadIdentity } from '../src/domain/mcp-write-observation'
import { reduceMcpWriteNotifications } from '../src/domain/mcp-write-notification'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-source-reading-worker-')), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
const scope = { sessionId: 'fixture-session', channelId: '1', generation: '1', bindingGeneration: 'fixture-binding', composerId: 'fixture-composer' }
const proof = observedMcpWrite('mcp-SG Team-team_memory', { channel_id: '1', action: 'review', memoryId: 'fixture-memory' },
  JSON.stringify({ ok: false, agentSessionId: 'fixture-agent', code: 'internal_error', sgWriteFailure: { version: 1, reason: 'storage' } }))!
const eventType = 'mcp.write-result', key = 'fixture-source-read', total = 431
try {
  let sourceRevision = 0
  for (let start = 0; start < total; start += 100) {
    const facts = Array.from({ length: Math.min(100, total - start) }, (_, index) => ({ ...proof, identity: (index + start + 1).toString(16).padStart(64, '0'), attentionKey: (index + start + 1000).toString(16).padStart(64, '0'),
      blockId: `native-${index + start}`, scope, at: 1_000, name: 'fixture native tool' }))
    const projection = reduceMcpWriteNotifications(undefined, { key, facts, now: 1_000, monitorStartedAt: 2_000, signature: 'fixture' }, true, sourceRevision + 1)
    const result = await owner.commitSource(key, sourceRevision, { saved: start + facts.length }, projection.drafts)
    assert.equal(result.applied, true); sourceRevision = result.source.revision
  }
  let page = await owner.page({ sessionId: scope.sessionId, eventType, filter: 'unread', readCursor: 'start', limit: 37 })
  const ceiling = page.nextReadCursor!.ceiling, seen = new Set<string>(), events: NotificationPush[] = []
  const stop = owner.subscribe(event => events.push(event))
  let pages = 0
  for (;;) {
    ++pages; assert.equal(page.reset, false)
    for (const record of page.records) {
      assert.equal(seen.has(record.id), false); seen.add(record.id)
      assert.equal(record.target?.kind, 'session'); if (record.target?.kind !== 'session') throw Error('native reference lost')
      assert.equal(mcpWriteReadIdentity(record.target.mcpWrite!), mcpWriteReadIdentity(proof))
      // Backend traversal/receipt proof only. Renderer visibility/concurrency
      // belongs to DOM tests and CUA; this script does not pretend to see a UI.
      assert.equal((await owner.read(record.id, record.revision)).record?.readRevision, record.attentionRevision)
    }
    if (!page.nextReadCursor) break
    assert.equal(page.nextReadCursor.ceiling, ceiling)
    page = await owner.page({ sessionId: scope.sessionId, eventType, filter: 'unread', readCursor: page.nextReadCursor, limit: 37 })
  }
  assert.equal(pages, 12); assert.equal(seen.size, total); assert.equal((await owner.page()).summary.unread, 0)
  assert.equal(events.some(event => event.announcement), false); stop()
  const base: NotificationDraft = { key: 'late-result', category: 'run', source: 'fixture', title: 'first result', scope: {}, tone: 'info', attention: 'notice', state: 'resolved', occurredAt: 1_000, sourceRevision: 1 }
  await owner.commitSource('late-source', 0, { stage: 1 }, [base])
  const first = (await owner.page({ key: base.key })).records[0]!
  await owner.commitSource('late-source', 1, { stage: 2 }, [{ ...base, title: 'new important result', tone: 'warning', sourceRevision: 2, renewAttention: true }])
  assert.equal((await owner.read(first.id, first.revision)).changed, false)
  assert.equal((await owner.page({ key: base.key })).summary.unread, 1)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true,
    stablePrivateKeysetAcross431ReadMutations: true, twelvePagesWithoutOffsetResetOrSkippedRecords: true, exactNativeProofPersisted: true,
    lateOldReadCannotConsumeNewAttentionVersion: true, noHistoricalAnnouncementOrOriginalBusinessRequest: true,
    rendererVisibilityNotClaimedByBackendScript: true, isolated: true }, null, 2))
} finally {
  await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
