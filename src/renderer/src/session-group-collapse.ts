import { COLLAPSIBLE_TRANSITION_MS } from './inspector/Collapsible'

/**
 * 名册分组折叠时的滚动锚定（纯函数部分）。
 *
 * 折叠一组会让滚动容器的内容变矮；一旦 `scrollTop` 超过新的最大值，浏览器会在同一帧把它
 * 夹回去，整列内容瞬间下移，而折叠动画正把下面的组往上拉——一上一下就是「抖」。名册为了
 * 实时迁组不跳动刻意关了 `overflow-anchor`，所以也没有浏览器补偿。这里在动画开始前就算出
 * 终态需要的 `scrollTop`，由调用方用与折叠**同一条**时长 / 曲线缓动过去：位移仍然发生，但
 * 与列表的收缩同步、同曲线，看起来是一次整体的「落位」而不是两股方向相反的运动。
 */

/** 折叠动画时长：与 `.inspector-collapsible` 的 grid-template-rows 过渡一致。 */
export const SESSION_GROUP_COLLAPSE_MS = COLLAPSIBLE_TRANSITION_MS

export interface CollapseScrollInput {
  /** 滚动容器当前 scrollTop / scrollHeight / clientHeight（折叠开始之前的量）。 */
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 被折叠 section 相对滚动容器内容的顶部偏移（offsetTop）。 */
  sectionTop: number
  /** 将要折起的列表高度（组条几何恒定，所以它就是内容将减少的高度）。 */
  listHeight: number
}

/**
 * 折叠结束时滚动容器应停在的 scrollTop；`undefined` 表示什么都不用做（不会被夹断、组条也没被钉住，
 * 保持不动就是最平滑的）。两种需要挪的情形：
 * 1. 夹断：新的最大 scrollTop 小于当前值 → 缓动到新最大值（否则浏览器会在某一帧硬夹）；
 * 2. 钉住：被点的组条正吸顶（section 顶已滚出可视区），折叠后 section 只剩组条、sticky 失去容器，
 *    组条会被推出可视区 → 缓动到 section 顶，让被点的组条回到它在流中的位置而不是消失。
 */
export function collapseScrollTarget(input: CollapseScrollInput): number | undefined {
  const { scrollTop, scrollHeight, clientHeight, sectionTop, listHeight } = input
  if (!(scrollTop > 0)) return undefined
  const nextMax = Math.max(0, scrollHeight - listHeight - clientHeight)
  let target = Math.min(scrollTop, nextMax)
  if (scrollTop > sectionTop) target = Math.min(target, Math.max(0, sectionTop))
  return target < scrollTop ? target : undefined
}

/**
 * cubic-bezier(0.2, 0.8, 0.2, 1) —— 与 `.inspector-collapsible` 的 transition-timing-function 逐字一致，
 * 这样滚动的缓动与列表的收缩在每一帧上都对得上（用 ease-out 近似会让组条在动画中途漂几个像素再落回）。
 * 牛顿迭代求 x(t) = x 的 t，再取 y(t)；端点直接返回。
 */
export function collapseEasing(progress: number): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  const x1 = 0.2
  const y1 = 0.8
  const x2 = 0.2
  const y2 = 1
  const bezier = (a: number, b: number, t: number): number => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
  const slope = (a: number, b: number, t: number): number => 3 * a * (1 - t) * (1 - t) + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t * t
  let t = progress
  let converged = false
  for (let i = 0; i < 8; i += 1) {
    const dx = bezier(x1, x2, t) - progress
    if (Math.abs(dx) < 1e-6) {
      converged = true
      break
    }
    const d = slope(x1, x2, t)
    if (Math.abs(d) < 1e-6) break
    t -= dx / d
    if (t <= 0 || t >= 1) break
  }
  if (!converged) {
    // x(t) 在 [0, 1] 上单调递增（x1 = x2 = 0.2 ∈ [0, 1]），二分兜底。
    let low = 0
    let high = 1
    for (let i = 0; i < 24; i += 1) {
      t = (low + high) / 2
      if (bezier(x1, x2, t) < progress) low = t
      else high = t
    }
  }
  return bezier(y1, y2, t)
}
