import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import {
  CloseFeedbackIcon,
  FeedbackIcon,
  type FeedbackTone,
} from './FeedbackIcon'
interface Props extends ComponentPropsWithoutRef<'p'> {
  tone?: FeedbackTone
  ref?: Ref<HTMLParagraphElement>
  onDismiss?: () => void
  action?: ReactNode
}
/** Pure presentation: never stores read receipts, dismisses business results or
 * decides a retry. Existing callers keep their exact data/ref/operation semantics. */
export function FeedbackLine({
  tone = 'info',
  children,
  className = '',
  onDismiss,
  action,
  role,
  ref,
  ...rest
}: Props): React.JSX.Element {
  return (
    <p
      {...rest}
      ref={ref}
      className={`feedback-line is-${tone} ${className}`}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
    >
      <FeedbackIcon tone={tone} />
      <span className="feedback-line__copy">{children}</span>
      {action ? <span className="feedback-line__action">{action}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          className="feedback-close"
          aria-label="关闭提示"
          onClick={onDismiss}
        >
          <CloseFeedbackIcon />
        </button>
      ) : null}
    </p>
  )
}
