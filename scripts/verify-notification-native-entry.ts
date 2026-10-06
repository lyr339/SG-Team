import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { QueueNotifications } from '../src/application/notifications/queue-notifications'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSession, notificationTeam } from './fixtures/notification-session-data'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-native-entry-worker-')), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')), () => 10000)
const question = (status: 'pending' | 'submitted'): ProcessBlock => ({ kind: 'tool', id: 'native-question', status: status === 'pending' ? 'running' : 'done', toolName: 'ask_question',
  question: { toolCallId: 'native-question', status, questions: [{ id: 'q', prompt: 'PRIVATE original question', allowMultiple: false, options: [{ id: 'a', label: 'PRIVATE option' }] }] } })
const original = (patch: Partial<ConversationEntry> = {}): ConversationEntry => ({ id: 'native-entry', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 12000,
  text: 'PRIVATE original body', streamId: 'native-stream', turn: 'native-turn', ...patch })
const team = notificationTeam(), raw = { entryId: 'outbox:native-entry', channelId: '1', runId: 'run-a', createdAt: 5000, held: true }
let questions = new QuestionNotifications(owner, () => 10000)
const replies = new ReplyNotifications(owner, () => 10000)
const queue = new QueueNotifications(owner, () => ({ facts: [raw], historyIncomplete: false }), () => 10000)
const observe = async (entries: ConversationEntry[], channel = '1') => {
  const frame = notificationFrame({ sessions: [notificationSession({ awaitingUser: true, awaitingUserEvidence: 'runtime' })], conversations: { [channel]: entries } })
  questions.observe(frame, team); replies.observe(frame, team); queue.observe(frame, team)
  await Promise.all([questions.flush(), replies.flush(), queue.flush()])
}
try {
  await observe([])
  queue.registerHandoff({ entryId: raw.entryId, targetChannelId: '1', held: true, transcriptPath: '/isolated/original', commandId: 'acceptance-not-delivery', issuedAt: 5000 }, '2')
  await queue.flush()
  for (const patch of [{ source: 'recovery' as const }, { source: 'desktop' as const }, { role: 'user' as const }, { channelId: '2' }]) {
    await observe([original({ ...patch, processBlocks: [question('pending')], replyToEntryId: raw.entryId })])
    const page = await owner.page()
    assert.equal(page.summary.pending, 0); assert.equal(page.summary.total, 1); assert.equal(page.records[0]!.subjectState, 'held')
  }
  const sameEntries = [original({ processBlocks: [question('pending')], replyToEntryId: raw.entryId })]
  await observe(sameEntries, '2')
  assert.equal((await owner.page()).summary.total, 1)
  await observe([original({ channelId: '2', replyToEntryId: raw.entryId })], '2')
  assert.equal((await owner.page({ eventType: 'queue.state' })).records[0]!.subjectState, 'held')
  await observe(sameEntries, '1')
  assert.equal((await owner.page()).summary.pending, 1)
  assert.equal((await owner.page({ eventType: 'queue.state' })).records[0]!.subjectState, 'replied')
  assert.equal((await owner.page({ eventType: 'session.reply' })).summary.total, 1)
  await questions.close(); questions = new QuestionNotifications(owner, () => 20000)
  questions.observe(notificationFrame({ sessions: [notificationSession({ online: false, connected: false, runtimeEvidence: 'suspected', connectionPhase: 'suspected', awaitingUser: false, awaitingUserEvidence: 'unknown' })] }), team)
  await questions.flush(); assert.equal((await owner.page()).summary.pending, 1)
  await observe([original({ source: 'recovery', processBlocks: [question('submitted')], replyToEntryId: raw.entryId })])
  assert.equal((await owner.page()).summary.pending, 1)
  await observe([original({ processBlocks: [question('submitted')], replyToEntryId: raw.entryId })])
  assert.equal((await owner.page()).summary.pending, 0)
  assert.equal(/PRIVATE/.test(JSON.stringify(await owner.page())), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true,
    recoveredDesktopUserAndForeignChannelCannotBecomeNativeResults: true, correctNativePendingAnswerReplyStillAccepted: true,
    sameArrayDifferentTimelineBucketNotAStaleCacheHit: true, explicitOriginalQuestionStateNotReplacedByImport: true,
    pendingQuestionSurvivesObserverRestartAndSuspectedOutage: true,
    noSourceBodyCopiedOrBusinessNetworkRequest: true, isolated: true }, null, 2))
} finally {
  await Promise.allSettled([questions.close(), replies.close(), queue.close()]); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
