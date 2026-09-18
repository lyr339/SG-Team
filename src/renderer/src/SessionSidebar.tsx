import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import { Collapsible } from './inspector/Collapsible'
import { InspectorSectionHeader, InspectorState } from './inspector/InspectorState'
import { useNow } from './inspector/use-now'
import { MenuSelect } from './lobby/MenuSelect'
import { ConfirmSheet } from './run/ConfirmSheet'
import { removeMembersConsequence, type RemoveMemberFact } from './run/pool-view'
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

/**
 * 名册多选浮动条的去处（App 级）：建组 / 加人都进 GroupComposer 抽屉（预勾这些通道，组内角色在抽屉里确认），
 * 移出在名册里确认后果后直接执行。不提供时名册没有多选（预览 / 旧调用方）。
 */
export interface RailSelectionActions {
  createGroup: (channelIds: string[]) => void
  addToGroup: (groupId: string, channelIds: string[]) => void
  removeFromGroups: (channelIds: string[]) => Promise<void>
}

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
  /** 活动 run 的 active 组：名册据此分区（阶段 3 · D4=a）。缺省 = 全部席位都在「独立」段。 */
  groups?: readonly RailGroupSource[]
  /** 多选浮动条的动作；缺省 = 名册不可多选。 */
  selectionActions?: RailSelectionActions
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
 * 「清除」的唯一判定：已离线且未入组。组内席位（含已离线成员）是组的事实——去留由交接 /
 * 移出组决定；已清除的独立席位一旦入组或回到线上，同一判定让它自愈回名册（见 partitionClearedSessions）。
 */
