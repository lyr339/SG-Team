import { FeedbackIcon } from './feedback/FeedbackIcon'

/**
 * todo 图元与状态归一：时间线过程卡（ProcessTurnCard）与检查器计划页（PlanPanel）
 * 共用同一套四态指示器，保证同一份任务清单在两处的气质一致。
 * 完成态复用产品的绿色圈勾；其余状态保留缺口环、点线环与取消圈，不把未知状态画成成功。
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
 * 四态指示器：完成=绿色描边圈勾 / 进行=缺口细环 / 取消=斜杠圈 / 待办=点线环。
 * 常驻状态静止；右栏仅在任务刚开始时轻弹一次。
 */
export function TodoIndicator({ tone }: { tone: TodoTone }): React.JSX.Element {
  return (
    <span className="todo-indicator" aria-hidden="true">
      {tone === 'completed' ? (
        <FeedbackIcon tone="success" />
      ) : tone === 'in_progress' ? (
        <svg className="todo-live" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="25 9" />
        </svg>
      ) : tone === 'cancelled' ? (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m4.6 9.4 4.8-4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      ) : (
        <svg className="todo-pending" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="0.1 4.06" /></svg>
      )}
    </span>
  )
}
