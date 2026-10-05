import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCursorQuestionIpc } from '../src/main/register-cursor-question-ipc'
import { registerSessionHandoffIpc } from '../src/main/register-session-handoff-ipc'
import { registerAgentLaunchIpc } from '../src/main/register-agent-launch-ipc'
import { PageOperationNotifications } from '../src/application/notifications/page-operation-notifications'
import { RevealPathPolicy } from '../src/application/reveal-path-policy'
import { notificationSourceHarness } from './notification-source-fixtures'
import { IPC } from '../src/shared/desktop-api'

const { handlers, saveDialog } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(), saveDialog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: (event: unknown, value?: unknown) => unknown) => handlers.set(name, callback), removeHandler: (name: string) => handlers.delete(name) },
  dialog: { showSaveDialog: saveDialog }, clipboard: {}, nativeImage: {}, shell: {} }))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

describe('original question/image/CDP action outcomes are authoritative', () => {
  let folder: string
  beforeEach(() => { handlers.clear(); saveDialog.mockReset(); folder = mkdtempSync(join(tmpdir(), 'sg-page-action-test-')) })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))
  const invoke = (channel: string, value?: unknown) => handlers.get(channel)!({}, value)
  it('question failure is a separate attempt, does not expire/cancel the underlying question, and preserves typed result and original input', async () => {
    const h = notificationSourceHarness(), operations = new PageOperationNotifications(h.owner)
    const answer = vi.fn(async () => ({ ok: false as const, code: 'question_not_pending' as const, message: 'original diagnostic not observed yet' }))
    const dispose = registerCursorQuestionIpc({ answer, skip: vi.fn() } as never, () => undefined, { operations, sourceTarget: () => ({ scope: { channelId: '1', sessionId: 'real-session', generation: '1', composerId: 'real-composer' },
      target: { kind: 'session', scope: { channelId: '1', sessionId: 'real-session', generation: '1', composerId: 'real-composer' }, toolCallId: 'tool-1', blockId: 'block-1' } }) })
    try {
      await operations.flush(); const result = await invoke(IPC.answerCursorQuestion, { channelId: '1', toolCallId: 'tool-1', selections: { q: ['opt'] }, freeformTexts: { q2: 'private freeform answer' }, note: 'private user note' }) as { ok: boolean; code: string; message: string }
      await operations.flush(); expect(result).toMatchObject({ ok: false, code: 'question_not_pending', message: 'original diagnostic not observed yet' }); expect(answer).toHaveBeenCalledOnce()
      expect(answer).toHaveBeenCalledWith({ channelId: '1', toolCallId: 'tool-1', selections: { q: ['opt'] }, freeformTexts: { q2: 'private freeform answer' }, note: 'private user note' })
      const text = JSON.stringify(h.ledger.page()); expect(text).not.toContain('private freeform'); expect(text).not.toContain('private user note')
      expect(h.ledger.page().records[0]).toMatchObject({ eventType: 'page.operation.result', subjectState: 'failed', attention: 'notice', target: { toolCallId: 'tool-1' } })
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { dispose(); operations.dispose(); await h.owner.close() }
  })
  it('unconfirmed question submission stays unconfirmed, successful skip is quiet and no observer repeats it', async () => {
    const h = notificationSourceHarness(), operations = new PageOperationNotifications(h.owner)
    const answer = vi.fn(async () => ({ ok: false as const, code: 'unconfirmed' as const, message: 'original unconfirmed' })), skip = vi.fn(async () => ({ ok: true as const, status: 'cancelled' as const }))
    const dispose = registerCursorQuestionIpc({ answer, skip } as never, () => undefined, { operations })
    try {
      await operations.flush(); await invoke(IPC.answerCursorQuestion, { channelId: '1', toolCallId: 'tool-1', selections: {} }); await operations.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'unconfirmed', state: 'active' })
      expect(await invoke(IPC.skipCursorQuestion, { channelId: '1', toolCallId: 'tool-1' })).toEqual({ ok: true, status: 'cancelled' })
      await operations.flush(); expect(skip).toHaveBeenCalledOnce(); expect(answer).toHaveBeenCalledOnce(); expect(h.ledger.page().summary.unread).toBe(1)
      expect(h.ledger.page().records.find(record => record.key.includes('question-skip'))?.attention).toBe('activity')
    } finally { dispose(); operations.dispose(); await h.owner.close() }
  })
  it('cancelled image save is not a file failure, and actual write completion does not copy path/bytes into history', async () => {
    const h = notificationSourceHarness(), operations = new PageOperationNotifications(h.owner)
    const dispose = registerSessionHandoffIpc({} as never, {} as never, new RevealPathPolicy([]), () => undefined, { operations })
    try {
      await operations.flush(); saveDialog.mockResolvedValueOnce({ canceled: true })
      const input = { dataUrl: 'data:image/png;base64,cG5n', name: 'own-image.png' }
      expect(await invoke(IPC.saveImageAs, input)).toBe(false); await operations.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'cancelled', attention: 'activity', state: 'expired' })
      const path = join(folder, 'private-saved-image.png'); saveDialog.mockResolvedValueOnce({ canceled: false, filePath: path })
      expect(await invoke(IPC.saveImageAs, input)).toBe(true); await operations.flush(); expect(readFileSync(path).toString()).toBe('png')
      expect(JSON.stringify(h.ledger.page())).not.toContain(path); expect(JSON.stringify(h.ledger.page())).not.toContain('cG5n')
      expect(saveDialog).toHaveBeenCalledTimes(2); expect(h.ledger.page().summary.unread).toBe(0)
    } finally { dispose(); operations.dispose(); await h.owner.close() }
  })
  it('CDP enabling remains one original call, not a model probe/launch, and successful output stays quiet', async () => {
    const h = notificationSourceHarness(), operations = new PageOperationNotifications(h.owner), enable = vi.fn(async () => ({ ok: true, message: 'port ready', suggestAutoHeal: true }))
    const launcher = { launch: vi.fn(), getPlan: vi.fn() }
    const dispose = registerAgentLaunchIpc(launcher as never, enable, () => undefined, operations)
    try {
      await operations.flush(); const result = await invoke(IPC.agentLaunchEnableCdp) as { ok: boolean; suggestAutoHeal: boolean }
      await operations.flush(); expect(result).toMatchObject({ ok: true, suggestAutoHeal: true }); expect(enable).toHaveBeenCalledOnce(); expect(launcher.launch).not.toHaveBeenCalled()
      expect(h.ledger.page().records[0]).toMatchObject({ attention: 'activity', origin: { module: 'run' } })
      expect(h.ledger.page().records[0]?.detail).toContain('不代表模型已请求')
    } finally { dispose(); operations.dispose(); await h.owner.close() }
  })
})
