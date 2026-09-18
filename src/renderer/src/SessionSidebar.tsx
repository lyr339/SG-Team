import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import { Collapsible } from './inspector/Collapsible'
import { InspectorSectionHeader, InspectorState } from './inspector/InspectorState'
import { useNow } from './inspector/use-now'
import { EraseIcon, PinTopIcon, SessionsIcon } from './UiIcons'
import {
  applySessionOrder,
  moveSessionWithinGroup,
  persistSessionOrder,
  readSessionOrder
} from './session-order'
import {
  partitionClearedSessions,
  persistClearedSessions,
  readClearedSessions
} from './session-rail-hidden'
import {
  buildSessionRailSections,
  sessionRailGroupOf,
  sessionRailSummary,
  type RailGroupSource,
  type SessionRailSection
} from './session-rail-view'
import { SESSION_GROUP_COLLAPSE_MS, collapseEasing, collapseScrollTarget } from './session-group-collapse'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
  /** 活动 run 的 active 组：名册据此分区（阶段 3 · D4=a）。缺省 = 全部席位都在「独立」段。 */
  groups?: readonly RailGroupSource[]
  /** 空态的去处：还没有任何会话时，把用户带到「运行」页去创建。 */
  onOpenRun?: () => void
}

// v1 存的是状态分区 id（执行中 / 待命 …）；阶段 3 起分区是组，键值是组 id 与 'independent'，语义不同故升版。
const COLLAPSED_SECTIONS_STORAGE_KEY = 'shiguang.sessionGroups.collapsed.v2'
const LEGACY_COLLAPSED_GROUPS_KEY = 'shiguang.sessionGroups.collapsed.v1'

function readCollapsedSections(): ReadonlySet<string> {
  try {
    localStorage.removeItem(LEGACY_COLLAPSED_GROUPS_KEY)
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function persistCollapsedSections(sections: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify([...sections]))
  } catch { /* 当前进程内的折叠状态仍然有效。 */ }
}

/**
 * 分区内同状态的连续一段（分区已按状态排序，所以同状态必然相邻）：拖拽重排只在这一段里有意义——
 * 越过它落下的行会被状态排序立刻拉回来，指示线不该在那里说谎。返回的是插入边界的闭区间。
 */
function rankBandOf<Session extends Parameters<typeof sessionRailGroupOf>[0] & { id: string }>(
  section: SessionRailSection<Session>,
  sessionId: string
): { start: number; end: number } | undefined {
  const index = section.sessions.findIndex((session) => session.id === sessionId)
  if (index < 0) return undefined
  const state = sessionRailGroupOf(section.sessions[index]!)
  let start = index
  while (start > 0 && sessionRailGroupOf(section.sessions[start - 1]!) === state) start -= 1
  let end = index + 1
  while (end < section.sessions.length && sessionRailGroupOf(section.sessions[end]!) === state) end += 1
  return { start, end }
}

function boundaryAt(list: HTMLElement, clientY: number): number {
  const slots = Array.from(list.querySelectorAll<HTMLElement>('.session-list__slot'))
  const before = slots.findIndex((slot) => {
    const rect = slot.getBoundingClientRect()
    return clientY < rect.top + rect.height / 2
  })
  return before < 0 ? slots.length : before
}

function scrollNearEdge(list: HTMLElement, clientY: number): void {
  const rect = list.getBoundingClientRect()
  const edge = Math.min(44, rect.height / 4)
  if (clientY < rect.top + edge) list.scrollTop -= 12
  else if (clientY > rect.bottom - edge) list.scrollTop += 12
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 折叠一组时的滚动锚定：动画开始前算出终态 scrollTop（见 session-group-collapse.ts），
 * 用与列表收缩同一时长、同一曲线的 rAF 缓动过去。返回取消函数；不需要挪时返回 undefined。
 */
function anchorCollapse(list: HTMLElement, section: HTMLElement): (() => void) | undefined {
  const listBody = section.querySelector<HTMLElement>('.inspector-collapsible')
  if (!listBody) return undefined
  const target = collapseScrollTarget({
    scrollTop: list.scrollTop,
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    sectionTop: section.offsetTop,
    listHeight: listBody.getBoundingClientRect().height
  })
  if (target === undefined) return undefined
  if (prefersReducedMotion()) {
    list.scrollTop = target
    return undefined
  }
  const from = list.scrollTop
  const startedAt = performance.now()
  let frame = 0
  const step = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / SESSION_GROUP_COLLAPSE_MS)
    list.scrollTop = from + (target - from) * collapseEasing(progress)
    if (progress < 1) frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

/** 方向键在可见行之间漫游；折叠组内的行处于 inert，不在候选里。 */
function moveRowFocus(list: HTMLElement, current: HTMLElement, key: string): boolean {
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-row'))
    .filter((row) => !row.closest('[inert]'))
  const index = rows.indexOf(current as HTMLButtonElement)
  if (index < 0 || !rows.length) return false
  let next: HTMLButtonElement | undefined
  if (key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)]
  else if (key === 'ArrowUp') next = rows[Math.max(0, index - 1)]
  else if (key === 'Home') next = rows[0]
  else if (key === 'End') next = rows[rows.length - 1]
  if (!next || next === current) return next !== undefined
  next.focus()
  next.scrollIntoView?.({ block: 'nearest' })
  return true
}