function isClearableSession(
  session: Parameters<typeof sessionRailGroupOf>[0] & { channelId: string },
  groupedChannelIds: ReadonlySet<string>
): boolean {
  return sessionRailGroupOf(session) === 'offline' && !groupedChannelIds.has(session.channelId)
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

/** 多选的键盘入口：行聚焦时 ⌘/Ctrl+空格 切换选中、Shift+空格 选到此行；空格本身仍是「打开」。 */
function isPickKey(event: KeyboardEvent<HTMLElement>): 'toggle' | 'range' | undefined {
  if (event.key !== ' ') return undefined
  if (event.shiftKey) return 'range'
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return undefined
}

/**
 * 会话侧栏：一份名册。协作组是一级分区（阶段 3 · D4=a），未入组席位落「独立」段；
 * 状态（执行中 / 需关注 / 待命 / 离线）降级为行内状态点、分区内的排序键与书签状态色，
 * 手动顺序决定同状态内的相对位置。分区书签吸顶、可折叠并持久化；方向键在行间漫游，
 * Enter / 空格打开；同状态段内拖拽重排，跨段不伪造组归属（改组是组头菜单与运行页的动作，不靠拖拽）。
 *
 * 多选（⌘/Ctrl+点击、Shift 范围、行首复选框、⌘/Ctrl+空格）是建组 / 改组的暂态：底部浮动条按选中的
 * 内容给动作——全是独立会话 → 建组 / 加入现有组；含组内会话 → 只能移出。普通点击、Esc、动作完成都清掉它。
 *
 * 行上的悬停操作层（置顶 / 清除）是单行快捷面：置顶＝拖到同状态段最前的一键版；清除＝微信式「不显示」，
 * 只对「独立」段的离线行开放（组内离线成员由组决定去留）。拖拽或多选进行中整层撤下——批量动作归浮动条。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession,
  groups: groupSources,
  selectionActions,
  onOpenRun
}: SessionSidebarProps): React.JSX.Element {
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => readCollapsedSections())
  const [clearedIds, setClearedIds] = useState<string[]>(() => readClearedSessions())
  const [dragOrigin, setDragOrigin] = useState<{ sessionId: string; channelId: string; groupId: string } | null>(null)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)
  // 跨分区拖放的放置目标（组头 / 「独立」头）：id + 此刻的判定，拒绝也高亮（红调），落下时才说原因。
  const [dropTarget, setDropTarget] = useState<{ id: string; allowed: boolean } | null>(null)
  // 多选：通道号集合 + Shift 范围的锚点；移出组的确认面与在途状态；浮动条里的一行提示（拒绝 / 失败）。
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [pickAnchor, setPickAnchor] = useState<string>()
  const [removal, setRemoval] = useState<RemoveMemberFact[] | null>(null)
  const [removing, setRemoving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'danger' | 'warning'; text: string } | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const cancelAnchorRef = useRef<(() => void) | undefined>(undefined)
  const now = useNow(60_000)

  // 组成员的通道号集合：清除只对「独立」段开放——组内席位（含已离线成员）是组的事实，
  // 去留走交接 / 移出组，不能被一枚名册按钮悄悄藏掉。
  const groupedChannelIds = useMemo(
    () => new Set((groupSources ?? []).flatMap((group) => group.channelIds)),
    [groupSources]
  )
  // 「清除」＝微信式不显示：只藏仍离线且未入组的行；回到线上或入了组即自愈可见（见 session-rail-hidden.ts）。
  // isClearableSession 同时决定行上出不出「清除」钮与已清除的 id 还藏不藏——两处永远一致。
  const clearedPartition = useMemo(
    () => partitionClearedSessions(snapshot.sessions, clearedIds, {
      idOf: (session) => session.id,
      isClearable: (session) => isClearableSession(session, groupedChannelIds)
    }),
    [clearedIds, groupedChannelIds, snapshot.sessions]
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
  const dragOriginSection = draggedCurrentGroupId
    ? groups.find((section) => section.id === draggedCurrentGroupId)
    : undefined
  const dragBand = dragOrigin && dragOriginSection
    ? rankBandOf(dragOriginSection, dragOrigin.sessionId)
    : undefined
  const clampToBand = (boundary: number): number => dragBand
    ? Math.max(dragBand.start, Math.min(dragBand.end, boundary))
    : boundary
  // 拖出组的服务端规则与移出一致：有效 lead 且组内还有别人 → 先换 lead。
  const dragIsBlockedLead = Boolean(dragOriginSection?.kind === 'group'
    && dragOriginSection.leadChannelId === dragOrigin?.channelId
    && dragOriginSection.sessions.length > 1)
  // 选中行进入 Tab 序列；没有选中行（或它在折叠组里）时把第一行交给 Tab。
  const selectedVisible = groups.some((group) => !collapsedGroups.has(group.id)
    && group.sessions.some((session) => session.channelId === selectedChannelId))
  const firstVisibleId = groups.find((group) => !collapsedGroups.has(group.id))?.sessions[0]?.id

  const resetDrag = (): void => {
    setDragOrigin(null)
    setInsertionIndex(null)
    setDropTarget(null)
  }

  // 席位增删或被拖行自身换段（改组 / 迁出）才中止；其他会话的实时状态变化不打断手势。
  useEffect(() => resetDrag(), [rosterSignature])
  useEffect(() => {
    if (dragOrigin && draggedCurrentGroupId !== dragOrigin.groupId) resetDrag()
  }, [dragOrigin, draggedCurrentGroupId])
  useEffect(() => () => cancelAnchorRef.current?.(), [])

  // ---------- 多选 ----------
  const multiSelect = Boolean(selectionActions)
  const sectionOfChannel = useMemo(
    () => new Map(groups.flatMap((section) => section.sessions.map((session) => [session.channelId, section] as const))),
    [groups]
  )
  // 选中的行按名册可见顺序排列（分区顺序 → 分区内排序）。
  const pickedRows = useMemo(
    () => groups.flatMap((section) => section.sessions.filter((session) => picked.has(session.channelId))),
    [groups, picked]
  )
  // 离开名册的席位从选集里掉出去；全部掉光时确认面也一并收起。
  useEffect(() => {
    setPicked((current) => {
      const next = new Set([...current].filter((channelId) => sectionOfChannel.has(channelId)))
      return next.size === current.size ? current : next
    })
  }, [sectionOfChannel])
  useEffect(() => {
    if (!picked.size) setRemoval(null)
  }, [picked])

  const clearPicks = (): void => {
    setPicked(new Set())
    setPickAnchor(undefined)
    setRemoval(null)
    setNotice(null)
  }
  const togglePick = (channelId: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(channelId)) next.delete(channelId)
      else next.add(channelId)
      return next
    })
    setPickAnchor(channelId)
    setNotice(null)
  }
  /** Shift：从锚点选到此行——只在同一分区内（跨区的范围会把独立与组内席位混在一起，动作面对不上）。 */
  const rangePick = (channelId: string): void => {
    const section = sectionOfChannel.get(channelId)
    const anchorSection = pickAnchor ? sectionOfChannel.get(pickAnchor) : undefined
    if (!section || !pickAnchor || anchorSection !== section) return togglePick(channelId)
    const ids = section.sessions.map((session) => session.channelId)
    const anchorIndex = ids.indexOf(pickAnchor)
    const targetIndex = ids.indexOf(channelId)
    const from = Math.min(anchorIndex, targetIndex)
    const to = Math.max(anchorIndex, targetIndex)
    setPicked((current) => new Set([...current, ...ids.slice(from, to + 1)]))
    setNotice(null)
  }
  const pickFromCheckbox = (channelId: string, event: ChangeEvent<HTMLInputElement>): void => {
    // 复选框的 change 由 click 驱动：原生事件带着 shiftKey，Shift+勾选 = 选范围。
    const native = event.nativeEvent
    if ('shiftKey' in native && native.shiftKey) rangePick(channelId)
    else togglePick(channelId)
  }
  const openRow = (channelId: string, event: MouseEvent<HTMLButtonElement>): void => {
    if (multiSelect && event.shiftKey) {
      event.preventDefault()
      rangePick(channelId)
      return
    }
    if (multiSelect && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      togglePick(channelId)
      return
    }
    // 普通点击退出多选：选集与提示是建组 / 改组的暂态，不该在打开会话之后还挂着。
    if (picked.size || notice) clearPicks()
    onSelectSession(channelId)
  }
  // 行卡片是 memo 的：给它一个引用稳定的回调，最新的判定从 ref 里取。
  const openRowRef = useRef(openRow)
  openRowRef.current = openRow
  const openRowStable = useRef((channelId: string, event: MouseEvent<HTMLButtonElement>) => openRowRef.current(channelId, event)).current

  // Esc 清选与提示（确认面开着时由它自己接 Esc；抽屉开着时它在捕获阶段截住了 Esc，这里收不到）。
  useEffect(() => {
    if ((!picked.size && !notice) || removal) return
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') clearPicks()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // clearPicks 只碰 setState，可以不进依赖。
  }, [picked.size, notice, removal])

  const pickedGrouped = pickedRows.filter((session) => sectionOfChannel.get(session.channelId)?.kind === 'group')
  const pickedIndependent = pickedRows.filter((session) => sectionOfChannel.get(session.channelId)?.kind === 'independent')
  // 服务端规则：有效 lead 且组内还有别人时不能移出（lead_must_transfer_first）——按钮先说出来，不让用户撞墙。
  const blockedLeads = pickedGrouped.filter((session) => {
    const section = sectionOfChannel.get(session.channelId)
    return section?.leadChannelId === session.channelId && section.sessions.length > 1
  })
  const startRemoval = (): void => {
    if (!pickedGrouped.length || blockedLeads.length) return
    setNotice(null)
    setRemoval(pickedGrouped.map((session) => ({
      channelId: session.channelId,
      groupName: sectionOfChannel.get(session.channelId)?.label ?? ''
    })))
  }
  const confirmRemoval = async (): Promise<void> => {
    if (!removal || !selectionActions) return
    setRemoving(true)
    try {
      await selectionActions.removeFromGroups(removal.map((member) => member.channelId))
      clearPicks()
    } catch (reason) {
      setRemoval(null)
      setNotice({ tone: 'danger', text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setRemoving(false)
    }
  }
  // 确认面替换了动作行：取消后 ConfirmSheet 找不到已卸载的触发钮，这里把焦点还给重新出现的「移出组」。
  // 确认成功时整条浮动条随选集清空一起消失，ref 已不指向任何节点，focus 自然不发生。
  const removeButtonRef = useRef<HTMLButtonElement>(null)
  const removalWasOpenRef = useRef(false)
  useEffect(() => {
    if (removal) {
      removalWasOpenRef.current = true
      return
    }
    if (removalWasOpenRef.current) {
      removalWasOpenRef.current = false
      removeButtonRef.current?.focus({ preventScroll: true })
    }
  }, [removal])
  const createFromPicks = (): void => {
    if (!selectionActions || !pickedIndependent.length) return
    const ids = pickedIndependent.map((session) => session.channelId)
    clearPicks()
    selectionActions.createGroup(ids)
  }
  const addPicksTo = (groupId: string): void => {
    if (!selectionActions || !groupId || !pickedIndependent.length) return
    const ids = pickedIndependent.map((session) => session.channelId)
    clearPicks()
    selectionActions.addToGroup(groupId, ids)
  }
  // 浮动条下的一行说明，只挑最要紧的一件说：失败 / 拖放被拒的原因 > lead 挡住移出 > 混合选择只影响组内。
  const barHint = notice
    ?? (blockedLeads.length
      ? {
          tone: 'warning' as const,
          text: `${blockedLeads.map((session) => `CH-${session.channelId}`).join('、')} 是所在组的 lead：先换 lead 再移出，或取消选择它`
        }
      : pickedGrouped.length && pickedIndependent.length
        ? { tone: 'muted' as const, text: `选中含组内会话时只能移出组；${pickedIndependent.length} 个独立会话不受影响` }
        : undefined)

  /**
   * 跨分区拖放（改组）的判定；undefined = 这个组头不是放置目标（没在拖 / 拖回原分区 / 名册不可多选）。
   * 独立行 → 组头：进抽屉预勾该行（组内角色要在抽屉里选，不静默塞默认值）；组内行 → 「独立」头：
   * 走与浮动条同一张移出确认面；lead（有队友）拖出与组间直拖都拒绝——落下时把原因写进浮动条提示。
   */
  const headerDropVerdictFor = (target: (typeof groups)[number]): { allowed: boolean; reason?: string } | undefined => {
    if (!multiSelect || !dragOrigin || !dragOriginSection || dragOriginSection.id === target.id) return undefined
    if (dragIsBlockedLead) {
      return { allowed: false, reason: `CH-${dragOrigin.channelId} 是「${dragOriginSection.label}」的 lead：先换 lead，再拖出组` }
    }
    if (dragOriginSection.kind === 'group' && target.kind === 'group') {
      return {
        allowed: false,
        reason: `CH-${dragOrigin.channelId} 已在「${dragOriginSection.label}」：先拖到「独立」移出，再加入「${target.label}」`
      }
    }
    return { allowed: true }
  }

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
    const target = event.target as HTMLElement | null
    if (!target?.classList.contains('session-row') || !listRef.current) return
    const pick = multiSelect ? isPickKey(event) : undefined
    if (pick) {
      // 拦在 keydown：按钮的空格激活要等 keyup，keydown 被取消就不会再点开会话。
      event.preventDefault()
      const channelId = target.dataset.channelId
      if (!channelId) return
      if (pick === 'range') rangePick(channelId)
      else togglePick(channelId)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (moveRowFocus(listRef.current, target, event.key)) event.preventDefault()
  }
  const onListKeyUp = (event: KeyboardEvent<HTMLElement>): void => {
    // 与 keydown 成对：带修饰键的空格在 keyup 也不能落成 click。
    if (multiSelect && isPickKey(event)) event.preventDefault()
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
        className={`session-list${dragOrigin ? ' is-reordering' : ''}${picked.size ? ' is-picking' : ''}`}
        aria-label="Cursor 会话"
        onKeyDown={onListKeyDown}
        onKeyUp={onListKeyUp}
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
                className={`session-group__header${dropTarget?.id === group.id ? (dropTarget.allowed ? ' is-drop-target' : ' is-drop-rejected') : ''}`}
                onClick={(event) => toggleGroup(group.id, event.currentTarget.closest<HTMLElement>('.session-group'))}
                aria-expanded={!collapsed}
                title={`${title}${collapsed ? '（已折叠，点击展开）' : ''}`}
                onDragOver={(event) => {
                  const verdict = headerDropVerdictFor(group)
                  if (!verdict) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget((current) => (
                    current?.id === group.id && current.allowed === verdict.allowed
                      ? current
                      : { id: group.id, allowed: verdict.allowed }
                  ))
                }}
                onDragLeave={() => {
                  setDropTarget((current) => (current?.id === group.id ? null : current))
                }}
                onDrop={(event) => {
                  const verdict = headerDropVerdictFor(group)
                  if (!verdict) return
                  event.preventDefault()
                  const channelId = dragOrigin?.channelId
                  const fromLabel = dragOriginSection?.label
                  resetDrag()
                  if (!channelId) return
                  if (!verdict.allowed) {
                    setNotice({ tone: 'warning', text: verdict.reason ?? '' })
                    return
                  }
                  if (group.kind === 'group') {
                    // 独立行入组：进抽屉预勾（一次确认里选角色），与浮动条「加入…」同一条路。
                    selectionActions?.addToGroup(group.id, [channelId])
                    return
                  }
                  // 组内行拖到「独立」：移出原组，走同一张确认面（文案同源）。
                  setRemoval([{ channelId, groupName: fromLabel ?? '' }])
                }}
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
                    const isPicked = picked.has(session.channelId)
                    // 只有同状态段里不止一行才有可重排的余地；独占一段的行拖起来也无处可落。
                    const band = rankBandOf(group, session.id)
                    // 悬停操作层：置顶只在能动的时候出现（同状态段 >1 行且不在段首）；清除只对「独立」段的
                    // 离线行开放（组内离线成员由组决定去留：交接 / 移出），正在查看的行先切走再清。
                    const pinnable = Boolean(band && band.end - band.start > 1 && group.sessions[band.start]?.id !== session.id)
                    const clearable = isClearableSession(session, groupedChannelIds)
                    return (
                      <div
                        key={session.id}
                        className={`session-list__slot${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}${isPicked ? ' is-picked' : ''}`}
                      >
                        {multiSelect ? (
                          // 复选框盖在头像位上：悬停 / 多选中 / 窄名册时可见，不改变行的布局；键盘走行上的 ⌘/Ctrl+空格。
                          <label className="session-row__pick" title={isPicked ? '取消选择' : '选择此会话（Shift 选到此行）'}>
                            <input
                              type="checkbox"
                              tabIndex={-1}
                              checked={isPicked}
                              aria-label={`${isPicked ? '取消选择' : '选择'} ${session.displayName} CH-${session.channelId}`}
                              onChange={(event) => pickFromCheckbox(session.channelId, event)}
                            />
                          </label>
                        ) : null}
                        <SessionRailCard
                          session={session}
                          selected={selected}
                          picked={isPicked}
                          onOpen={openRowStable}
                          liveProcess={snapshot.liveProcess?.[session.channelId]}
                          liveResponse={snapshot.liveAgentResponses?.[session.channelId]}
                          statusLine={snapshot.liveStatusLine?.[session.channelId]}
                          now={now}
                          tabIndex={selected || (!selectedVisible && session.id === firstVisibleId) ? 0 : -1}
                          // 同状态段内可重排，或（可多选时）可拖到组头 / 「独立」头改组——改组时独占一段的行也得能拖。
                          draggable={multiSelect || Boolean(band && band.end - band.start > 1)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('application/x-shiguang-session', 'reorder')
                            setNotice(null)
                            setDragOrigin({ sessionId: session.id, channelId: session.channelId, groupId: group.id })
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
      {multiSelect && (pickedRows.length || removal || notice) ? (
        // 底部浮动条：session-pane 网格的第三行，名册收缩让位，从不遮挡最后一行。
        // 移出组的确认面在条内展开（替换动作行），文案与组卡片同源（removeMembersConsequence）；
        // 拖放被拒时它只承载一行原因（无动作行）。
        <div className="session-pane__bar">
          {removal ? (
            <ConfirmSheet
              consequence={removeMembersConsequence(removal)}
              busy={removing}
              onCancel={() => setRemoval(null)}
              onConfirm={() => void confirmRemoval()}
            />
          ) : (
            <>
              {pickedRows.length ? (
                <div className="session-pane__bar-row" role="toolbar" aria-label="已选会话的操作">
                  <span className="session-pane__bar-count">已选 <b>{pickedRows.length}</b></span>
                  {pickedGrouped.length ? (
                    <button
                      ref={removeButtonRef}
                      type="button"
                      className="secondary-button session-pane__bar-button"
                      disabled={Boolean(blockedLeads.length)}
                      onClick={startRemoval}
                    >
                      移出组（{pickedGrouped.length}）
                    </button>
                  ) : (
                    <>
                      <button type="button" className="primary-button session-pane__bar-button" onClick={createFromPicks}>
                        建组（{pickedIndependent.length}）
                      </button>
                      {(groupSources?.length ?? 0) > 0 ? (
                        <MenuSelect
                          value=""
                          placeholder="加入…"
                          ariaLabel="把已选会话加入现有组"
                          menuMinWidth={168}
                          options={(groupSources ?? []).map((group) => ({ value: group.id, label: group.name }))}
                          onChange={addPicksTo}
                        />
                      ) : null}
                    </>
                  )}
                  <button type="button" className="session-pane__bar-cancel" onClick={clearPicks}>取消</button>
                </div>
              ) : null}
              {barHint ? (
                <p className={`session-pane__bar-hint is-${barHint.tone}`} role="status">
                  <span>{barHint.text}</span>
                  {!pickedRows.length ? (
                    <button type="button" className="session-pane__bar-dismiss" onClick={clearPicks}>知道了</button>
                  ) : null}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </aside>
  )
}
