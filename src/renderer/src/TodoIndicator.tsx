/**
 * Cursor 原生 todo 图元与状态归一：时间线过程卡（ProcessTurnCard）与检查器计划页（PlanPanel）
 * 共用同一套四态指示器，保证同一份任务清单在两处的气质一致。
 * 样式类（.todo-indicator / .todo-spinner）由全局 styles.css 提供（单色纪律：勾与圈走 currentColor，
 * 进行中是实心圆上的反色旋转弧）；使用侧只负责结构。
 */

export type TodoTone = 'completed' | 'in_progress' | 'pending' | 'cancelled'

/** todo 状态归一：`running` 是 `in_progress` 的别名；其余未知字符串归入 cancelled（划线桶），
    同时避免未清洗的 status 直接拼进 className。 */
export function todoTone(status: string): TodoTone {
  if (status === 'completed' || status === 'in_progress' || status === 'pending') return status
  if (status === 'running') return 'in_progress'
  return 'cancelled'
}

/** 四态指示器：完成=描边勾 / 进行=12px 实心圆反色旋转弧 / 取消=斜杠圈 / 待办=空心圆。 */
export function TodoIndicator({ tone }: { tone: TodoTone }): React.JSX.Element {
  return (
    <span className="todo-indicator" aria-hidden="true">
      {tone === 'completed' ? (
        <svg viewBox="0 0 14 14"><path d="m3.2 7.6 2.7 2.7 5-6.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : tone === 'in_progress' ? (
        <span className="todo-spinner">
          <svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeDasharray="21.7 29" /></svg>
        </span>
      ) : tone === 'cancelled' ? (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m4.6 9.4 4.8-4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      )}
    </span>
  )
}
