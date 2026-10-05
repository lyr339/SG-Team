import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { verifyOriginalMcpWrites } from './fixtures/notification-mcp'
// Compiled notification worker only. NEVER boot production main or a real Cursor.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out', 'main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-notification-mcp-worker-')), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
try { console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true, ...await verifyOriginalMcpWrites(owner) }, null, 2)) }
finally {
  await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
