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
 * 解散与结束这类不可逆动作的确认按钮走红色。
 */
export function ConfirmSheet({ consequence, busy, onCancel, onConfirm }: ConfirmSheetProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
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
        <button ref={cancelRef} className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className={`run-sheet__confirm is-${consequence.tone}`} disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : consequence.confirmLabel}
        </button>
      </div>
    </section>
  )
}
