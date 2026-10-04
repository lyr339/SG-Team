/** Pure geometry shared by the layout worker and deterministic tests. No runtime/session data. */
export interface GraphPoint { x: number; y: number }
export type GraphCurve = [GraphPoint, GraphPoint, GraphPoint, GraphPoint]
export interface GraphNode extends GraphPoint { id: string; w: number; h: number }
export interface GraphEdge { id: string; from: string; to: string }
export interface GraphLayout { width: number; height: number; rows: number; columns: number; stacked: boolean; nodes: GraphNode[] }
export interface GraphSamplePoint extends GraphPoint { nx: number; ny: number; distance: number }
export interface GraphSamples { points: GraphSamplePoint[]; length: number }
type Side = 'L' | 'R' | 'T' | 'B'
interface RouteSpec { a: Side; b: Side; fa: number; fb: number; scale: number; via?: 'top' | 'bottom' | 'middle' }
export interface GraphPort { edgeId: string; nodeId: string; side: Side; offset: number; fraction: number }
export interface GraphRoutes { routes: Map<string, GraphCurve[]>; ports: GraphPort[]; crossings: number; hasUnrouted: boolean }
const point = (x: number, y: number): GraphPoint => ({ x, y })
const sides: readonly Side[] = ['L', 'R', 'T', 'B']
const scales = [.22, .36, .52, .72]

/** Keep directly collaborating peers close; ignore hub edges so the lead is not a fake pipeline. */
export function graphMemberOrder(ids: readonly string[], leadId: string | undefined, edges: readonly GraphEdge[]): string[] {
  const degree = new Map(ids.map(id => [id, new Set<string>()]))
  for (const edge of edges) if (degree.has(edge.from) && degree.has(edge.to)) { degree.get(edge.from)!.add(edge.to); degree.get(edge.to)!.add(edge.from) }
  const busiest = [...ids].sort((a, b) => degree.get(b)!.size - degree.get(a)!.size || ids.indexOf(a) - ids.indexOf(b))[0]
  // Flat groups may have a busy communication hub, but it remains an ordinary
  // member in the two-row grid: this ordering does not assign/pin a lead.
  const hub = leadId ?? (busiest && degree.get(busiest)!.size >= 3 ? busiest : undefined)
  const peers = ids.filter(id => id !== hub), index = new Map(peers.map((id, i) => [id, i]))
  const neighbors = new Map(peers.map(id => [id, new Set<string>()]))
  for (const edge of edges) if (neighbors.has(edge.from) && neighbors.has(edge.to)) { neighbors.get(edge.from)!.add(edge.to); neighbors.get(edge.to)!.add(edge.from) }
  const unseen = new Set(peers), groups: string[][] = []
  for (const first of peers) {
    if (!unseen.delete(first)) continue
    const group: string[] = [], queue = [first]
    while (queue.length) {
      const id = queue.shift()!; group.push(id)
      for (const other of neighbors.get(id)!) if (unseen.delete(other)) queue.push(other)
    }
    group.sort((a, b) => neighbors.get(b)!.size - neighbors.get(a)!.size || index.get(a)! - index.get(b)!)
    groups.push(group)
  }
  groups.sort((a, b) => Math.min(...a.map(id => index.get(id)!)) - Math.min(...b.map(id => index.get(id)!)))
  return [...(hub && ids.includes(hub) ? [hub] : []), ...groups.flat()]
}

