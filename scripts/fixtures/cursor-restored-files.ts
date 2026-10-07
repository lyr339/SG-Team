import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CursorComposerTelemetryReader } from '../../src/infrastructure/cursor/cursor-composer-telemetry'
import { notificationTeam } from './notification-session-data'

/** Real miniature Cursor DB/files, never the user's installation or accounts. */
export function cursorRestoredFiles(shape: 'legacy' | 'table') {
  const directory = mkdtempSync(join(tmpdir(), 'sg-cursor-restored-files-')), path = join(directory, 'state.vscdb')
  const workspace = join(directory, 'workspace'), projectsRoot = join(directory, 'projects'), workspaces = join(directory, 'workspaces')
  mkdirSync(workspace); mkdirSync(projectsRoot); mkdirSync(workspaces)
  const team = notificationTeam(), binding = team.bindings[0]!, composerId = binding.composerId!
  team.workspaces = [{ id: binding.workspaceId, name: 'isolated', path: workspace, createdAt: 1, updatedAt: 1 }]
  const nativeHeader = (additions: number) => ({ composerId, name: 'PRIVATE original', createdAt: 1000, lastUpdatedAt: 2000,
    totalLinesAdded: additions, workspaceIdentifier: { uri: { fsPath: workspace } } })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);')
  db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser', '{}')
  if (shape === 'table') {
    db.exec('CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT)')
    db.prepare('INSERT INTO composerHeaders VALUES(?,?)').run(composerId, JSON.stringify(nativeHeader(11)))
    db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('composer.composerHeaders.version', 'same-native-version')
  } else db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('composer.composerHeaders', JSON.stringify({ allComposers: [nativeHeader(11)] }))
  db.prepare('INSERT INTO cursorDiskKV VALUES(?,?)').run(`composerData:${composerId}`, JSON.stringify({ contextTokensUsed: 3000, contextTokenLimit: 10000 }))
  db.close()
  const old = join(directory, 'branch-old.sqlite'), next = join(directory, 'branch-next.sqlite')
  copyFileSync(path, old); copyFileSync(path, next)
  const updateBranch = (file: string, additions: number, used: number) => {
    const writer = new DatabaseSync(file)
    try {
      writer.exec('BEGIN')
      if (shape === 'table') writer.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify(nativeHeader(additions)), composerId)
      else writer.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(JSON.stringify({ allComposers: [nativeHeader(additions)] }), 'composer.composerHeaders')
      writer.prepare('UPDATE cursorDiskKV SET value=? WHERE key=?').run(JSON.stringify({ contextTokensUsed: used, contextTokenLimit: 10000 }), `composerData:${composerId}`)
      writer.exec('COMMIT')
    } finally { writer.close() }
  }
  // Sibling backups intentionally share SQLite change counter, size and sentinel.
  updateBranch(old, 22, 7000); updateBranch(next, 33, 8000)
  const time = new Date(20000), transcriptTime = new Date(50000)
  const restore = (file: string) => { copyFileSync(file, path); utimesSync(path, time, time) }
  restore(next)
  let at = 60000
  const reader = new CursorComposerTelemetryReader({ globalStateDatabase: path, projectsRoot, workspaceStorageRoot: workspaces,
    now: () => at, channelActivityPollMs: 0, transcriptIndexTtlMs: 0 })
  const transcriptDir = join(projectsRoot, 'isolated-window', 'agent-transcripts', composerId)
  mkdirSync(transcriptDir, { recursive: true })
  const transcript = join(transcriptDir, `${composerId}.jsonl`)
  const rewriteTranscript = (channel: string, reply: string) => {
    const line = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallMcpTool', input: {
      server: 'user-SG Team', toolName: 'check_messages', arguments: { channel_id: channel } } }] } })
      + '\n' + JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
    writeFileSync(transcript, line); utimesSync(transcript, transcriptTime, transcriptTime)
  }
  rewriteTranscript('1', 'PRIVATE reply old')
  return { directory, path, old, next, team, binding, composerId, workspace, reader, transcript, updateBranch, restore, rewriteTranscript,
    nextFrame: () => { at += 1000 }, read: () => reader.readWorkspace(workspace, team.bindings),
    stamp: () => { const stat = statSync(path); return { ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs } },
    databaseHeader: (file: string) => readFileSync(file).subarray(24, 28).toString('hex'),
    close: () => { reader.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}
