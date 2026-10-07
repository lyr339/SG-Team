import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SqliteChannelMessageRepository } from '../../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageRelay } from '../../src/application/channel-message-relay'
import { vacuumDatabaseInto } from '../../src/infrastructure/app-update/update-backup'
import { notificationFrame, notificationSession, notificationTeam } from './notification-session-data'

/** Exact original reply row in an isolated SQLite backup; never a user's data or business service. */
export function originalReplyStore() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-reply-original-')), path = join(directory, 'channels.sqlite'), backup = join(directory, 'before.sqlite')
  const open = () => {
    const repository = new SqliteChannelMessageRepository(path), relay = new ChannelMessageRelay(repository, () => 4000)
    repository.markChannelEmbedded('1', 'workspace-a', '/PRIVATE/fixture'); relay.resetScope('run-a', 1)
    return { repository, relay }
  }
  let current = open()
  const reply = current.repository.recordReply({ channelId: '1', content: 'PRIVATE original older reply', outboundId: 'original-outbound' }, 2000)
  current.relay.pollReplies(); vacuumDatabaseInto(path, backup)
  const reopen = () => { current.relay.stop(); current.repository.close(); current = open() }
  return { directory, path, backup, team: notificationTeam(), entryId: `reply:${reply.id}`, current: () => current,
    replaceBody: (content: string) => { const db = new DatabaseSync(path); try { db.prepare('UPDATE channel_replies SET content=? WHERE id=?').run(content, reply.id) } finally { db.close() }; reopen() },
    restore: () => { current.relay.stop(); current.repository.close(); copyFileSync(backup, path); current = open() },
    frame: () => ({ ...current.relay.applyTo(notificationFrame()), sessions: [notificationSession()] }),
    close: () => { current.relay.stop(); current.repository.close(); rmSync(directory, { recursive: true, force: true }) } }
}