/** Eight-member groups use two rows. Larger groups keep readable cards and add balanced rows, never drop nodes. */
export function graphLayout(ids: readonly string[], leadId: string | undefined, availableWidth: number): GraphLayout {
  const lead = leadId && ids.includes(leadId) ? leadId : undefined
  const peers = ids.filter(id => id !== lead)
  const stacked = availableWidth < 900
  const w = stacked ? 100 : 152, h = stacked ? 128 : 84, leadW = stacked ? 112 : 152
  const gap = stacked ? 22 : 28, left = stacked ? 16 : 30, right = 24, bridge = stacked ? 42 : 64
  const rows = peers.length <= 2 ? 1 : peers.length <= 8 ? 2 : Math.ceil(peers.length / 4)
  const columns = Math.max(1, Math.ceil(peers.length / rows))
  const gridStart = lead ? left + leadW + bridge : left
  const minimum = gridStart + columns * w + (columns - 1) * gap + right
  const width = Math.max(availableWidth, minimum, 320)
  const pitch = stacked ? 218 : 204
  const height = rows === 1 ? 272 : Math.max(440, 236 + (rows - 1) * pitch)
  const nodes: GraphNode[] = lead ? [{ id: lead, x: left, y: (height - h) / 2, w: leadW, h }] : []
  let index = 0
  for (let row = 0; row < rows; row++) {
    const count = Math.floor(peers.length / rows) + (row < peers.length % rows ? 1 : 0)
    const rowWidth = count * w + Math.max(0, count - 1) * gap
    const inset = (width - right - gridStart - rowWidth) / 2
    for (let col = 0; col < count; col++) {
      const id = peers[index++]
      if (id) nodes.push({ id, x: gridStart + inset + col * (w + gap),
        y: height / 2 + (row - (rows - 1) / 2) * pitch - h / 2, w, h })
    }
  }
  return { width, height, rows, columns, stacked, nodes }
}

function port(node: GraphNode, side: Side, fraction = .5): { point: GraphPoint; normal: GraphPoint } {
  const normal = { L: point(-1, 0), R: point(1, 0), T: point(0, -1), B: point(0, 1) }[side]
  return { normal, point: side === 'L' ? point(node.x, node.y + node.h * fraction)
    : side === 'R' ? point(node.x + node.w, node.y + node.h * fraction)
      : side === 'T' ? point(node.x + node.w * fraction, node.y) : point(node.x + node.w * fraction, node.y + node.h) }
}

export function graphPath(curves: readonly GraphCurve[]): string {
  if (!curves.length) return ''
  const f = (p: GraphPoint): string => `${p.x.toFixed(2)},${p.y.toFixed(2)}`
  return `M${f(curves[0]![0])}` + curves.map(p => `C${f(p[1])} ${f(p[2])} ${f(p[3])}`).join('')
}

export function sampleGraphPath(curves: readonly GraphCurve[], step = 6): GraphSamples {
  const points: GraphSamplePoint[] = []
  let distance = 0
  for (const p of curves) {
    const polygon = p.slice(1).reduce((s, v, i) => s + Math.hypot(v.x - p[i]!.x, v.y - p[i]!.y), 0)
    const n = Math.max(12, Math.ceil(polygon / step))
    for (let i = points.length ? 1 : 0; i <= n; i++) {
      const t = i / n, q = 1 - t
      const x = q ** 3 * p[0].x + 3 * q * q * t * p[1].x + 3 * q * t * t * p[2].x + t ** 3 * p[3].x
      const y = q ** 3 * p[0].y + 3 * q * q * t * p[1].y + 3 * q * t * t * p[2].y + t ** 3 * p[3].y
      const dx = 3 * q * q * (p[1].x - p[0].x) + 6 * q * t * (p[2].x - p[1].x) + 3 * t * t * (p[3].x - p[2].x)
      const dy = 3 * q * q * (p[1].y - p[0].y) + 6 * q * t * (p[2].y - p[1].y) + 3 * t * t * (p[3].y - p[2].y)
      const norm = Math.hypot(dx, dy) || 1, previous = points.at(-1)
      if (previous) distance += Math.hypot(x - previous.x, y - previous.y)
      points.push({ x, y, nx: -dy / norm, ny: dx / norm, distance })
    }
  }
  return { points, length: distance }
}

export function graphInside(p: GraphPoint, node: GraphNode, padding = 0): boolean {
  return p.x > node.x - padding && p.x < node.x + node.w + padding && p.y > node.y - padding && p.y < node.y + node.h + padding
}

