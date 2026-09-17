import type { ReviewScopeId } from './review-scope'

/**
 * 中栏 → 右栏的「去审查」信号：输入区上方的本轮文件栏点「审查」或点某一行时，右栏要
 * 展开、切到「变更」标签、范围切到「本轮」（或请求指定的范围），并（带路径时）展开定位到那个文件。
 *
 * 与 reveal-bus 同一形态：三处消费者（DesktopShell 开右栏、WorkspaceInspector 切标签、
 * ReviewPanel 切范围并定位）不在同一棵子树下，用模块级订阅代替层层 prop 透传；只传路径与范围。
 */
export interface ReviewFocusRequest {
  /** 归一后的仓库相对路径；缺省只切范围，不定位具体文件。 */
  path?: string
  /** 右栏要切到的范围；缺省「本轮」。文件栏显示「上一轮」时用「未提交」——右栏的「本轮」那时是空的。 */
  scope?: ReviewScopeId
}

type ReviewFocusListener = (request: ReviewFocusRequest) => void

const listeners = new Set<ReviewFocusListener>()

export function subscribeReviewFocus(listener: ReviewFocusListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 广播；单个监听方抛错不影响其他人。 */
export function requestReviewFocus(request: ReviewFocusRequest = {}): void {
  for (const listener of [...listeners]) {
    try {
      listener(request)
    } catch {
      // 监听方自己的问题不阻断其余消费者。
    }
  }
}
