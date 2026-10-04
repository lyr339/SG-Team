import { graphPath, sampleGraphPath, type GraphCurve, type GraphSamples } from './collaboration-layout'
import { graphMarkerState, graphMarkerTrail, graphPathPosition, graphPhaseSeed, graphSilkPath } from './collaboration-motion'
import type { CollaborationLinkKind } from './collaboration-map-view'

interface WireLink {
  id: string; from: string; to: string; kind: CollaborationLinkKind; label: string
  fromLabel: string; toLabel: string; pulseUntil?: number; restingKind: CollaborationLinkKind
}
interface Wire {
  link: WireLink; root: SVGGElement; hit: SVGPathElement; paths: SVGPathElement[]
  tip: SVGPathElement; arrow: SVGGElement; trail: SVGPathElement; samples?: GraphSamples; key: string; seed: number
}
function svg<Tag extends keyof SVGElementTagNameMap>(tag: Tag, attrs: Record<string, string>): SVGElementTagNameMap[Tag] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value)
  return element
}

/** Imperative motion island: React never reconciles per-frame SVG paths. */
export class CollaborationWireLayer {
  private readonly wires = new Map<string, Wire>()
  constructor(private readonly root: SVGSVGElement, private readonly interaction: (kind: 'enter' | 'leave' | 'select', id: string) => void) {}
  setLinks(links: readonly WireLink[]): void {
    const valid = new Set(links.map(link => link.id))
    for (const [id, wire] of this.wires) if (!valid.has(id)) {
      if (wire.root === document.activeElement) this.root.closest<HTMLElement>('.collaboration-canvas__viewport')?.focus({ preventScroll: true })
      wire.root.remove(); this.wires.delete(id)
    }
    for (const link of links) {
      let wire = this.wires.get(link.id)
      if (!wire) {
        const group = svg('g', { class: 'collaboration-wire', tabindex: '-1', role: 'button' })
        const hit = svg('path', { class: 'collaboration-wire__hit', fill: 'none', stroke: 'transparent', 'stroke-width': '15' })
        const paths = Array.from({ length: 5 }, (_, i) => svg('path', { class: `collaboration-wire__silk strand-${i}`, fill: 'none', 'stroke-width': '1.2' }))
        const tip = svg('path', { class: 'collaboration-wire__tip', fill: 'none', 'stroke-width': '1.3' })
        const trail = svg('path', { class: 'collaboration-wire__trail', fill: 'none', 'aria-hidden': 'true' })
        const arrow = svg('g', { class: 'collaboration-wire__arrow', 'aria-hidden': 'true', style: 'display:none' })
        const chevron = 'M-6,-3L0,0L-6,3'
        arrow.append(svg('path', { class: 'collaboration-wire__halo', d: chevron }), svg('path', { class: 'collaboration-wire__chevron', d: chevron }))
        group.append(hit, ...paths, trail, tip, arrow)
        group.addEventListener('pointerenter', () => this.interaction('enter', link.id))
        group.addEventListener('pointerleave', () => this.interaction('leave', link.id))
        group.addEventListener('focus', () => this.interaction('enter', link.id))
        group.addEventListener('blur', () => this.interaction('leave', link.id))
        group.addEventListener('click', () => this.interaction('select', link.id))
        group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.interaction('select', link.id) } })
        this.root.append(group)
        wire = { link, root: group, hit, paths, tip, trail, arrow, key: '', seed: graphPhaseSeed(link.id) }
        this.wires.set(link.id, wire)
      }
      if (wire.link.from !== link.from || wire.link.to !== link.to) { wire.arrow.style.display = 'none'; wire.tip.style.display = 'none'; wire.trail.style.display = 'none' }
      wire.link = link
      wire.root.dataset.from = link.from; wire.root.dataset.to = link.to
      wire.root.setAttribute('aria-label', `${link.fromLabel} → ${link.toLabel}：${link.label}`)
    }
  }
  setRoutes(routes: ReadonlyMap<string, GraphCurve[]>): void {
    for (const wire of this.wires.values()) {
      const canonical = routes.get(wire.link.id) ?? []
      const curves = wire.link.from < wire.link.to ? canonical : [...canonical].reverse().map(p => [...p].reverse() as GraphCurve)
      const key = graphPath(curves)
      wire.root.setAttribute('tabindex', key ? '0' : '-1')
      wire.root.setAttribute('aria-hidden', String(!key))
      if (wire.key === key) continue
      wire.key = key; wire.samples = sampleGraphPath(curves); wire.hit.setAttribute('d', key)
      const tip = graphPathPosition(wire.samples, wire.samples.length - 8)
      if (tip) {
        const theta = Math.atan2(tip.ty, tip.tx), l = theta + 2.5, r = theta - 2.5
        wire.tip.setAttribute('d', `M${tip.x+Math.cos(l)*5},${tip.y+Math.sin(l)*5}L${tip.x},${tip.y}L${tip.x+Math.cos(r)*5},${tip.y+Math.sin(r)*5}`)
      } else { wire.arrow.style.display = 'none'; wire.trail.setAttribute('d', ''); wire.tip.style.display = 'none' }
    }
  }
  draw(time: number, reduced: boolean, paused: boolean, now: number): void {
    for (const wire of this.wires.values()) {
      if (!wire.samples?.points.length) continue
      const expired = (wire.link.kind === 'active' || wire.link.kind === 'reply') && (wire.link.pulseUntil ?? 0) <= now
      const kind = expired ? wire.link.restingKind : wire.link.kind
      wire.root.dataset.kind = kind
      const flowing = kind === 'active' || kind === 'reply'
      wire.paths.forEach((path, i) => {
        path.style.display = !flowing && i > 0 ? 'none' : ''
        if (flowing || i === 0) path.setAttribute('d', graphSilkPath(wire.samples!, !reduced && flowing ? time : 0, i, flowing))
      })
      const marker = graphMarkerState(wire.samples, kind, time, wire.seed, reduced)
      wire.root.dataset.motion = marker.moving ? paused ? 'paused' : 'flowing' : kind
      wire.arrow.style.display = marker.visible ? '' : 'none'; wire.trail.style.display = marker.visible ? '' : 'none'
      wire.tip.style.display = marker.moving ? '' : 'none'
      if (marker.pose) {
        const p = marker.pose
        wire.arrow.setAttribute('transform', `translate(${p.x.toFixed(2)},${p.y.toFixed(2)}) rotate(${p.angle.toFixed(2)}) scale(${marker.scale})`)
        wire.arrow.style.opacity = marker.opacity.toFixed(3); wire.trail.style.opacity = (marker.opacity * .65).toFixed(3)
        wire.trail.setAttribute('d', graphMarkerTrail(wire.samples, p))
      }
    }
  }
  highlight(edgeId: string | undefined, memberId: string | undefined, pinnedEdgeId: string | undefined): void {
    for (const wire of this.wires.values()) {
      const selected = edgeId ? wire.link.id === edgeId : memberId ? [wire.link.from, wire.link.to].includes(memberId) : true
      wire.root.classList.toggle('is-dimmed', !selected); wire.root.classList.toggle('is-focused', selected && !!(edgeId || memberId))
      wire.root.setAttribute('aria-pressed', String(!!pinnedEdgeId && wire.link.id === pinnedEdgeId))
    }
  }
  destroy(): void { for (const wire of this.wires.values()) wire.root.remove(); this.wires.clear() }
}