function generate(spec: RouteSpec | undefined, edge: GraphEdge, layout: GraphLayout): GraphCurve[] {
  const a = layout.nodes.find(n => n.id === edge.from), b = layout.nodes.find(n => n.id === edge.to)
  if (!spec || !a || !b || a === b) return []
  const start = port(a, spec.a, spec.fa), end = port(b, spec.b, spec.fb)
  const distance = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y)
  const h = Math.max(22, distance * spec.scale)
  const c1 = point(start.point.x + start.normal.x * h, start.point.y + start.normal.y * h)
  const c2 = point(end.point.x + end.normal.x * h, end.point.y + end.normal.y * h)
  if (!spec.via) return [[start.point, c1, c2, end.point]]
  const mid = point((start.point.x + end.point.x) / 2, spec.via === 'top' ? 18 : spec.via === 'bottom' ? layout.height - 18 : layout.height / 2)
  const tangent = Math.min(95, distance * .2) * (Math.sign(end.point.x - start.point.x) || 1)
  return [[start.point, c1, point(mid.x - tangent, mid.y), mid], [mid, point(mid.x + tangent, mid.y), c2, end.point]]
}

function valid(samples: GraphSamples, edge: GraphEdge, layout: GraphLayout): boolean {
  return samples.points.length > 1 && samples.points.every(p => p.x >= 4 && p.x <= layout.width - 4 && p.y >= 4 && p.y <= layout.height - 4
    && layout.nodes.every(n => {
      const endpoint = n.id === edge.from && p.distance < 9 || n.id === edge.to && samples.length - p.distance < 9
      return !graphInside(p, n, endpoint ? 0 : 4)
    }))
}

function quality(samples: GraphSamples, spec: RouteSpec): number {
  let turn = 0, previous: number | undefined
  for (let i = 1; i < samples.points.length; i++) {
    const a = samples.points[i - 1]!, b = samples.points[i]!, angle = Math.atan2(b.y - a.y, b.x - a.x)
    if (previous !== undefined) turn += Math.abs(Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous)))
    previous = angle
  }
  return samples.length + turn * 13 + (spec.via ? 65 : 0)
}

function candidates(edge: GraphEdge, layout: GraphLayout): RouteSpec[] {
  const families = new Map<string, { spec: RouteSpec; cost: number }[]>()
  const add = (spec: RouteSpec): void => {
    const curves = generate(spec, edge, layout), sampled = sampleGraphPath(curves, 10)
    if (!valid(sampled, edge, layout)) return
    const key = spec.a + spec.b + (spec.via ?? 'direct'), bucket = families.get(key) ?? []
    bucket.push({ spec, cost: quality(sampled, spec) }); bucket.sort((a, b) => a.cost - b.cost)
    families.set(key, bucket.slice(0, 2))
  }
  for (const a of sides) for (const b of sides) for (const scale of scales) add({ a, b, fa: .5, fb: .5, scale })
  for (const a of sides) for (const b of sides) for (const via of ['top', 'bottom', 'middle'] as const)
    for (const scale of [.25, .42]) add({ a, b, fa: .5, fb: .5, scale, via })
  return [...families.values()].flat().sort((a, b) => a.cost - b.cost).slice(0, 44).map(item => item.spec)
}

export function graphCrossing(a: GraphSamples, b: GraphSamples): GraphPoint | undefined {
  for (let i = 1; i < a.points.length; i++) for (let j = 1; j < b.points.length; j++) {
    const p = a.points[i - 1]!, q = a.points[i]!, r = b.points[j - 1]!, s = b.points[j]!
    if (Math.max(p.x, q.x) < Math.min(r.x, s.x) || Math.max(r.x, s.x) < Math.min(p.x, q.x)
      || Math.max(p.y, q.y) < Math.min(r.y, s.y) || Math.max(r.y, s.y) < Math.min(p.y, q.y)) continue
    const dx = q.x - p.x, dy = q.y - p.y, ex = s.x - r.x, ey = s.y - r.y, det = dx * ey - dy * ex
    if (Math.abs(det) < 1e-7) continue
    const u = ((r.x - p.x) * ey - (r.y - p.y) * ex) / det, v = ((r.x - p.x) * dy - (r.y - p.y) * dx) / det
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    const hit = point(p.x + dx * u, p.y + dy * u)
    const endpoint = (route: GraphSamples): boolean => [route.points[0]!, route.points.at(-1)!].some(p => Math.hypot(hit.x - p.x, hit.y - p.y) < 3)
    if (!endpoint(a) || !endpoint(b)) return hit
  }
  return undefined
}

