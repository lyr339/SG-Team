import { useEffect, useRef } from 'react'
import type { ConfirmConsequence } from './pool-view'

interface ConfirmSheetProps {
  consequence: ConfirmConsequence
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 破坏性动作的唯一确认面：结束 / 新建批次 / 移出成员 / 解散组共用。
 * 随内容流展示（不是遮罩弹窗），标题说动作、正文说后果、按钮说结果；
 * 做了回不来的（解散 / 结束 / 新建批次）确认按钮走红色，可再改回去的走主操作色。
 * 打开即接管焦点（落在「取消」上，Enter 不会误确认），Esc 取消；关掉后焦点还给触发它的那个按钮。
 */
export function ConfirmSheet({ consequence, busy, onCancel, onConfirm }: ConfirmSheetProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus({ preventScroll: true })
  }, [])

  /**
   * 收起时立刻还焦点，而不是等卸载：RunSlot 让确认面再停 240ms 做收起过渡（期间 inert），
   * 那一刻焦点会掉到 body。触发按钮仍在页面上才还；它随动作消失（如被移出的成员行）时不抢别处的焦点。
   */
  const restoreFocus = (): void => {
    const opener = openerRef.current
    if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus({ preventScroll: true })
  }
  const cancel = (): void => { restoreFocus(); onCancel() }
  const confirm = (): void => { restoreFocus(); onConfirm() }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      const opener = openerRef.current
      if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus({ preventScroll: true })
      onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [busy, onCancel])

  return (
    <section className="run-sheet" role="alertdialog" aria-labelledby="run-sheet-title" aria-describedby="run-sheet-body">
      <div className="run-sheet__body">
        <strong id="run-sheet-title">{consequence.title}</strong>
        <p id="run-sheet-body">{consequence.body}</p>
      </div>
      <div className="run-sheet__actions">
        <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={cancel}>取消</button>
        <button type="button" className={`run-sheet__confirm is-${consequence.tone}`} disabled={busy} onClick={confirm}>
          {busy ? '处理中…' : consequence.confirmLabel}
        </button>
      </div>
    </section>
  )
}
