import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentAvatar } from '../AgentAvatar'
import type { CollaborationMapFacts, CollaborationMapDisplayLink } from './collaboration-map-view'
import { teamMessageNeedsAgentResponse } from '../../../domain/team-collaboration'
import { CollaborationWireLayer } from './collaboration-wire-layer'
import { useCollaborationLayout } from './use-collaboration-layout'
import { graphMemberOrder } from './collaboration-layout'

interface Props {
  facts: CollaborationMapFacts
  links: readonly CollaborationMapDisplayLink[]
  focusedLinkId?: string
  pinnedLinkId?: string
  selectedMemberId?: string
  paused: boolean
  reduced: boolean
  onMemberSelect: (id: string) => void
  onLinkInteraction: (kind: 'enter' | 'leave' | 'select', id: string) => void
}

/** Layout work runs off-thread; the animation island never updates React state at frame rate. */
export const CollaborationCanvas = memo(function CollaborationCanvas({
  facts, links, focusedLinkId, pinnedLinkId, selectedMemberId, paused, reduced, onMemberSelect, onLinkInteraction
}: Props): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null)
  const engine = useRef<CollaborationWireLayer | undefined>(undefined)
  const interaction = useRef(onLinkInteraction)
  useLayoutEffect(() => { interaction.current = onLinkInteraction }, [onLinkInteraction])
  const [width, setWidth] = useState(960)
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const read = (): void => { if (element.clientWidth > 0) setWidth(element.clientWidth) }
    read()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(read); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const affinityKey = facts.links.map(link => link.id).join('\u0000')
  const memberKey = facts.members.map(member => member.id).join('\u0000')
  const ids = useMemo(() => graphMemberOrder(facts.members.map(member => member.id), facts.leadId,
    facts.links.map(link => ({ id: link.id, from: link.a, to: link.b }))), [memberKey, facts.leadId, affinityKey])
  const edgeKey = links.map(link => link.id).join('\u0000')
  const topology = useMemo(() => links.map(link => ({ id: link.id, from: link.from < link.to ? link.from : link.to, to: link.from < link.to ? link.to : link.from })), [edgeKey])
  const routing = useCollaborationLayout(facts.scopeKey, ids, facts.leadId, width, topology)
  const layout = routing.layout
  const members = new Map(facts.members.map(member => [member.id, member]))
  const latest = useRef({ links, paused, reduced, visible: true })
  useLayoutEffect(() => { latest.current = { ...latest.current, links, paused, reduced } }, [links, paused, reduced])
  const wake = useRef<(() => void) | undefined>(undefined)
  const motionTime = useRef(0)
  useLayoutEffect(() => {
    const root = svg.current
    if (!root) return
    const layer = new CollaborationWireLayer(root, (kind, id) => interaction.current(kind, id))
    engine.current = layer
    let frame = 0, last = performance.now(), disposed = false
    const schedule = (): void => { if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(draw) }
    const draw = (at: number): void => {
      frame = 0
      if (disposed) return
      const data = latest.current, now = Date.now()
      const flowing = data.visible && !document.hidden && !data.paused && !data.reduced
        && data.links.some(link => (link.kind === 'active' || link.kind === 'reply') && (link.pulseUntil ?? 0) > now)
      if (at - last >= 1000 / 30 || !flowing) {
        if (flowing) motionTime.current += Math.min(.08, (at - last) / 1000)
        last = at
        layer.draw(motionTime.current, data.reduced, data.paused, now)
      }
      if (flowing) schedule()
    }
    const visibility = (): void => { last = performance.now(); if (!document.hidden) schedule() }
    document.addEventListener('visibilitychange', visibility)
    const observer = typeof IntersectionObserver === 'function' && viewport.current ? new IntersectionObserver(entries => {
      latest.current.visible = entries[0]?.isIntersecting ?? true
      if (latest.current.visible) schedule()
    }, { rootMargin: '80px' }) : undefined
    if (observer && viewport.current) observer.observe(viewport.current)
    wake.current = schedule; schedule()
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer?.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      layer.destroy(); engine.current = undefined; wake.current = undefined
    }
  }, [])
  useLayoutEffect(() => {
    const names = new Map(facts.members.map(member => [member.id, `${member.name} · CH-${member.channelId ?? '?'}`]))
    engine.current?.setLinks(links.map(link => ({ ...link, fromLabel: names.get(link.from) ?? '原组员', toLabel: names.get(link.to) ?? '原组员',
      restingKind: teamMessageNeedsAgentResponse(link.message) && link.message.receipt.respondedAt === undefined ? 'waiting' : 'history' })))
    engine.current?.setRoutes(new Map(routing.reply?.routes ?? []))
    engine.current?.highlight(focusedLinkId, selectedMemberId, pinnedLinkId)
    engine.current?.draw(motionTime.current, reduced, paused, Date.now())
    wake.current?.()
  }, [links, facts.members, routing.reply, paused, reduced, focusedLinkId, pinnedLinkId, selectedMemberId])

  return (
    <div ref={viewport} className="collaboration-canvas__viewport" aria-label="协作图，可横向滚动查看" tabIndex={0}>
      <div className={`collaboration-canvas${layout.stacked ? ' is-stacked' : ''}`} style={{ width: layout.width, height: layout.height }}
        aria-busy={routing.pending} data-rows={layout.rows} data-closed={facts.closed} data-crossings={routing.reply?.crossings}>
        <svg ref={svg} className="collaboration-canvas__wires" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label="真实组内消息的收发方向" />
        {layout.nodes.map(node => {
          const member = members.get(node.id)
          if (!member) return null
          const lead = node.id === facts.leadId
          const related = selectedMemberId === node.id || links.some(link => link.id === focusedLinkId && [link.from, link.to].includes(node.id))
          return <button type="button" key={node.id} className={`collaboration-node${lead ? ' is-lead' : ''}${related ? ' is-selected' : ''}`}
            data-slot-id={node.id} data-state={member.state} style={{ transform: `translate(${node.x}px,${node.y}px)`, width: node.w, height: node.h }}
            aria-pressed={selectedMemberId === node.id} aria-label={`${member.name}，CH-${member.channelId ?? '未绑定'}，${member.stateLabel}，查看协作关系`}
            title={`${member.name} · CH-${member.channelId ?? '未绑定'} · ${member.stateLabel}${lead ? facts.actingLead ? ' · 临时主控' : ' · 主控' : ''}`}
            onClick={() => onMemberSelect(node.id)}>
            <AgentAvatar avatarId={member.avatarId} name={member.name} size="md" />
            <span className="collaboration-node__copy"><strong>{member.name}</strong>
              <small><span>CH-{member.channelId ?? '?'}</span>{lead ? <em>{facts.actingLead ? '临时主控' : '主控'}</em> : null}</small>
              <span className="collaboration-node__state">{member.stateLabel}</span>
            </span>
          </button>
        })}
        {!facts.members.length ? <p className="collaboration-canvas__empty">{facts.dissolved ? '本组已解散，成员已恢复独立。记录保留在下方。' : '组内暂无成员。'}</p> : null}
        {routing.pending && links.length ? <small className="collaboration-canvas__routing" role="status">整理连线…</small> : null}
      </div>
      {!routing.pending && routing.reply?.hasUnrouted ? <p className="collaboration-canvas__notice" role="status">部分连线暂不可用，全部成员与消息记录仍可查看。</p>
        : !routing.pending && (routing.reply?.crossings ?? 0) > 0 ? <p className="collaboration-canvas__notice">关系较密集，点击成员可聚焦其收发通道。</p> : null}
    </div>
  )
})