interface Dock { routes: Map<string, GraphCurve[]>; ports: GraphPort[]; assigned: Map<string, RouteSpec> }
function centeredDock(specs: ReadonlyMap<string, RouteSpec>, edges: readonly GraphEdge[], layout: GraphLayout): Dock {
  const assigned = new Map([...specs].map(([id, spec]) => [id, { ...spec, fa: .5, fb: .5 }]))
  interface Item { edgeId: string; node: GraphNode; other: GraphNode; side: Side; field: 'fa' | 'fb' }
  const groups = new Map<string, Item[]>(), ports: GraphPort[] = []
  for (const edge of edges) {
    const spec = assigned.get(edge.id)
    if (!spec) continue
    for (const field of ['a', 'b'] as const) {
      const node = layout.nodes.find(n => n.id === (field === 'a' ? edge.from : edge.to))
      const other = layout.nodes.find(n => n.id === (field === 'a' ? edge.to : edge.from))
      if (!node || !other) continue
      const key = `${node.id}:${spec[field]}`, list = groups.get(key) ?? []
      list.push({ edgeId: edge.id, node, other, side: spec[field], field: field === 'a' ? 'fa' : 'fb' }); groups.set(key, list)
    }
  }
  for (const list of groups.values()) {
    const first = list[0]!, vertical = first.side === 'L' || first.side === 'R'
    const angle = (item: Item): number => {
      const dx = item.other.x + item.other.w / 2 - item.node.x - item.node.w / 2
      const dy = item.other.y + item.other.h / 2 - item.node.y - item.node.h / 2
      return vertical ? Math.atan2(dy, item.side === 'R' ? dx : -dx) : -Math.atan2(dx, item.side === 'B' ? dy : -dy)
    }
    list.sort((a, b) => angle(a) - angle(b) || a.other.id.localeCompare(b.other.id) || a.edgeId.localeCompare(b.edgeId))
    const size = vertical ? first.node.h : first.node.w, spacing = list.length === 1 ? 0 : Math.min(12, (size - 28) / (list.length - 1))
    list.forEach((item, index) => {
      const offset = (index - (list.length - 1) / 2) * spacing, fraction = .5 + offset / size
      assigned.get(item.edgeId)![item.field] = fraction
      ports.push({ edgeId: item.edgeId, nodeId: item.node.id, side: item.side, offset, fraction })
    })
  }
  const routes = new Map(edges.flatMap(edge => { const curves = generate(assigned.get(edge.id), edge, layout); return curves.length ? [[edge.id, curves] as const] : [] }))
  return { routes, ports, assigned }
}

interface CurveMemo { curves: Map<string, { samples: GraphSamples; uid: number; cost: number }>; hits: Map<string, boolean>; nextId: number }
function evaluate(dock: Dock, edges: readonly GraphEdge[], layout: GraphLayout, memo?: CurveMemo): { crossings: number; blocked: boolean; cost: number } {
  const lines = [...dock.routes].map(([id, curves]) => {
    const key = graphPath(curves)
    let saved = memo?.curves.get(key)
    if (!saved) {
      const samples = sampleGraphPath(curves, 7)
      saved = { samples, uid: memo ? memo.nextId++ : 0, cost: quality(samples, dock.assigned.get(id)!) }
      if (memo) { memo.curves.set(key, saved); if (memo.curves.size > 256) memo.curves.delete(memo.curves.keys().next().value!) }
    }
    return { id, ...saved }
  })
  let crossings = 0, blocked = dock.routes.size !== edges.length, cost = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, edge = edges.find(e => e.id === line.id)!
    if (!valid(line.samples, edge, layout)) blocked = true
    cost += line.cost
    for (let j = i + 1; j < lines.length; j++) {
      const other = lines[j]!, key = [line.uid, other.uid].sort((a, b) => a - b).join(':')
      let hit = memo?.hits.get(key)
      if (hit === undefined) {
        hit = !!graphCrossing(line.samples, other.samples)
        if (memo) { memo.hits.set(key, hit); if (memo.hits.size > 2048) memo.hits.delete(memo.hits.keys().next().value!) }
      }
      if (hit) crossings++
    }
  }
  return { crossings, blocked, cost }
}