/**
 * 会话侧栏：一份名册。协作组是一级分区（阶段 3 · D4=a），未入组席位落「独立」段；
 * 状态（执行中 / 需关注 / 待命 / 离线）降级为行内状态点、分区内的排序键与书签状态色，
 * 手动顺序决定同状态内的相对位置。分区书签吸顶、可折叠并持久化；方向键在行间漫游，
 * Enter / 空格打开；同状态段内拖拽重排，跨段不伪造组归属（改组是组头菜单与运行页的动作，不靠拖拽）。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession,
  groups: groupSources,
  onOpenRun
}: SessionSidebarProps): React.JSX.Element {
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => readCollapsedSections())
  const [clearedIds, setClearedIds] = useState<string[]>(() => readClearedSessions())
  const [dragOrigin, setDragOrigin] = useState<{ sessionId: string; groupId: string } | null>(null)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const cancelAnchorRef = useRef<(() => void) | undefined>(undefined)
  const now = useNow(60_000)

  // 「清除」＝微信式不显示：只藏仍离线的行；回到线上立即自愈可见（见 session-rail-hidden.ts）。
  const clearedPartition = useMemo(
    () => partitionClearedSessions(snapshot.sessions, clearedIds, {
      idOf: (session) => session.id,
      isOffline: (session) => sessionRailGroupOf(session) === 'offline'
    }),
    [clearedIds, snapshot.sessions]
  )
  // 名单收敛回写：席位复活 / 离开名册后其 id 不再占名单（不改变可见性，只做持久化收敛）。
  useEffect(() => {
    if (clearedPartition.prunedIds.length === clearedIds.length) return
    setClearedIds(clearedPartition.prunedIds)
    persistClearedSessions(clearedPartition.prunedIds)
  }, [clearedPartition.prunedIds, clearedIds.length])

  const orderedSessions = useMemo(
    () => applySessionOrder(clearedPartition.visible, order, (session) => session.id),
    [order, clearedPartition.visible]
  )
  const groups = useMemo(
    () => buildSessionRailSections(orderedSessions, groupSources ?? []),
    [groupSources, orderedSessions]
  )
  const summary = useMemo(() => sessionRailSummary(groups), [groups])
  const rosterSignature = useMemo(
    () => snapshot.sessions.map((session) => session.id).sort().join('\u0000'),
    [snapshot.sessions]
  )
  const draggedCurrentGroupId = dragOrigin
    ? groups.find((section) => section.sessions.some((session) => session.id === dragOrigin.sessionId))?.id
    : undefined
  // 被拖行所在的同状态段：指示线与落点都夹在这一段里（见 rankBandOf）。
  const dragBand = dragOrigin && draggedCurrentGroupId
    ? rankBandOf(groups.find((section) => section.id === draggedCurrentGroupId)!, dragOrigin.sessionId)
    : undefined
  const clampToBand = (boundary: number): number => dragBand
    ? Math.max(dragBand.start, Math.min(dragBand.end, boundary))
    : boundary
  // 选中行进入 Tab 序列；没有选中行（或它在折叠组里）时把第一行交给 Tab。
  const selectedVisible = groups.some((group) => !collapsedGroups.has(group.id)
    && group.sessions.some((session) => session.channelId === selectedChannelId))
  const firstVisibleId = groups.find((group) => !collapsedGroups.has(group.id))?.sessions[0]?.id

  const resetDrag = (): void => {
    setDragOrigin(null)
    setInsertionIndex(null)
  }

  // 席位增删或被拖行自身换段（改组 / 迁出）才中止；其他会话的实时状态变化不打断手势。
  useEffect(() => resetDrag(), [rosterSignature])
  useEffect(() => {
    if (dragOrigin && draggedCurrentGroupId !== dragOrigin.groupId) resetDrag()
  }, [dragOrigin, draggedCurrentGroupId])
  useEffect(() => () => cancelAnchorRef.current?.(), [])

  const toggleGroup = (groupId: string, section: HTMLElement | null): void => {
    const collapsing = !collapsedGroups.has(groupId)
    cancelAnchorRef.current?.()
    cancelAnchorRef.current = undefined
    // 折叠前量、折叠中缓动：此刻 DOM 还是展开态，列表高度就是内容将减少的高度。
    if (collapsing && listRef.current && section) cancelAnchorRef.current = anchorCollapse(listRef.current, section)
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      persistCollapsedSections(next)
      return next
    })
  }

  const handleDrop = (groupId: string, boundary: number): void => {
    if (!dragOrigin || dragOrigin.groupId !== groupId) return
    const group = groups.find((candidate) => candidate.id === groupId)
    if (!group || !dragBand) return resetDrag()
    // 只重排同状态段占据的槽位：状态排序不会再把落下的行拉走，落点就是指示线所在。
    const ids = orderedSessions.map((session) => session.id)
    const bandIds = group.sessions.slice(dragBand.start, dragBand.end).map((session) => session.id)
    const next = moveSessionWithinGroup(ids, bandIds, dragOrigin.sessionId, clampToBand(boundary) - dragBand.start)
    if (next.some((id, index) => id !== ids[index])) {
      setOrder(next)
      persistSessionOrder(next)
    }
    resetDrag()
  }

  /** 置顶＝拖到同状态段最前的一键版：走同一套顺序机制与持久化，状态排序的语义不被破坏。 */
  const pinSessionToBandHead = (section: SessionRailSection<(typeof orderedSessions)[number]>, sessionId: string): void => {
    const band = rankBandOf(section, sessionId)
    if (!band) return
    const ids = orderedSessions.map((session) => session.id)
    const bandIds = section.sessions.slice(band.start, band.end).map((session) => session.id)
    const next = moveSessionWithinGroup(ids, bandIds, sessionId, 0)
    if (next.some((id, index) => id !== ids[index])) {
      setOrder(next)
      persistSessionOrder(next)
    }
  }

  const clearSession = (sessionId: string): void => {
    const next = [...new Set([...clearedPartition.prunedIds, sessionId])]
    setClearedIds(next)
    persistClearedSessions(next)
  }

  const restoreClearedSessions = (): void => {
    setClearedIds([])
    persistClearedSessions([])
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const target = event.target as HTMLElement | null
    if (!target?.classList.contains('session-row') || !listRef.current) return
    if (moveRowFocus(listRef.current, target, event.key)) event.preventDefault()
  }

  const lastGroup = groups.at(-1)
  const tailDropEnabled = Boolean(lastGroup
    && dragOrigin?.groupId === lastGroup.id
    && !collapsedGroups.has(lastGroup.id))
  const connecting = snapshot.connection.state === 'connecting' || snapshot.connection.state === 'reconnecting'

  return (
    <aside className="context-sidebar session-pane" aria-label="Cursor 会话">
      <InspectorSectionHeader
        title="会话"
        hint={summary || (connecting ? '正在连接通道…' : '还没有会话')}
        aside={snapshot.sessions.length ? <b className="session-pane__count">{snapshot.sessions.length}</b> : null}
      />
      <nav
        ref={listRef}
        className={`session-list${dragOrigin ? ' is-reordering' : ''}`}
        aria-label="Cursor 会话"
        onKeyDown={onListKeyDown}
        onDragOver={(event) => {
          if (event.target !== event.currentTarget || !tailDropEnabled || !lastGroup) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          scrollNearEdge(event.currentTarget, event.clientY)
          setInsertionIndex(clampToBand(lastGroup.sessions.length))
        }}
        onDrop={(event) => {
          if (event.target !== event.currentTarget || !tailDropEnabled || !lastGroup) return
          event.preventDefault()
          handleDrop(lastGroup.id, lastGroup.sessions.length)
        }}
      >
        {groups.length ? groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id)
          const markerActive = dragOrigin?.groupId === group.id
          const isGroup = group.kind === 'group'
          const title = isGroup
            ? `协作组「${group.label}」· ${group.sessions.length} 名成员${group.attention ? '，有成员已确认离线' : ''}`
            : '未入组的独立会话'
          return (
            <section
              key={group.id}
              className={`session-group is-${group.kind} is-${group.state}${collapsed ? ' is-collapsed' : ''}`}
              data-section={group.id}
            >
              <button
                type="button"
                className="session-group__header"
                onClick={(event) => toggleGroup(group.id, event.currentTarget.closest<HTMLElement>('.session-group'))}
                aria-expanded={!collapsed}
                title={`${title}${collapsed ? '（已折叠，点击展开）' : ''}`}
              >
                <span className="session-group__tab">
                  <span>{group.label}</span>
                  <b>{group.sessions.length}</b>
                </span>
                {group.attention ? (
                  // 折叠时仍然可见：组里有人已确认离线，用户需要决定交接还是移出——徽标带文字，不只靠颜色。
                  <em className="session-group__attention" aria-label="有成员已确认离线：交接给其他席位，或移出组">成员离线</em>
                ) : null}
                <i className="session-group__rule" aria-hidden="true" />
                <svg className="session-group__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>
              </button>
              <Collapsible open={!collapsed} keepMounted>
                <div
                  className="session-group__list"
                  aria-label={isGroup ? `${group.label}组会话` : '独立会话'}
                  onDragOver={(event) => {
                    if (!markerActive) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const scroller = event.currentTarget.closest<HTMLElement>('.session-list') ?? event.currentTarget
                    scrollNearEdge(scroller, event.clientY)
                    setInsertionIndex(clampToBand(boundaryAt(event.currentTarget, event.clientY)))
                  }}
                  onDragLeave={(event) => {
                    if (!markerActive) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    if (
                      event.clientX < rect.left || event.clientX > rect.right
                      || event.clientY < rect.top || event.clientY > rect.bottom
                    ) setInsertionIndex(null)
                  }}
                  onDrop={(event) => {
                    if (!markerActive) return
                    event.preventDefault()
                    handleDrop(group.id, boundaryAt(event.currentTarget, event.clientY))
                  }}
                >
                  {group.sessions.map((session, index) => {
                    const dragging = markerActive && dragOrigin?.sessionId === session.id
                    const dropBefore = markerActive && insertionIndex === index
                    const dropAfter = markerActive && insertionIndex === group.sessions.length && index === group.sessions.length - 1
                    const selected = session.channelId === selectedChannelId
                    // 只有同状态段里不止一行才有可重排的余地；独占一段的行拖起来也无处可落。
                    const band = rankBandOf(group, session.id)
                    // 悬停操作层：置顶只在能动的时候出现（同状态段 >1 行且不在段首）；
                    // 清除只对离线行开放，正在查看的行先切走再清（避免选中态凭空消失）。
                    const pinnable = Boolean(band && band.end - band.start > 1 && group.sessions[band.start]?.id !== session.id)
                    const clearable = sessionRailGroupOf(session) === 'offline'
                    return (
                      <div
                        key={session.id}
                        className={`session-list__slot${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}`}
                      >
                        <SessionRailCard
                          session={session}
                          selected={selected}
                          onOpen={onSelectSession}
                          liveProcess={snapshot.liveProcess?.[session.channelId]}
                          liveResponse={snapshot.liveAgentResponses?.[session.channelId]}
                          statusLine={snapshot.liveStatusLine?.[session.channelId]}
                          now={now}
                          tabIndex={selected || (!selectedVisible && session.id === firstVisibleId) ? 0 : -1}
                          draggable={Boolean(band && band.end - band.start > 1)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('application/x-shiguang-session', 'reorder')
                            setDragOrigin({ sessionId: session.id, groupId: group.id })
                          }}
                          onDragEnd={resetDrag}
                        />
                        {pinnable || clearable ? (
                          // 行按钮的兄弟节点（不嵌套 button）：悬停 / 行获得焦点时浮现在右上角。
                          <span className="session-row-actions" role="group" aria-label={`${session.displayName} 的快捷操作`}>
                            {pinnable ? (
                              <button
                                type="button"
                                className="session-row-actions__button"
                                title="置顶：移到同状态段最前"
                                aria-label={`置顶 ${session.displayName}`}
                                onClick={() => pinSessionToBandHead(group, session.id)}
                              >
                                <PinTopIcon />
                              </button>
                            ) : null}
                            {clearable ? (
                              <button
                                type="button"
                                className="session-row-actions__button"
                                disabled={selected}
                                title={selected
                                  ? '正在查看这条会话：先切换到其他会话再清除'
                                  : '从名册清除这条离线会话（数据保留；席位重新上线会自动回来）'}
                                aria-label={`清除 ${session.displayName}`}
                                onClick={() => clearSession(session.id)}
                              >
                                <EraseIcon />
                              </button>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </Collapsible>
            </section>
          )
        }) : (
          <InspectorState
            tone={connecting ? 'loading' : 'neutral'}
            icon={<SessionsIcon />}
            title={connecting ? '正在连接通道…' : '还没有会话'}
            hint={connecting
              ? '拾光正在等待 SG Team 通道就绪'
              : '在「运行」页创建批次后，每个会话会作为一行出现在这里；运行中可随时把几个会话组成协作组'}
            action={!connecting && onOpenRun
              ? <button type="button" className="inspector-link" onClick={onOpenRun}>前往运行页</button>
              : undefined}
          />
        )}
        {clearedPartition.hidden.length ? (
          // 清除的安全阀：有隐藏行时名册末尾常驻一行入口，一键全部恢复——不需要进设置页找。
          <button type="button" className="session-list__restore" onClick={restoreClearedSessions}>
            已清除 {clearedPartition.hidden.length} 条离线会话 · 恢复显示
          </button>
        ) : null}
      </nav>
    </aside>
  )
}
