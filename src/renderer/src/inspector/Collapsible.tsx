import { useEffect, useState, type ReactNode } from 'react'

/** 与 CSS `.inspector-collapsible` 的过渡时长一致；收起时内容保留到过渡结束再卸载。 */
export const COLLAPSIBLE_TRANSITION_MS = 200

/**
 * 高度可过渡的折叠容器（文件差异 / 回合明细 / 命令输出共用）。
 *
 * 用 `grid-template-rows: 0fr → 1fr` 做高度过渡，不需要测量内容高度；
 * 收起时子树先留在 DOM 里把过渡播完再卸载，展开时立即挂载。关闭态加 `inert`，
 * 过渡期间内部按钮不可聚焦，Tab 不会跳进看不见的内容。
 *
 * `keepMounted`：子树常驻，只靠 `inert` + 裁切隐藏。给内容少而重（头像、实时状态行、
 * memo 视图）的列表用——会话名册的分组——重建比留着贵，且展开的第一帧就有内容，
 * 不会先画一个空盒子再长出来。
 */
export function Collapsible({
  open,
  children,
  className,
  keepMounted = false
}: {
  open: boolean
  children: ReactNode
  className?: string
  keepMounted?: boolean
}): React.JSX.Element {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open || keepMounted) {
      setMounted(true)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), COLLAPSIBLE_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [open, keepMounted])
  return (
    <div
      className={`inspector-collapsible${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      inert={!open}
    >
      <div className="inspector-collapsible__inner">{mounted || keepMounted ? children : null}</div>
    </div>
  )
}
