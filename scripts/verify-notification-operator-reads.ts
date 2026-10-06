import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamCollaborationService } from '../src/application/team-collaboration-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { connectOperatorMessageNotifications } from '../src/application/notifications/team-message-notifications'
import { connectNativeScopeAvailabilityNotifications } from '../src/application/notifications/native-scope-availability'
import { operatorMessageIds, readOperatorMessageState, type OperatorMessageState } from '../src/domain/team-message-notification'
import { operatorMessageNativeFields, operatorMessageNotificationDigest } from '../src/domain/operator-message-read'
import type { NotificationPush } from '../src/domain/notification'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-operator-read-worker-')), path = join(directory, 'business.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
const events: NotificationPush[] = []; owner.subscribe(value => events.push(value))
const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function open() {
  const repository = new SqliteTeamControlRepository(path), messageRepository = new SqliteTeamCollaborationRepository(path)
  const control = new TeamControlService(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => { throw Error('must not send/replay a business command') } })
  const messages = new TeamCollaborationService(messageRepository, control)
  const source = connectOperatorMessageNotifications(messages, () => { throw Error('must reuse original collaboration context') }, owner)
  const other = { flush: async () => {}, invalidateCheckpoint: () => {} }, scopes = connectNativeScopeAvailabilityNotifications(control, owner,
    { 'operator-messages:': source.source, 'task-notifications:': other, 'memory-issues:': other, 'group-topology:': other })
  let closed = false, teamReads = 0, messageReads = 0
  const getTeam = control.getSnapshot.bind(control), load = messageRepository.loadRun.bind(messageRepository)
  control.getSnapshot = () => { ++teamReads; return getTeam() }; messageRepository.loadRun = (...args) => { ++messageReads; return load(...args) }
  return { repository, messageRepository, control, messages, source, scopes, counts: () => ({ teamReads, messageReads }),
    flush: async () => { await source.source.flush(); await scopes.flush(); await owner.flush() },
    close: async () => { if (closed) return; closed = true; await Promise.all([source.close(), scopes.close()]); messages.dispose(); control.dispose(); messageRepository.close(); repository.close() } }
}
let current = open(), database: DatabaseSync | undefined
try {
  current.control.getSnapshot(); await current.flush()
  const vacant = join(directory, 'without-run.sqlite'), populated = join(directory, 'with-run.sqlite')
  vacuumDatabaseInto(path, vacant)
  const team = current.control.createSessionPool({ workspaceId: 'operator-workspace', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor',
    members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }] })
  const runId = team.activeRun!.id, slotId = team.members[0]!.slot.id, group = current.repository.createGroup({ runId, name: 'fixture group', members: [{ slotId, roleTemplateKey: 'builder' }], at: 1 }).group
  const rows = Array.from({ length: 231 }, (_, index) => current.messageRepository.createMessage({ runId, groupId: group.id, sender: { type: 'agent', slotId }, recipient: { type: 'operator' }, kind: 'question',
    subject: `original-${index}`, content: 'PRIVATE original body never copied to notification state', clientMessageId: `operator-read-${index}` }))
  const beforeRead = current.counts(), original = current.messages.getSnapshot(); await current.flush()
  assert.equal(current.counts().teamReads - beforeRead.teamReads, 1); assert.equal(current.counts().messageReads - beforeRead.messageReads, 1)
  assert.equal((await owner.page({ eventType: 'team.operator-message' })).summary.total, 231)
  const originalSourceKey = `operator-messages:${hash([team.activeWorkspaceId, runId])}`, checkpoint = readOperatorMessageState((await owner.sourceState(originalSourceKey)).data, originalSourceKey)!
  assert.equal(checkpoint.seenEncoding, 'team-message-uuid'); assert.equal(operatorMessageIds(checkpoint).length, 231)
  const active = (await owner.page({ key: `operator-message:${rows[0]!.id}` })).records[0]!
  const firstNative = original.messages[rows[0]!.id]!, firstSubject = original.threads.find(thread => thread.id === firstNative.threadId)?.subject
  assert.deepEqual(operatorMessageNativeFields(firstNative, firstSubject), [firstNative.id, firstNative.kind, firstNative.createdAt, firstNative.sender.type === 'agent' ? firstNative.sender.slotId : undefined,
    firstNative.groupId, firstNative.threadId, firstSubject]) // Existing durable native tuple, not a new body/receipt hash.
  assert.equal(operatorMessageNotificationDigest(active), hash(operatorMessageNativeFields(firstNative, firstSubject)))
  const readReceipt = await owner.read(active.id, active.revision)
  assert.equal(readReceipt.record?.readRevision, active.attentionRevision)
  const counts = current.counts(), committed = (await owner.sourceState(originalSourceKey)).revision
  for (let index = 0; index < 100; index++) current.messages.getSnapshot()
  await current.flush(); assert.equal(current.counts().teamReads - counts.teamReads, 100); assert.equal(current.counts().messageReads - counts.messageReads, 100)
  assert.equal((await owner.sourceState(originalSourceKey)).revision, committed)
  const announcements = events.filter(value => value.announcement).length
  database = new DatabaseSync(path)
  database.prepare("UPDATE team_messages SET kind='response' WHERE id=?").run(rows[0]!.id)
  database.prepare('UPDATE team_message_threads SET subject=? WHERE id=?').run('current same-counter subject', rows[0]!.threadId)
  const changed = current.messages.getSnapshot(); await current.flush(); assert.equal(changed.revision, original.revision)
  const rechecked = (await owner.page({ key: `operator-message:${rows[0]!.id}` })).records[0]!
  assert.equal(rechecked.id, active.id); assert.equal(rechecked.subjectState, 'response'); assert.notEqual(rechecked.eventId, active.eventId); assert.match(rechecked.detail!, /current same-counter subject/)
  assert.equal(rechecked.attentionRevision, active.attentionRevision); assert.equal(rechecked.readRevision, readReceipt.record?.readRevision)
  assert.equal(changed.messages[rows[0]!.id]?.receipt.readAt, undefined)
  const changedNative = changed.messages[rows[0]!.id]!, changedSubject = changed.threads.find(thread => thread.id === changedNative.threadId)?.subject
  assert.equal(operatorMessageNotificationDigest(rechecked), hash(operatorMessageNativeFields(changedNative, changedSubject)))
  assert.notEqual(operatorMessageNotificationDigest(rechecked), operatorMessageNotificationDigest(active))
  vacuumDatabaseInto(path, populated)
  database.prepare('DELETE FROM team_messages WHERE id=?').run(rows[1]!.id)
  current.messages.getSnapshot(); await current.flush()
  const missing = (await owner.page({ key: `operator-message:${rows[1]!.id}` })).records[0]!
  assert.equal(missing.subjectState, 'prior-data'); assert.equal(missing.state, 'expired'); assert.equal(missing.scope.groupId, group.id); assert.equal(missing.target, undefined)
  database.close(); database = undefined
  await current.close(); copyFileSync(vacant, path); current = open()
  current.control.getSnapshot(); await current.flush()
  assert.equal((await owner.page({ key: `operator-message:${rows[0]!.id}` })).records[0]?.subjectState, 'scope-unconfirmed')
  await current.close(); copyFileSync(populated, path); current = open()
  current.control.getSnapshot(); await current.flush()
  assert.equal((await owner.page({ key: `operator-message:${rows[0]!.id}` })).records[0]?.subjectState, 'scope-unconfirmed')
  const restored = current.messages.getSnapshot(); await current.flush()
  assert.equal((await owner.page({ key: `operator-message:${rows[0]!.id}` })).records[0]?.subjectState, 'response')
  assert.equal(events.filter(value => value.announcement).length, announcements)
  assert.equal(restored.messages[rows[0]!.id]?.receipt.readAt, undefined); assert.equal(restored.messages[rows[0]!.id]?.receipt.respondedAt, undefined)
  assert.equal(/PRIVATE original body/.test(JSON.stringify(await owner.page())), false)
  // Isolated PRIVATE capacity proof, after the final original frame. No fake
  // business messages or 50,000-request replay are needed to test the real RPC/storage limit.
  const capacityKey = `operator-messages:${hash(['capacity-workspace', 'capacity-run'])}`
  const ids = Array.from({ length: 50_000 }, (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`)
  const sized: OperatorMessageState = { version: 2, key: capacityKey, seenEncoding: 'team-message-uuid', seen: ids }
  assert.ok(Buffer.byteLength(JSON.stringify(sized)) < 2 * 1024 * 1024)
  assert.equal((await owner.commitSource(capacityKey, 0, sized, [])).applied, true)
  assert.deepEqual(operatorMessageIds(readOperatorMessageState((await owner.sourceState(capacityKey)).data, capacityKey)!), ids.map(id => `team-message:${id}`))
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalCollaborationAndTeamServices: true,
    originalOneTeamReadAndOneMessageReadPreserved: true, stable100OriginalReadsNoPrivateRewrites: true, equalCounterThinContentReconciled: true,
    missingRecordAndWholeScopeNotClaimedRespondedOrDeleted: true, crossRestartHistoryNeedsSpecificOriginalRead: true,
    exactSharedThinNativeDigest: true, agentReceiptsUntouched: true, noBodyCopied: true, noHistoricalAlertsReplayed: true, realRpcStores50000NativeFormatIdentitiesUnderOriginal2MiBLimit: true, isolated: true }, null, 2))
} finally {
  database?.close(); await current.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
