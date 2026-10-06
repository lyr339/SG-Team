import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageContent } from '../MessageContent'
import { collaborationActorLabel, collaborationPairKey, visibleCollaborationLinks, type CollaborationMapFacts } from './collaboration-map-view'
import { CollaborationCanvas } from './CollaborationCanvas'
import { CollaborationMapIcon } from './GroupCollaborationEntry'
import type { TeamMessage } from '../../../domain/team-collaboration'
import './collaboration-map.css'
import { useOperatorMessageNotificationRead } from '../notifications/use-operator-message-notification-read'

interface Props {
  facts: CollaborationMapFacts
  workspaceName?: string
  onClose: () => void
  /** Navigation validates the CURRENT slot binding at App level; this dialog sends no commands. */
  onOpenMember: (slotId: string) => boolean
  /** Explicit source navigation only. Live snapshots never change a pinned selection. */
  focusMessageId?: string
}

export function GroupCollaborationDialog({ facts, workspaceName, onClose, onOpenMember, focusMessageId }: Props): React.JSX.Element {
  const titleId = useId(), dialog = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null), restoreFocus = useRef(true)
  const [paused, setPaused] = useState(false), [reduced, setReduced] = useState(false)
  const [memberId, setMemberId] = useState<string>(), [linkId, setLinkId] = useState<string>(), [messageId, setMessageId] = useState<string | undefined>(focusMessageId)
  const messageRef = useRef<HTMLDivElement>(null)
  const [hoverLink, setHoverLink] = useState<string>(), [recordsOpen, setRecordsOpen] = useState(false), [pendingOnly, setPendingOnly] = useState(false)
  const [recordLimit, setRecordLimit] = useState(30), [clock, tick] = useState(0), [error, setError] = useState('')
  useEffect(() => {
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined
    const read = (): void => setReduced(query?.matches ?? false)
    read(); query?.addEventListener('change', read)
    return () => query?.removeEventListener('change', read)
  }, [])
  useEffect(() => {
    const root = dialog.current
    if (!root || typeof MutationObserver !== 'function') return
    let child: HTMLElement | null = null
    let returnTo: HTMLElement | SVGElement | null = null
    const changed = (): void => {
      const next = root.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"], [role="menu"]')
      if (next === child) return
      if (next) {
        const active = document.activeElement
        if (!child && active && root.contains(active) && (active instanceof HTMLElement || active instanceof SVGElement)) returnTo = active
        child = next
        const buttons = next.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        ;(next.matches('[role="menu"]') ? buttons[0] : buttons[buttons.length - 1])?.focus({ preventScroll: true })
      } else {
        child = null
        if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
        returnTo = null
      }
    }
    const observer = new MutationObserver(changed)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  // Pinned member/message selection outranks transient hover, for both figure and detail.
  const focusLinkId = memberId ? undefined : linkId ?? (messageId ? undefined : hoverLink)
  const display = useMemo(() => visibleCollaborationLinks(facts, Date.now(), focusLinkId, memberId, messageId), [facts, clock, focusLinkId, memberId, messageId])
  useEffect(() => {
    const at = display.nextPulseUntil
    const timer = at ? setTimeout(() => tick(n => n + 1), Math.max(16, at - Date.now() + 15)) : undefined
    const visible = (): void => { if (!document.hidden) tick(n => n + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [display.nextPulseUntil])
  useEffect(() => {
    if (memberId && !facts.members.some(member => member.id === memberId)) setMemberId(undefined)
    if (linkId && !facts.links.some(link => link.id === linkId)) { setLinkId(undefined); setHoverLink(undefined) }
    if (hoverLink && !facts.links.some(link => link.id === hoverLink)) setHoverLink(undefined)
  }, [facts, memberId, linkId, hoverLink])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const saved = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop.current)
      .map(element => ({ element, inert: Boolean(element.inert) }))
    saved.forEach(({ element }) => { element.inert = true })
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      saved.forEach(({ element, inert }) => { element.inert = inert })
      if (restoreFocus.current && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (dialog.current?.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [onClose])
  const trapTab = (event: React.KeyboardEvent): void => {
    const root = dialog.current
    const nested = root?.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"], [role="menu"]')
    // Existing image/menu viewers consume Escape at document level; let only
    // that key reach them, while shell/module shortcuts stay isolated.
    if (nested && event.key === 'Escape') return
    // Keep shell/module shortcuts behind this modal from changing the user's context.
    event.stopPropagation()
    if (event.key !== 'Tab' || !root) return
    const scope = nested ?? root
    const stops = [...scope.querySelectorAll<HTMLElement | SVGElement>('button:not(:disabled), a[href], [tabindex="0"], summary')]
      .filter(element => !element.closest('[hidden], [inert]') && !element.closest('details:not([open]) > :not(summary)'))
    const first = stops[0], last = stops.at(-1), active = document.activeElement
    if (!first || !last) return
    if (event.shiftKey && (active === first || active === scope) || !event.shiftKey && active === last || !scope.contains(active)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    }
  }
  const clear = useCallback(() => { setMemberId(undefined); setLinkId(undefined); setMessageId(undefined); setHoverLink(undefined); setError('') }, [])
  const selectMember = useCallback((id: string) => { setMemberId(current => current === id ? undefined : id); setLinkId(undefined); setMessageId(undefined); setHoverLink(undefined); setError('') }, [])
  const interaction = useCallback((kind: 'enter' | 'leave' | 'select', id: string) => {
    if (kind === 'enter') setHoverLink(id)
    else if (kind === 'leave') setHoverLink(current => current === id ? undefined : current)
    else { setLinkId(current => current === id ? undefined : id); setMemberId(undefined); setMessageId(undefined); setError('') }
  }, [])
  const selectedMember = facts.members.find(member => member.id === memberId)
  const selectedLink = display.links.find(link => link.id === focusLinkId)
  const selectedMessage = messageId ? facts.messages.find(message => message.id === messageId) : selectedLink?.message
  const latestMessage = messageId ? selectedMessage : selectedMessage ?? (selectedMember ? [...facts.messages].reverse().find(message =>
    message.sender.type === 'agent' && message.sender.slotId === selectedMember.id || message.recipient.type === 'agent' && message.recipient.slotId === selectedMember.id) : facts.messages.at(-1))
  const notificationKey = latestMessage?.recipient.type === 'operator' && latestMessage.sender.type === 'agent' ? `operator-message:${latestMessage.id}` : undefined
  const messageDigest = useOperatorMessageNotificationRead(messageRef, latestMessage, facts, latestMessage ? facts.threadSubjects[latestMessage.threadId] : undefined)
  const openMember = (id: string): void => {
    restoreFocus.current = false
    if (!onOpenMember(id)) { restoreFocus.current = true; setError('该成员的会话已变更，暂时无法打开；协作记录仍可查看。') }
  }
  const selectMessage = (message: TeamMessage): void => {
    setMessageId(message.id); setMemberId(undefined); setHoverLink(undefined)
    const pair = message.sender.type === 'agent' && message.recipient.type === 'agent' ? collaborationPairKey(message.sender.slotId, message.recipient.slotId) : undefined
    setLinkId(facts.links.some(link => link.id === pair) ? pair : undefined)
  }
  const pendingIds = useMemo(() => new Set(facts.links.flatMap(link => link.pending.map(message => message.id))), [facts.links])
  const effectivePendingOnly = pendingOnly && !facts.closed
  const records = facts.messages.filter(message => (!effectivePendingOnly || pendingIds.has(message.id)) && (!memberId
    || message.sender.type === 'agent' && message.sender.slotId === memberId || message.recipient.type === 'agent' && message.recipient.slotId === memberId))
  const flowAvailable = display.links.some(link => link.kind === 'active' || link.kind === 'reply')
  const lead = facts.members.find(member => member.id === facts.leadId)
  const holdMessageForInspection = (): void => {
    if (!latestMessage) return
    if (memberId) { setMessageId(latestMessage.id); setHoverLink(undefined) }
    else selectMessage(latestMessage)
  }
  const holdImageMessage = (event: React.SyntheticEvent): void => {
    if (event.target instanceof Element && event.target.closest('.attachment-thumb')) holdMessageForInspection()
  }
  // Source navigation prioritizes the message; normal group browsing remains graph-first.
  const detailPanel = (
    <section className="collaboration-detail" aria-label="当前协作详情">
      {selectedMember ? <header><strong>{selectedMember.name} · CH-{selectedMember.channelId ?? '?'}</strong><span>{selectedMember.stateLabel}</span></header>
        : latestMessage ? <header><strong>{collaborationActorLabel(facts, latestMessage, true)} <i aria-hidden="true">→</i> {collaborationActorLabel(facts, latestMessage, false)}</strong>
          <span>{selectedLink?.label ?? (facts.closed ? '历史记录' : '最近记录')}</span></header> : <header><strong>{messageId ? '原消息待核对' : facts.scoped ? '尚无组内消息' : '消息记录暂未同步'}</strong></header>}
      {latestMessage ? <div ref={messageRef} className="collaboration-detail__message" data-notification-key={notificationKey}
        data-notification-operator-message={notificationKey ? latestMessage.id : undefined} data-notification-operator-digest={messageDigest}
        data-notification-operator-workspace={facts.workspaceId} data-notification-operator-run={facts.runId} data-notification-operator-group={facts.groupId}
        data-notification-operator-kind={latestMessage.kind}
        onPointerDownCapture={event => { if (event.button === 0) holdMessageForInspection() }}
        onClickCapture={holdImageMessage} onContextMenuCapture={holdMessageForInspection}><MessageContent text={latestMessage.content} /><time dateTime={new Date(latestMessage.createdAt).toISOString()} title={new Date(latestMessage.createdAt).toLocaleString()}>{new Date(latestMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
        : <p role={messageId ? 'status' : undefined}>{messageId ? '这条已定位的原消息当前没有在本次组记录中确认。不替换成别的消息，也不推断已回复、撤回或删除；可在全部记录中明确选择其他事项。'
          : facts.scoped ? '成员加入并不等于已经通信；有真实组内消息后才会显示连线。' : '等待当前组的记录同步，不使用其他组或批次的数据。关闭后重新打开可重试同步。'}</p>}
      {error ? <p className="collaboration-dialog__error" role="alert">{error}</p> : null}
    </section>
  )
  return createPortal(
    <div ref={backdrop} className="collaboration-dialog__backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialog} className="collaboration-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapTab}>
        <header className="collaboration-dialog__header">
          <span className="collaboration-dialog__mark" aria-hidden="true"><CollaborationMapIcon /></span>
          <div className="collaboration-dialog__heading"><small>协作图{workspaceName ? ` · ${workspaceName}` : ''}</small><h2 id={titleId} title={facts.name}>{facts.name}</h2></div>
          <button ref={closeButton} type="button" className="collaboration-icon-button" aria-label="关闭协作图" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
        </header>
        <div className="collaboration-dialog__body">
          <div className="collaboration-dialog__meta"><span>{facts.members.length} 位成员</span><span>{lead ? `${facts.actingLead ? '临时主控' : '主控'} · CH-${lead.channelId ?? '未绑定'}` : facts.dissolved ? '成员已离组' : facts.missingLead ? '主控身份待确认' : '未指定主控 · 平等协作'}</span>
            {facts.closed ? <span className="is-archived">{facts.dissolved ? '已解散 · 只读' : '批次已结束 · 只读'}</span> : !facts.scoped ? <span>记录暂未同步</span> : null}</div>
          {facts.goal ? <details className="collaboration-dialog__goal"><summary title="展开完整共同目标"><span>共同目标</span><span>{facts.goal.slice(0, 140)}{facts.goal.length > 140 ? '…' : ''}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg></summary><p>{facts.goal}</p></details> : null}
          {focusMessageId ? detailPanel : null}
          <div className="collaboration-dialog__tools"><div className="collaboration-dialog__legend"><span className="is-flow">最近通信</span><span className="is-wait">待送达 / 回应</span><span className="is-history">历史方向</span></div>
            <div><button type="button" className="collaboration-text-button" onClick={clear}>{memberId || linkId ? '取消聚焦' : messageId ? '查看最新' : display.hiddenCount ? '近期关系' : '全部关系'}</button>
              {selectedMember ? <button type="button" className="collaboration-text-button collaboration-open-session" disabled={!selectedMember.channelId}
                title={!selectedMember.channelId ? '该成员尚未绑定会话' : `打开 ${selectedMember.name} · CH-${selectedMember.channelId}`}
                onClick={() => openMember(selectedMember.id)}>打开会话 ↗</button> : null}
              <button type="button" className="collaboration-icon-button" disabled={reduced || !flowAvailable} aria-pressed={paused}
                aria-label={paused ? '继续协作图动效' : '暂停协作图动效'} title={reduced ? '遵循系统减少动态效果设置' : !flowAvailable ? '当前没有新的消息流动' : '仅暂停图形动效，不暂停 Agent'} onClick={() => setPaused(value => !value)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d={paused ? 'M5 3 12 8 5 13Z' : 'M5 3V13M11 3V13'} /></svg></button>
            </div>
          </div>
          <CollaborationCanvas facts={facts} links={display.links} focusedLinkId={focusLinkId} pinnedLinkId={linkId} selectedMemberId={memberId} paused={paused} reduced={reduced}
            onMemberSelect={selectMember} onLinkInteraction={interaction} />
          {display.hiddenCount ? <p className="collaboration-dialog__dense">展示最近 {display.links.length} 个通道，另有 {display.hiddenCount} 个；在记录中选择消息可聚焦对应通道。</p> : null}
          {!focusMessageId ? detailPanel : null}
          <div className="collaboration-records__head"><button type="button" className="collaboration-text-button" aria-expanded={recordsOpen} onClick={() => setRecordsOpen(value => !value)}>{recordsOpen ? '收起记录' : '查看协作记录'} · {records.length}</button>
            {!facts.closed && (facts.pendingCount || pendingOnly) ? <button type="button" className="collaboration-text-button is-pending" aria-pressed={pendingOnly} onClick={() => { setPendingOnly(value => !value); setRecordsOpen(true) }}>{pendingOnly ? '全部记录' : `待回应 ${facts.pendingCount}`}</button> : null}</div>
          {recordsOpen ? <div className="collaboration-records"><ol>{records.slice(-recordLimit).reverse().map(message => <li key={message.id}><button type="button" className={message.id === messageId ? 'is-selected' : ''} aria-pressed={message.id === messageId} onClick={() => selectMessage(message)}>
            <strong>{collaborationActorLabel(facts, message, true)} <i aria-hidden="true">→</i> {collaborationActorLabel(facts, message, false)}</strong>
            <span>{message.content.slice(0, 180)}</span><small>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{pendingIds.has(message.id) ? ' · 待回应' : ''}</small>
          </button></li>)}</ol>{records.length > recordLimit ? <button type="button" className="collaboration-text-button" onClick={() => setRecordLimit(n => n + 30)}>查看更多记录（剩余 {records.length - recordLimit}）</button> : null}
            {!records.length ? <p>当前筛选下没有记录。</p> : null}</div> : null}
        </div>
        <footer className="collaboration-dialog__footer"><span>{facts.operatorCount ? `${facts.operatorCount} 条操作端 / 系统消息不绘制成员连线` : '连线来自当前组的真实消息'}{facts.formerMemberCount ? ` · ${facts.formerMemberCount} 条原组员记录保留` : ''}</span>
          <span>{reduced ? '减少动态效果已生效' : '点击成员聚焦 · Esc 关闭'}</span></footer>
      </section>
    </div>, document.body)
}
