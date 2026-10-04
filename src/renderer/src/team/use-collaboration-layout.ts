import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GraphLayoutClient, type GraphLayoutJob, type GraphLayoutReply } from './collaboration-layout-client'
import { graphLayout, type GraphEdge } from './collaboration-layout'

interface LayoutResult { job: GraphLayoutJob; reply: GraphLayoutReply }
export function useCollaborationLayout(scopeKey: string, ids: readonly string[], leadId: string | undefined, width: number, edges: readonly GraphEdge[]) {
  const idKey = ids.join('\u0000')
  const pairKey = edges.map(e => `${e.id}:${e.from}:${e.to}`).join('\u0000')
  const job = useMemo<GraphLayoutJob>(() => {
    const layout = graphLayout(ids, leadId, Math.max(320, Math.round(width / 8) * 8))
    const membershipKey = JSON.stringify([scopeKey, ids, leadId])
    return { key: JSON.stringify([membershipKey, layout, pairKey]), membershipKey, layout, edges: [...edges] }
    // Primitive signatures deliberately exclude runtime states and message direction.
  }, [scopeKey, idKey, leadId, width, pairKey])
  const currentKey = useRef(job.key)
  useLayoutEffect(() => { currentKey.current = job.key }, [job.key])
  const broker = useRef<GraphLayoutClient | undefined>(undefined)
  const [result, setResult] = useState<LayoutResult>()
  useEffect(() => {
    let alive = true
    let worker: Worker | undefined
    try { if (typeof Worker === 'function') worker = new Worker(new URL('./collaboration-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { /* Unsupported worker environments use the same validated solver. */ }
    const client = new GraphLayoutClient(worker, (job, reply) => {
      if (alive && reply.key === currentKey.current) setResult({ job, reply })
    })
    broker.current = client
    return () => { alive = false; client.destroy(); if (broker.current === client) broker.current = undefined }
  }, [scopeKey])
  useEffect(() => { broker.current?.request(job) }, [job])
  const sameMembers = result?.job.membershipKey === job.membershipKey
  const ready = result?.reply.key === job.key
  // Keep nodes and their curves together while resizing. Never stretch old curves onto new coordinates.
  return {
    layout: sameMembers && !ready ? result!.job.layout : job.layout,
    reply: sameMembers ? result?.reply : undefined,
    pending: !ready,
    ready
  }
}
