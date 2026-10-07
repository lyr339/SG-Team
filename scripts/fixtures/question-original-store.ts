import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteChannelMessageRepository } from '../../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageRelay } from '../../src/application/channel-message-relay'
import { notificationFrame, notificationSession, notificationTeam } from './notification-session-data'
import { vacuumDatabaseInto } from '../../src/infrastructure/app-update/update-backup'
import type { ProcessBlockTool } from '../../src/domain/conversation-entry'

/** Original channel SQL/relay restoration only; never a real account or Cursor. */
export function originalQuestionStore() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-question-original-')), path = join(directory, 'channels.sqlite'), backup = join(directory, 'original-pending.sqlite')
  let at = 2000
  const team = notificationTeam()
  const open = () => {
    const repository = new SqliteChannelMessageRepository(path), relay = new ChannelMessageRelay(repository, () => at)
    repository.markChannelEmbedded('1', 'workspace-a', '/PRIVATE/fixture'); relay.resetScope('run-a', 1)
    return { repository, relay }
  }
  let current = open()
  const original = current.repository.recordReply({ channelId: '1', content: 'PRIVATE original body' }, at)
  current.relay.pollReplies()
  const entryId = `reply:${original.id}`, toolCallId = 'original-question', blockId = 'native:original-question'
  const block = (status: 'pending' | 'submitted' | 'cancelled'): ProcessBlockTool => ({ kind: 'tool', id: blockId, toolName: 'ask_question', toolKind: 'question',
    status: status === 'pending' ? 'running' : 'done', startedAt: 1500, question: { toolCallId, status, questions: [{ id: 'q', prompt: 'PRIVATE prompt', allowMultiple: false,
      options: [{ id: 'a', label: 'PRIVATE option' }] }] } })
  const setStatus = (status: 'pending' | 'submitted' | 'cancelled') => {
    at += 1000
    if (!current.relay.attachProcessToReply(entryId, { turn: 'native:original-turn', blocks: [block(status)], startedAt: 1500, updatedAt: at, generating: status === 'pending' }))
      throw Error('fixture original SQL row missing')
  }
  setStatus('pending'); vacuumDatabaseInto(path, backup)
  return { directory, path, backup, team, entryId, toolCallId, blockId, block, setStatus,
    current: () => current,
    frame: (waiting = true) => ({ ...current.relay.applyTo(notificationFrame()),
      // Explicit isolated runtime facts come AFTER the original relay's base
      // presence projection, just as desktop enriches it. Not an SQL inference.
      sessions: [notificationSession({ awaitingUser: waiting, awaitingUserEvidence: 'runtime' })] }),
    restorePending: () => { current.relay.stop(); current.repository.close(); copyFileSync(backup, path); current = open() },
    close: () => { current.relay.stop(); current.repository.close(); rmSync(directory, { recursive: true, force: true }) } }
}
