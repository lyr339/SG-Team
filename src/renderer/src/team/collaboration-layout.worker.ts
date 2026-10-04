import { solveGraphLayout, type GraphLayoutJob, type GraphLayoutReply } from './collaboration-layout-client'

const workerScope = self as unknown as { onmessage: ((event: MessageEvent<GraphLayoutJob>) => void) | null; postMessage(reply: GraphLayoutReply): void }
workerScope.onmessage = event => {
  try { workerScope.postMessage(solveGraphLayout(event.data)) }
  catch { workerScope.postMessage({ key: event.data.key, routes: [], ports: [], crossings: 0, hasUnrouted: true, error: '连线暂不可用，成员与消息记录仍可查看' }) }
}
