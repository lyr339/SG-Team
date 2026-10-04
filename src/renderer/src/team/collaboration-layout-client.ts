import { graphRoutes, type GraphCurve, type GraphEdge, type GraphLayout, type GraphPort } from './collaboration-layout'

export interface GraphLayoutJob { key: string; membershipKey: string; layout: GraphLayout; edges: GraphEdge[] }
export interface GraphLayoutReply {
  key: string
  routes: [string, GraphCurve[]][]
  ports: GraphPort[]
  crossings: number
  hasUnrouted: boolean
  error?: string
}
export function solveGraphLayout(job: GraphLayoutJob): GraphLayoutReply {
  const result = graphRoutes(job.edges, job.layout)
  return { key: job.key, routes: [...result.routes], ports: result.ports, crossings: result.crossings, hasUnrouted: result.hasUnrouted }
}

/** Latest-wins broker: resizing never queues dozens of expensive stale layouts. */
export class GraphLayoutClient {
  private worker?: Worker
  private active?: GraphLayoutJob
  private pending?: GraphLayoutJob
  private closed = false

  constructor(worker: Worker | undefined, private readonly receive: (job: GraphLayoutJob, reply: GraphLayoutReply) => void) {
    this.worker = worker
    if (worker) {
      worker.onmessage = (event: MessageEvent<GraphLayoutReply>) => {
        if (this.closed || !this.active || event.data.key !== this.active.key) return
        const job = this.active; this.active = undefined
        if (event.data.error) this.fallback(job)
        else this.receive(job, event.data)
        this.flush()
      }
      worker.onerror = event => {
        event.preventDefault()
        this.failWorker()
      }
    }
  }
  request(job: GraphLayoutJob): void {
    if (this.closed) return
    this.pending = job
    this.flush()
  }
  private flush(): void {
    if (this.closed || this.active || !this.pending) return
    const job = this.pending; this.pending = undefined
    if (this.worker) {
      this.active = job
      try { this.worker.postMessage(job) }
      catch { this.failWorker() }
    }
    else this.fallback(job)
  }
  private failWorker(): void {
    if (this.closed) return
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = undefined }
    const job = this.pending ?? this.active
    this.active = this.pending = undefined
    if (job) this.fallback(job)
  }
  private fallback(job: GraphLayoutJob): void {
    if (this.closed) return
    try { this.receive(job, solveGraphLayout(job)) }
    catch { this.receive(job, { key: job.key, routes: [], ports: [], crossings: 0, hasUnrouted: true, error: '连线暂不可用，成员与消息记录仍可查看' }) }
  }
  destroy(): void {
    this.closed = true
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate() }
    this.active = this.pending = undefined
  }
}
