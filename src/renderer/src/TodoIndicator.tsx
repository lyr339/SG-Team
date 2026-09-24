/**
 * todo 图元与状态归一：时间线过程卡（ProcessTurnCard）与检查器计划页（PlanPanel）
 * 共用同一套四态指示器，保证同一份任务清单在两处的气质一致。
 * 样式类（.todo-indicator / .todo-live）由全局 styles.css 提供（单色纪律：四态全部走 currentColor，
 * 使用侧只决定这枚 currentColor 是什么）；这里只负责结构。
 */

export type TodoTone = 'completed' | 'in_progress' | 'pending' | 'cancelled'

/** todo 状态归一：`running` 是 `in_progress` 的别名；其余未知字符串归入 cancelled（划线桶），
    同时避免未清洗的 status 直接拼进 className。 */
export function todoTone(status: string): TodoTone {
  if (status === 'completed' || status === 'in_progress' || status === 'pending') return status
  if (status === 'running') return 'in_progress'
  return 'cancelled'
}

/**
 * 四态指示器：完成=描边勾 / 进行=细环 + 环心呼吸核 / 取消=斜杠圈 / 待办=空心圆。
 * 三个环态共用同一枚 5.5 半径、1.4 描边的环，进行中只是环心多了一粒会呼吸的实心核——
 * 不旋转、不实心底：转圈是「加载中」的语汇，这里要说的是「正在做这一项」。
 */
export function TodoIndicator({ tone }: { tone: TodoTone }): React.JSX.Element {
  return (
    <span className="todo-indicator" aria-hidden="true">
      {tone === 'completed' ? (
        <svg viewBox="0 0 14 14"><path d="m3.2 7.6 2.7 2.7 5-6.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : tone === 'in_progress' ? (
        <svg className="todo-live" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle className="todo-live__core" cx="7" cy="7" r="2.6" fill="currentColor" />
        </svg>
      ) : tone === 'cancelled' ? (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m4.6 9.4 4.8-4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      )}
    </span>
  )
}
