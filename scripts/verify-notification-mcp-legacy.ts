import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { verifyOriginalMcpWrites } from './fixtures/notification-mcp'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readMcpWriteState } from '../src/domain/mcp-write-notification'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-mcp-legacy-worker-')), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
try {
  const facts = await verifyOriginalMcpWrites(owner, { legacyComparison: true })
  const hash = (value: string) => createHash('sha256').update(value).digest('hex'), key = `mcp-write-source:${hash('capacity')}`
  const sized = { version: 2 as const, key, seen: Array.from({ length: 20000 }, (_, i) => `~${hash(`native-${i}`)}`),
    attentionFamilies: Array.from({ length: 10000 }, (_, i) => hash(`family-${i}`)) }
  assert.ok(Buffer.byteLength(JSON.stringify(sized)) < 2 * 1024 * 1024)
  assert.equal((await owner.commitSource(key, 0, sized, [])).applied, true)
  const restored = readMcpWriteState((await owner.sourceState(key)).data, key)!
  assert.deepEqual(restored.seen, sized.seen); assert.deepEqual(restored.attentionFamilies, sized.attentionFamilies)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true, ...facts,
    realOriginalTwoMiBRpcWith20000InspectedIdsAnd10000Families: true }, null, 2))
}
finally {
  await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
