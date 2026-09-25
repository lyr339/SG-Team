import { useEffect, useRef, useState, type RefObject } from 'react'

interface SelectedText { text: string; x: number; y: number }

/** 只响应会话正文里的真实文本选择；鼠标拖动中不追逐光标，松开后再落位。 */
export function TimelineSelectionActions({ viewportRef, onQuote, onError }: {
  viewportRef: RefObject<HTMLDivElement | null>
  onQuote: (text: string) => void
  onError: (message: string) => void
}): React.JSX.Element | null {
  const [selected, setSelected] = useState<SelectedText>()
  const [feedback, setFeedback] = useState('')
  const feedbackTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const viewport = viewportRef.current
    const wrap = viewport?.parentElement
    if (!viewport || !wrap) return
    const dismiss = (): void => { setSelected(undefined); setFeedback('') }
    const capture = (event: Event): void => {
      if (event.type === 'pointerup' && (event as PointerEvent).button !== 0) return
      if (event.type === 'keyup' && (event as KeyboardEvent).key === 'Escape') { dismiss(); return }
      const selection = window.getSelection()
      const content = viewport.querySelector('.workspace-timeline__content')
      if (!selection || selection.isCollapsed || !content?.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
        dismiss()
        return
      }
      const text = selection.toString().trim()
      if (!text) { dismiss(); return }
      const range = selection.getRangeAt(0).getBoundingClientRect()
      const frame = wrap.getBoundingClientRect()
      if (!range.width && !range.height) { dismiss(); return }
      const x = Math.min(Math.max(range.left + range.width / 2 - frame.left, 80), Math.max(80, frame.width - 80))
      const above = range.top - frame.top - 42
      const y = Math.min(Math.max(8, above >= 8 ? above : range.bottom - frame.top + 8), Math.max(8, frame.height - 38))
      setFeedback('')
      setSelected({ text, x, y })
    }
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      const content = viewport.querySelector('.workspace-timeline__content')
      if (!selection || selection.isCollapsed || !content?.contains(selection.anchorNode) || !content.contains(selection.focusNode)) dismiss()
    }
    viewport.addEventListener('pointerup', capture)
    viewport.addEventListener('keyup', capture)
    viewport.addEventListener('scroll', dismiss, { passive: true })
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      viewport.removeEventListener('pointerup', capture)
      viewport.removeEventListener('keyup', capture)
      viewport.removeEventListener('scroll', dismiss)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
    }
  }, [viewportRef])

  if (!selected) return null
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(selected.text)
      setFeedback('已复制')
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
      feedbackTimer.current = window.setTimeout(() => setFeedback(''), 1_200)
    } catch {
      onError('复制失败：系统剪贴板不可用')
      setFeedback('复制失败')
    }
  }
  const quote = (): void => {
    onQuote(selected.text)
    window.getSelection()?.removeAllRanges()
    setSelected(undefined)
    window.requestAnimationFrame(() => {
      viewportRef.current?.closest('.workspace-main')?.querySelector<HTMLTextAreaElement>('.workspace-composer textarea')?.focus()
    })
  }
  return (
    <div className="timeline-selection-actions" role="toolbar" aria-label="选中文字操作"
      style={{ left: selected.x, top: selected.y }} onPointerDown={(event) => event.preventDefault()}>
      {feedback ? <span role="status" aria-live="polite" className={feedback === '复制失败' ? 'is-error' : undefined}>{feedback}</span> : null}
      <button type="button" onClick={() => void copy()} title="复制选中文字">复制</button>
      <button type="button" onClick={quote} title="引用选中文字到输入框">引用</button>
    </div>
  )
}
