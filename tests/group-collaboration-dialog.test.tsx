// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupCollaborationDialog } from '../src/renderer/src/team/GroupCollaborationDialog'
import { collaborationMapFacts, type CollaborationMapFacts } from '../src/renderer/src/team/collaboration-map-view'
import { emptyTeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { pooledTeam } from './run-fixtures'

describe('collaboration dialog lifecycle and truthful states', () => {
  let container: HTMLDivElement, root: Root, opener: HTMLButtonElement
  let nextFrame: number, frames: Map<number, FrameRequestCallback>
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    frames = new Map(); nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    opener = document.createElement('button'); opener.textContent = '协作图入口'; document.body.append(opener); opener.focus()
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); opener.remove(); vi.unstubAllGlobals() })
  function facts(status: 'running' | 'completed' = 'running'): CollaborationMapFacts {
    const team = pooledTeam(['waiting', 'working'], [{ name: '接口组', members: [
      { channelId: '1', roleTemplateKey: 'lead', roleName: '主控' }, { channelId: '2', roleTemplateKey: 'builder', roleName: '实现' }
    ], leadChannelId: '1' }], { status })
    const group = team.groups[0]!, snapshot = emptyTeamCollaborationSnapshot(team.activeRun!.id)
    group.members.forEach(member => { member.slot.groupJoinedAt = 1 })
    const now = Date.now(), m: TeamMessage = { id: 'request', runId: team.activeRun!.id, groupId: group.group.id, threadId: 'thread', clientMessageId: 'request',
      kind: 'question', content: '请核对这个真实消息。', createdAt: now, sender: { type: 'agent', slotId: group.members[0]!.slot.id }, recipient: { type: 'agent', slotId: group.members[1]!.slot.id },
      receipt: { notificationState: 'notified', notifiedAt: now, readAt: now, notificationDetail: '', updatedAt: now } }
    snapshot.messages[m.id] = m; snapshot.messageOrder = [m.id]
    return collaborationMapFacts(group, team.activeRun!, snapshot)
  }
  const render = async (view: CollaborationMapFacts, onClose = vi.fn(), onOpenMember = vi.fn(() => true)) => {
    await act(async () => root.render(<StrictMode><GroupCollaborationDialog facts={view} onClose={onClose} onOpenMember={onOpenMember} /></StrictMode>))
    return { onClose, onOpenMember }
  }
  const button = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('.collaboration-dialog button')].find(e => e.textContent?.includes(label) || e.getAttribute('aria-label') === label)!
  it('uses a real modal, moves/restores focus, isolates the background and cleans animation under StrictMode', async () => {
    const actions = await render(facts())
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
    expect(container.inert).toBe(true); expect(opener.inert).toBe(true)
    expect(document.activeElement).toBe(button('关闭协作图'))
    expect(document.querySelectorAll('.collaboration-wire')).toHaveLength(1)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(actions.onClose).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    expect(container.inert).toBe(false); expect(opener.inert).toBe(false); expect(document.activeElement).toBe(opener)
    expect(frames.size).toBe(0)
  })
  it('shows ended history and never animates an ended run', async () => {
    await render(facts('completed'))
    expect(document.querySelector('.collaboration-dialog')?.textContent).toContain('批次已结束')
    expect(button('暂停协作图动效').disabled).toBe(true)
    expect(document.querySelector('.collaboration-wire')?.getAttribute('data-kind')).toBe('history')
    expect(document.querySelector('.collaboration-wire')?.getAttribute('data-motion')).toBe('history')
  })
  it('explicit message navigation pins that real message; a later snapshot does not switch it to the latest', async () => {
    const f = facts(), original = f.messages[0]!
    const human: TeamMessage = { ...original, id: 'to-human', content: '明确定位的操作员消息', recipient: { type: 'operator' } }
    const newer: TeamMessage = { ...original, id: 'newer', content: '更新的无关消息', createdAt: original.createdAt + 1 }
    f.messages.push(human, newer)
    await act(async () => root.render(<GroupCollaborationDialog facts={f} focusMessageId={human.id} onClose={vi.fn()} onOpenMember={() => true} />))
    expect(document.querySelector('.collaboration-detail__message')?.textContent).toContain(human.content)
    const later = { ...f, messages: [...f.messages, { ...newer, id: 'latest', content: '继续到来的消息' }] }
    await act(async () => root.render(<GroupCollaborationDialog facts={later} focusMessageId={human.id} onClose={vi.fn()} onOpenMember={() => true} />))
    expect(document.querySelector('.collaboration-detail__message')?.textContent).toContain(human.content)
    expect(document.querySelector('.collaboration-detail__message')?.getAttribute('data-notification-key')).toBe('operator-message:to-human')
    expect(document.querySelector('.collaboration-detail')!.compareDocumentPosition(document.querySelector('.collaboration-canvas')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('a pinned original message missing from a later snapshot is not replaced with or read as a newer unrelated message', async () => {
    const f = facts(), original = f.messages[0]!, human = { ...original, id: 'to-human', content: '原消息正文', recipient: { type: 'operator' as const } }
    f.messages.push(human)
    await act(async () => root.render(<GroupCollaborationDialog facts={f} focusMessageId={human.id} onClose={vi.fn()} onOpenMember={() => true} />))
    const missing = { ...f, messages: [original, { ...human, id: 'another-human', content: '另一条需要显式选择的消息' }] }
    await act(async () => root.render(<GroupCollaborationDialog facts={missing} focusMessageId={human.id} onClose={vi.fn()} onOpenMember={() => true} />))
    expect(document.querySelector('.collaboration-detail__message')).toBeNull()
    expect(document.querySelector('.collaboration-detail')?.textContent).toContain('不替换成别的消息')
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain('另一条需要显式选择的消息')
  })
  it('a pinned agent-to-agent message cannot fall back to another message on the still-existing pair link', async () => {
    const f = facts(), original = f.messages[0]!
    const another = { ...original, id: 'another-pair-message', createdAt: original.createdAt + 1, content: '不要自动替换为此连线的新消息' }
    const initial = { ...f, messages: [original, another], links: [{ ...f.links[0]!, messages: [original, another], latest: another }] }
    await render(initial)
    await act(async () => button('查看协作记录').click())
    const record = [...document.querySelectorAll<HTMLButtonElement>('.collaboration-records li button')].find(node => node.textContent?.includes(original.content))!
    await act(async () => record.click())
    const missing = { ...initial, messages: [another], links: [{ ...initial.links[0]!, messages: [another], latest: another }] }
    await act(async () => root.render(<StrictMode><GroupCollaborationDialog facts={missing} onClose={vi.fn()} onOpenMember={() => true} /></StrictMode>))
    expect(document.querySelector('.collaboration-detail__message')).toBeNull()
    expect(document.querySelector('.collaboration-detail')?.textContent).toContain('原消息待核对')
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain(another.content)
  })
  it('node selection is local until the explicit open-session action and uses slot identity', async () => {
    const f = facts(), actions = await render(f)
    const node = document.querySelector<HTMLButtonElement>('.collaboration-node')!
    await act(async () => node.click())
    expect(actions.onOpenMember).not.toHaveBeenCalled()
    await act(async () => button('打开会话').click())
    expect(actions.onOpenMember).toHaveBeenCalledWith(f.members[0]!.id)
  })
  it('stale session navigation fails visibly, leaves the map open and preserves focus restore', async () => {
    const f = facts(), actions = await render(f, vi.fn(), vi.fn(() => false))
    await act(async () => document.querySelector<HTMLButtonElement>('.collaboration-node')!.click())
    await act(async () => button('打开会话').click())
    expect(actions.onClose).not.toHaveBeenCalled(); expect(document.querySelector('[role="alert"]')?.textContent).toContain('会话已变更')
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(opener)
  })
  it('resolved/ended pending filters keep a way back to the complete history', async () => {
    const f = facts()
    await render(f)
    await act(async () => button('待回应 1').click())
    expect(document.querySelector('.collaboration-records li')).not.toBeNull()
    const resolved = { ...f, links: f.links.map(link => ({ ...link, pending: [] })), pendingCount: 0 }
    await render(resolved)
    expect(button('全部记录')).toBeDefined()
    expect(document.querySelector('.collaboration-records li')).toBeNull()
    await render({ ...resolved, closed: true })
    expect(document.querySelector('.collaboration-records li')).not.toBeNull()
  })
  it('a pinned member is not replaced by hovering an unrelated channel', async () => {
    const f = facts(), message = f.messages[0]!
    f.members.push({ ...f.members[1]!, id: 'third-slot', name: '第三成员', channelId: '3', order: 3 })
    const other: TeamMessage = { ...message, id: 'other-message', clientMessageId: 'other-message', content: '无关通道的内容',
      sender: { type: 'agent', slotId: f.members[1]!.id }, recipient: { type: 'agent', slotId: 'third-slot' } }
    f.messages.push(other)
    f.links.push({ id: JSON.stringify([f.members[1]!.id, 'third-slot'].sort()), a: f.members[1]!.id, b: 'third-slot', latest: other, messages: [other], pending: [other] })
    await render(f)
    await act(async () => document.querySelector<HTMLButtonElement>('.collaboration-node')!.click())
    const wire = [...document.querySelectorAll<SVGGElement>('.collaboration-wire')].find(e => e.dataset.from === f.members[1]!.id)!
    await act(async () => wire.dispatchEvent(new FocusEvent('focus')))
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain(other.content)
    expect(wire.classList.contains('is-focused')).toBe(false)
  })
  it('Escape closes an image viewer first, not its enclosing collaboration diagram', async () => {
    const f = facts()
    f.messages[0]!.content = '![验收图](data:image/png;base64,aGVsbG8=)'
    const actions = await render(f)
    const thumbnail = document.querySelector<HTMLButtonElement>('.attachment-thumb') ?? document.querySelector<HTMLButtonElement>('.message-image__thumb')!
    expect(thumbnail).not.toBeNull()
    thumbnail.focus()
    await act(async () => thumbnail.click())
    expect(document.querySelector('.attachment-lightbox')).not.toBeNull()
    expect(document.querySelector('.attachment-lightbox')?.contains(document.activeElement)).toBe(true)
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(actions.onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.attachment-lightbox')).toBeNull()
    expect(document.querySelector('.collaboration-dialog')).not.toBeNull()
    expect(document.activeElement).toBe(thumbnail)
  })
  it('pinned operator records are not overridden by hover, and image inspection survives new messages', async () => {
    const f = facts(), request = f.messages[0]!
    const operator: TeamMessage = { ...request, id: 'operator', clientMessageId: 'operator', content: '操作端的原始记录', sender: { type: 'operator' } }
    f.messages.push(operator)
    await render(f)
    await act(async () => button('查看协作记录').click())
    const record = [...document.querySelectorAll<HTMLButtonElement>('.collaboration-records li > button')].find(el => el.textContent?.includes(operator.content))!
    await act(async () => record.click())
    await act(async () => document.querySelector<SVGGElement>('.collaboration-wire')!.dispatchEvent(new FocusEvent('focus')))
    expect(document.querySelector('.collaboration-detail')?.textContent).toContain(operator.content)
    expect(document.querySelector('.collaboration-wire')?.classList.contains('is-focused')).toBe(false)

    await act(async () => root.render(null))
    const imageFacts = facts(), image = imageFacts.messages[0]!
    image.content = '![验收图](data:image/png;base64,aGVsbG8=)'
    await render(imageFacts)
    const thumbnail = document.querySelector<HTMLButtonElement>('.attachment-thumb')!
    thumbnail.focus()
    await act(async () => thumbnail.click())
    const incoming = { ...image, id: 'incoming', clientMessageId: 'incoming', content: '后续实时消息', createdAt: image.createdAt + 1 }
    await render({ ...imageFacts, messages: [...imageFacts.messages, incoming], links: imageFacts.links.map(link => ({ ...link, latest: incoming, messages: [...link.messages, incoming] })) })
    expect(document.querySelector('.attachment-lightbox')).not.toBeNull()
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain(incoming.content)
  })
  it('Tab trapping ignores buttons inside a folded target and retains shell shortcut isolation', async () => {
    const f = facts(); f.goal = '需要确认的共同目标'
    await render(f)
    const hidden = document.createElement('button'); hidden.textContent = '折叠内部按钮'
    document.querySelector('.collaboration-dialog__goal')!.append(hidden)
    const close = button('关闭协作图'), visibleLast = button('待回应 1')
    visibleLast.focus()
    await act(async () => visibleLast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(close)
    close.focus()
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(visibleLast)
    const shellShortcut = vi.fn()
    window.addEventListener('keydown', shellShortcut)
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true })))
    expect(shellShortcut).not.toHaveBeenCalled()
    window.removeEventListener('keydown', shellShortcut)
  })
  it('new unrelated wires remain dimmed while an existing member is pinned', async () => {
    const f = facts(), message = f.messages[0]!
    f.members.push({ ...f.members[1]!, id: 'third-slot', name: '第三成员', channelId: '3', order: 3 })
    await render(f)
    await act(async () => document.querySelector<HTMLButtonElement>('.collaboration-node')!.click())
    const other: TeamMessage = { ...message, id: 'new-wire-message', clientMessageId: 'new-wire-message', content: '新来的无关通道',
      sender: { type: 'agent', slotId: f.members[1]!.id }, recipient: { type: 'agent', slotId: 'third-slot' } }
    await render({ ...f, messages: [...f.messages, other], links: [...f.links, {
      id: JSON.stringify([f.members[1]!.id, 'third-slot'].sort()), a: f.members[1]!.id, b: 'third-slot', latest: other, messages: [other], pending: [other]
    }] })
    const wire = [...document.querySelectorAll<SVGGElement>('.collaboration-wire')].find(el => el.dataset.to === 'third-slot')!
    expect(wire.classList.contains('is-dimmed')).toBe(true)
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain(other.content)
  })
  it('keyboard hover/focus is not announced as a pinned toggle', async () => {
    await render(facts())
    const wire = document.querySelector<SVGGElement>('.collaboration-wire')!
    await act(async () => wire.dispatchEvent(new FocusEvent('focus')))
    expect(wire.getAttribute('aria-pressed')).toBe('false')
    expect([...document.querySelectorAll('.collaboration-node')].every(node => node.getAttribute('aria-pressed') === 'false')).toBe(true)
    await act(async () => wire.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(wire.getAttribute('aria-pressed')).toBe('true')
    await act(async () => wire.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(wire.getAttribute('aria-pressed')).toBe('false')
    expect(wire.classList.contains('is-focused')).toBe(true)
  })
  it('text inspection holds the displayed record while newer messages arrive', async () => {
    const f = facts(), original = f.messages[0]!
    await render(f)
    const paragraph = document.querySelector('.collaboration-detail__message .message-content p')!
    await act(async () => paragraph.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })))
    const incoming = { ...original, id: 'incoming-text', clientMessageId: 'incoming-text', content: '更新后不应替换正在阅读的文本', createdAt: original.createdAt + 1 }
    await render({ ...f, messages: [...f.messages, incoming], links: f.links.map(link => ({ ...link, latest: incoming, messages: [...link.messages, incoming] })) })
    expect(document.querySelector('.collaboration-detail')?.textContent).toContain(original.content)
    expect(document.querySelector('.collaboration-detail')?.textContent).not.toContain(incoming.content)
  })
})