const templateCache = new Map<string, Map<string, RouteSpec>>()
/** Stable unordered pair routes; delivery direction only reverses traversal, never moves docks. */
export function graphRoutes(edges: readonly GraphEdge[], layout: GraphLayout): GraphRoutes {
  const eligible = edges.filter(e => e.from !== e.to && layout.nodes.some(n => n.id === e.from) && layout.nodes.some(n => n.id === e.to))
  const physical = eligible.map(e => ({ ...e, from: e.from < e.to ? e.from : e.to, to: e.from < e.to ? e.to : e.from })).sort((a, b) => a.id.localeCompare(b.id))
  const result = (dock: Dock, crossings: number): GraphRoutes => ({ routes: new Map(eligible.flatMap(edge => {
    const curves = dock.routes.get(edge.id)
    return curves ? [[edge.id, edge.from < edge.to ? curves : [...curves].reverse().map(p => [...p].reverse() as GraphCurve)] as const] : []
  })), ports: dock.ports, crossings, hasUnrouted: dock.routes.size !== edges.length })
  const key = JSON.stringify([physical, layout.nodes.map(n => [n.id, n.w, n.h]), layout.height])
  const cached = templateCache.get(key)
  if (cached) { const dock = centeredDock(cached, physical, layout), audit = evaluate(dock, physical, layout); if (!audit.blocked && !audit.crossings) return result(dock, 0) }
  const options = physical.map(edge => ({ edge, options: candidates(edge, layout) })).sort((a, b) => a.options.length - b.options.length || a.edge.id.localeCompare(b.edge.id))
  const memo: CurveMemo = { curves: new Map(), hits: new Map(), nextId: 0 }
  interface Choice { specs: Map<string, RouteSpec>; crossings: number; cost: number }
  let beam: Choice[] = [{ specs: new Map(), crossings: 0, cost: 0 }]
  for (const { edge, options: available } of options) {
    const next: Choice[] = []
    for (const state of beam) for (const spec of available) {
      const specs = new Map([...state.specs, [edge.id, spec]]), placed = physical.filter(e => specs.has(e.id)), dock = centeredDock(specs, placed, layout)
      const audit = evaluate(dock, placed, layout, memo)
      if (!audit.blocked) next.push({ specs, crossings: audit.crossings, cost: audit.cost })
    }
    next.sort((a, b) => a.crossings - b.crossings || a.cost - b.cost)
    if (next.length) beam = next.slice(0, 14)
  }
  let best = beam[0]!, dock = centeredDock(best.specs, physical, layout), audit = evaluate(dock, physical, layout)
  for (let round = 0; round < 3 && audit.crossings && !audit.blocked; round++) {
    let improved = best
    for (const { edge, options: available } of options) for (const spec of available) {
      if (spec === best.specs.get(edge.id)) continue
      const specs = new Map([...best.specs, [edge.id, spec]]), trial = centeredDock(specs, physical, layout), check = evaluate(trial, physical, layout, memo)
      if (!check.blocked && (check.crossings < improved.crossings || check.crossings === improved.crossings && check.cost < improved.cost)) improved = { specs, crossings: check.crossings, cost: check.cost }
    }
    if (improved === best) break
    best = improved; dock = centeredDock(best.specs, physical, layout); audit = evaluate(dock, physical, layout)
  }
  templateCache.set(key, best.specs)
  if (templateCache.size > 24) templateCache.delete(templateCache.keys().next().value!)
  return result(dock, audit.crossings)
}
