import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export interface MenuSelectOption {
  value: string
  label: string
  tone?: string
}

export interface MenuSelectProps {
  value: string
  options: MenuSelectOption[]
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  /** 弹层最小宽度；触发器可保持紧凑，菜单按内容场景独立展开。 */
  menuMinWidth?: number
  onChange: (value: string) => void
}

/**
 * 账号管线的下拉选择：自绘按钮 + 弹出列表（点击外部 / Esc 关闭），
 * 视觉与卡片设计体系一致，替代原生 select 的系统样式。
 */
export function MenuSelect({ value, options, placeholder = '请选择…', disabled, ariaLabel, menuMinWidth = 0, onChange }: MenuSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const menuId = useId()
  const selected = options.find((option) => option.value === value)

  const positionMenu = useCallback((): void => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const gap = 6
    const viewportPadding = 10
    const width = Math.min(Math.max(rect.width, menuMinWidth), Math.max(0, window.innerWidth - viewportPadding * 2))
    const left = Math.min(Math.max(viewportPadding, rect.left), Math.max(viewportPadding, window.innerWidth - viewportPadding - width))
    const below = window.innerHeight - rect.bottom - gap - viewportPadding
    const above = rect.top - gap - viewportPadding
    const placeAbove = below < 150 && above > below
    const maxHeight = Math.max(96, Math.min(224, placeAbove ? above : below))
    setMenuStyle({
      position: 'fixed',
      left,
      top: placeAbove ? undefined : rect.bottom + gap,
      bottom: placeAbove ? window.innerHeight - rect.top + gap : undefined,
      width,
      maxHeight
    })
  }, [menuMinWidth])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Esc 只收掉最上层的面：菜单开着时不该同时清掉名册多选、关掉身后的抽屉或确认面。
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', positionMenu)
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, positionMenu])

  return (
    <div className={`menu-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${selected?.tone ? ` ${selected.tone}` : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="menu-select__button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) positionMenu()
          setOpen((current) => !current)
        }}
      >
        <span className="menu-select__value">{selected ? <><i className="menu-select__swatch" aria-hidden="true" />{selected.label}</> : <em>{placeholder}</em>}</span>
        <i className="menu-select__chevron" aria-hidden="true" />
      </button>
      {open && menuStyle ? createPortal(
        <ul className="menu-select__menu is-portal" id={menuId} role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                title={option.label}
                className={`${option.value === value ? 'is-selected' : ''}${option.tone ? ` ${option.tone}` : ''}`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span><i className="menu-select__swatch" aria-hidden="true" />{option.label}</span>
                {option.value === value ? (
                  <i className="menu-select__check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6" /></svg></i>
                ) : null}
              </button>
            </li>
          ))}
          {!options.length ? <li className="menu-select__empty">暂无可选项</li> : null}
        </ul>,
        document.body
      ) : null}
    </div>
  )
}
