import { useEffect, useRef, useState } from 'react'

export interface NumberStepperFieldProps {
  value: number
  min: number
  max: number
  step: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
  /** 无可见文本时的屏幕阅读器语义标签。 */
  label?: string
}

const LONG_PRESS_DELAY_MS = 400
const LONG_PRESS_INTERVAL_MS = 80

/** 把任意数值钳制到 [min, max] 并对齐步进网格（整数运算消除 0.5 步进的浮点毛刺）。 */
function clampToStep(value: number, min: number, max: number, step: number): number {
  const units = Math.round(value / step)
  const clampedUnits = Math.min(Math.round(max / step), Math.max(Math.round(min / step), units))
  return Number((clampedUnits * step).toPrecision(12))
}

/** 显示格式：去掉无意义的尾零（10.5 → "10.5"，10 → "10"）。 */
function formatValue(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * 数值步进输入：− / + 按钮（长按连续步进）+ 可直接编辑的数字框。
 * 替代滑杆：秒级倒计时这类「知道确切数值」的场景，敲数字比拖滑杆更快更准。
 * 编辑态与展示态分离：聚焦时进入草稿（允许 "1." 之类的中间输入），
 * Enter / 失焦提交（解析 → 钳制 → 对齐步进），Escape 还原；↑ / ↓ 直接步进。
 */
export function NumberStepperField({ value, min, max, step, unit, disabled, onChange, label }: NumberStepperFieldProps): React.JSX.Element {
  // draft 为 null 时是非编辑展示态；聚焦后才进入草稿态，避免输入中间态被父级值覆盖。
  const [draft, setDraft] = useState<string | null>(null)
  const valueRef = useRef(value)
  const repeatRef = useRef<{ timeout?: number; interval?: number }>({})

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const stopRepeat = (): void => {
    window.clearTimeout(repeatRef.current.timeout)
    window.clearInterval(repeatRef.current.interval)
    repeatRef.current = {}
  }
  // 卸载时停掉长按定时器，避免组件销毁后还在回调。
  useEffect(() => stopRepeat, [])

  const stepOnce = (direction: 1 | -1): void => {
    if (disabled) return
    const next = clampToStep(valueRef.current + direction * step, min, max, step)
    if (next !== valueRef.current) onChange(next)
  }

  const startRepeat = (direction: 1 | -1): void => {
    if (disabled) return
    stopRepeat()
    stepOnce(direction)
    repeatRef.current.timeout = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(() => stepOnce(direction), LONG_PRESS_INTERVAL_MS)
    }, LONG_PRESS_DELAY_MS)
  }

  const commitDraft = (): void => {
    if (draft === null) return
    const parsed = Number(draft.trim())
    if (draft.trim() && Number.isFinite(parsed)) {
      const next = clampToStep(parsed, min, max, step)
      if (next !== value) onChange(next)
    }
    setDraft(null)
  }

  // 边界判定两侧都过 clampToStep（对齐 + toPrecision 去浮点毛刺），step 非 2 的幂次分之一时也稳。
  const alignedValue = clampToStep(value, min, max, step)
  const atMin = alignedValue <= clampToStep(min, min, max, step)
  const atMax = alignedValue >= clampToStep(max, min, max, step)

  return (
    <span className={`stepper-field${disabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        className="stepper-field__btn"
        disabled={disabled || atMin}
        aria-label="减少"
        onPointerDown={(event) => { event.preventDefault(); startRepeat(-1) }}
        onPointerUp={stopRepeat}
        onPointerLeave={stopRepeat}
        onPointerCancel={stopRepeat}
        onClick={(event) => {
          // 键盘（Space/Enter）派发的 click 其 detail 为 0；鼠标 click 已由 pointerdown 序列覆盖，跳过防双步进。
          if (event.detail === 0) stepOnce(-1)
        }}
      >
        −
      </button>
      <span className="stepper-field__value">
        <input
          type="text"
          inputMode="decimal"
          role="spinbutton"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          {...(label ? { 'aria-label': label } : {})}
          value={draft ?? formatValue(value)}
          disabled={disabled}
          onFocus={(event) => {
            setDraft(formatValue(value))
            event.target.select()
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitDraft()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              // 只还原草稿、保持焦点（原生输入的 Escape 语义）：若同时 blur，
              // onBlur 的提交会读到尚未更新的草稿态，把要取消的值又提交出去。
              setDraft(null)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setDraft(null)
              stepOnce(1)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setDraft(null)
              stepOnce(-1)
            }
          }}
        />
        {unit ? <i>{unit}</i> : null}
      </span>
      <button
        type="button"
        className="stepper-field__btn"
        disabled={disabled || atMax}
        aria-label="增加"
        onPointerDown={(event) => { event.preventDefault(); startRepeat(1) }}
        onPointerUp={stopRepeat}
        onPointerLeave={stopRepeat}
        onPointerCancel={stopRepeat}
        onClick={(event) => {
          if (event.detail === 0) stepOnce(1)
        }}
      >
        +
      </button>
    </span>
  )
}
