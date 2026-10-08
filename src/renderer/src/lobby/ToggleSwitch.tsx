import { useEffect, useId, useRef, useState } from 'react'

export interface ToggleSwitchProps {
  checked: boolean
  disabled?: boolean
  /** Transient operation lock: keep focus and visual contrast, unlike an unavailable feature. */
  busy?: boolean
  /** Operational capabilities (e.g. patch installation) must remain confirmed-only. */
  optimistic?: boolean
  onChange: (checked: boolean) => void | Promise<unknown>
  /** 开关旁的可见说明文本。 */
  children?: React.ReactNode
  /** 无可见文本时的屏幕阅读器语义标签。 */
  label?: string
  title?: string
}

/**
 * 账号管线的开关控件：原生 checkbox 视觉隐藏 + 自绘轨道/滑块
 * （保留原生 input 的键盘可达性与测试可断言性，不引外部组件库）。
 */
export function ToggleSwitch({ checked, disabled, busy, optimistic = true, onChange, children, label, title }: ToggleSwitchProps): React.JSX.Element {
  const id = useId()
  const [pending, setPending] = useState<boolean>(), [error, setError] = useState(false)
  const inFlight = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const waiting = busy || pending !== undefined
  const change = (next: boolean): void => {
    if (disabled || busy || inFlight.current) return
    setError(false)
    try {
      const result = onChange(next)
      if (!result || typeof result.then !== 'function') return // Local draft controls remain synchronous.
      inFlight.current = true; setPending(next)
      void Promise.resolve(result).catch(() => { if (alive.current) setError(true) }).finally(() => {
        inFlight.current = false; if (alive.current) setPending(undefined)
      })
    } catch { setError(true) }
  }
  return (
    <label className={`toggle-switch${disabled ? ' is-disabled' : ''}${waiting ? ' is-saving' : ''}`} htmlFor={id} title={error ? '设置未保存，请重试。' : title}>
      <input
        id={id}
        type="checkbox"
        checked={optimistic ? pending ?? checked : checked}
        disabled={disabled}
        aria-busy={waiting || undefined}
        aria-disabled={disabled || waiting || undefined}
        {...(children ? {} : { 'aria-label': label })}
        onChange={(event) => change(event.target.checked)}
      />
      <span className="toggle-switch__track" aria-hidden="true"><i className="toggle-switch__thumb" /></span>
      {children ? <span className="toggle-switch__text">{children}</span> : null}
      {error ? <span className="toggle-switch__error" role="alert">设置未保存，请重试。</span> : null}
    </label>
  )
}
