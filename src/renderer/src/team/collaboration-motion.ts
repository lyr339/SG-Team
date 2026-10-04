import type { GraphPoint, GraphSamples } from './collaboration-layout'
import type { CollaborationLinkKind } from './collaboration-map-view'

const FLOW_SPEED = 84
const clamp = (n: number, a: number, b: number): number => Math.max(a, Math.min(b, n))
const smooth = (n: number): number => { n = clamp(n, 0, 1); return n * n * (3 - 2 * n) }
export interface GraphMarker extends GraphPoint { tx: number; ty: number; angle: number; distance: number }
export interface GraphMarkerState { visible: boolean; moving: boolean; pose?: GraphMarker; opacity: number; scale: number }

export function graphPhaseSeed(id: string): number {
  let hash = 2166136261
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967295
}
export function graphPathPosition(samples: GraphSamples, distance: number): GraphMarker | undefined {
  const points = samples.points
  if (!points.length || !Number.isFinite(samples.length)) return undefined
  distance = clamp(distance, 0, samples.length)
  let lo = 0, hi = points.length - 1
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (points[mid]!.distance < distance) lo = mid; else hi = mid }
  const a = points[lo]!, b = points[hi]!, span = b.distance - a.distance
  const t = span > 0 ? (distance - a.distance) / span : 0
  let tx = a.ny + (b.ny - a.ny) * t, ty = -a.nx + (-b.nx + a.nx) * t, norm = Math.hypot(tx, ty)
  if (norm < 1e-8) { tx = b.x - a.x; ty = b.y - a.y; norm = Math.hypot(tx, ty) || 1 }
  tx /= norm; ty /= norm
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx, ty, angle: Math.atan2(ty, tx) * 180 / Math.PI, distance }
}

export function graphMarkerState(samples: GraphSamples, kind: CollaborationLinkKind, time: number, seed: number, reduced: boolean): GraphMarkerState {
  const length = samples.length
  if (!Number.isFinite(length) || length < 16 || samples.points.length < 2) return { visible: false, moving: false, opacity: 0, scale: 1 }
  const moving = (kind === 'active' || kind === 'reply') && !reduced && length >= 72
  let distance: number, opacity: number
  if (moving) {
    const start = 22, span = length - start - 18
    const phase = ((time * FLOW_SPEED + (.15 + .7 * seed) * span) % span + span) % span
    distance = start + phase; opacity = .92 * smooth(phase / 10) * smooth((span - phase) / 12)
  } else { distance = length < 72 ? length / 2 : length - 10; opacity = kind === 'offline' ? .42 : kind === 'history' ? .78 : .78 }
  const pose = graphPathPosition(samples, distance)
  return { visible: !!pose, pose, moving, opacity, scale: length < 24 ? .8 : 1 }
}

export function graphMarkerTrail(samples: GraphSamples, pose: GraphMarker): string {
  const tail = samples.length < 72 ? Math.min(12, samples.length * .3) : 16, gap = samples.length < 24 ? 5 : 8
  if (tail <= gap) return ''
  return [tail, (tail * 2 + gap) / 3, (tail + gap * 2) / 3, gap].map((offset, index) => {
    const p = graphPathPosition(samples, pose.distance - offset)!
    return `${index ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }).join('')
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const gradients: readonly (readonly [number, number, number])[] = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]]
function gradient(x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ 0x517cc1b7
  hash = Math.imul(hash ^ hash >>> 13, 1274126177); hash ^= hash >>> 16
  const g = gradients[(hash >>> 0) % gradients.length]!
  return (g[0] * dx + g[1] * dy + g[2] * dz) * .707106781
}
function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), dx = x - ix, dy = y - iy, dz = z - iz
  const fx = fade(dx), fy = fade(dy), fz = fade(dz)
  const at = (a: number, b: number, c: number): number => gradient(ix+a, iy+b, iz+c, dx-a, dy-b, dz-c)
  return mix(mix(mix(at(0,0,0),at(1,0,0),fx),mix(at(0,1,0),at(1,1,0),fx),fy),mix(mix(at(0,0,1),at(1,0,1),fx),mix(at(0,1,1),at(1,1,1),fx),fy),fz)
}
/** Fine strands follow a low-amplitude noise field; stable endpoint envelopes keep docks exact. */
export function graphSilkPath(samples: GraphSamples, time: number, strand: number, moving: boolean): string {
  return samples.points.map((p, index) => {
    const envelope = Math.sin(Math.PI * p.distance / (samples.length || 1)) ** .7
    const offset = moving ? noise(p.distance / 80, strand * .4, time * .54) * 4 * envelope : 0
    return `${index ? 'L' : 'M'}${(p.x + p.nx * offset).toFixed(2)},${(p.y + p.ny * offset).toFixed(2)}`
  }).join('')
}
