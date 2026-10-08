import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon } from '../UiIcons'

export interface MenuSelectOption { value: string; label: string; tone?: string }
export interface MenuSelectProps {
  value: string
  options: MenuSelectOption[]
  placeholder?: string
  disabled?: boolean
  busy?: boolean
  ariaLabel?: string
  menuMinWidth?: number
  className?: string
  onChange: (value: string) => void
}
/** Shared, theme-owned selection. Portal escapes clipped panels while retaining
 * the owning overlay, keyboard context and exact value semantics. */
export function MenuSelect({ value, options, placeholder = '请选择…', disabled, busy, ariaLabel, menuMinWidth = 0, className = '', onChange }: MenuSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()
  const [highlighted, setHighlighted] = useState(0)
  const [owner, setOwner] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null), buttonRef = useRef<HTMLButtonElement>(null), menuRef = useRef<HTMLUListElement>(null)
  const menuId = useId()
  const search = useRef({ text: '', at: 0 })
  const selected = options.find(option => option.value === value)
  const menuOpen = open && !disabled && !busy
  useEffect(() => { if (disabled || busy) setOpen(false) }, [disabled, busy])
  const positionMenu = useCallback((): void => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect(), gap = 6, padding = 10
    const width = Math.min(Math.max(rect.width, menuMinWidth), Math.max(0, window.innerWidth - padding * 2))
    const left = Math.min(Math.max(padding, rect.left), Math.max(padding, window.innerWidth - padding - width))
    const below = window.innerHeight - rect.bottom - gap - padding, above = rect.top - gap - padding
    const placeAbove = below < 150 && above > below
    setMenuStyle({ position: 'fixed', left, top: placeAbove ? undefined : rect.bottom + gap, bottom: placeAbove ? window.innerHeight - rect.top + gap : undefined,
      width, maxHeight: Math.max(40, Math.min(224, placeAbove ? above : below)) })
    setOwner(rootRef.current?.closest<HTMLElement>('[data-overlay-scope]')?.dataset.overlayScope)
  }, [menuMinWidth])
  const openMenu = (last = false): void => {
    if (disabled || busy) return
    search.current = { text: '', at: 0 }
    positionMenu(); setHighlighted(Math.max(0, options.findIndex(option => option.value === value) >= 0 ? options.findIndex(option => option.value === value) : last ? options.length - 1 : 0)); setOpen(true)
  }
  const closeMenu = (restore = true): void => { setOpen(false); if (restore) buttonRef.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!menuOpen) return
    const option = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[Math.min(highlighted, Math.max(0, options.length - 1))]
    option?.focus({ preventScroll: true }); option?.scrollIntoView?.({ block: 'nearest' })
  }, [menuOpen, highlighted, options.length])
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: Event): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Capture before the parent overlay's document listener. One Esc closes
      // one layer; never close the center and the menu in the same keystroke.
      event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', positionMenu); document.addEventListener('scroll', positionMenu, true)
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', positionMenu); document.removeEventListener('scroll', positionMenu, true)
    }
  }, [menuOpen, positionMenu])
  return <div className={`menu-select ${className}${menuOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${selected?.tone ? ` ${selected.tone}` : ''}`} ref={rootRef}>
    <button ref={buttonRef} type="button" className="menu-select__button" disabled={disabled} aria-disabled={disabled || busy || undefined} aria-busy={busy || undefined} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
      onClick={() => { if (!busy) { if (menuOpen) closeMenu(false); else openMenu() } }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(event.key === 'ArrowUp') }
      }}>
      <span className="menu-select__value">{selected ? <>{selected.tone ? <i className="menu-select__swatch" aria-hidden="true" /> : null}{selected.label}</> : <em>{placeholder}</em>}</span><ChevronDownIcon className="menu-select__chevron" />
    </button>
    {menuOpen && menuStyle ? createPortal(<ul className="menu-select__menu is-portal" id={menuId} role="listbox" aria-label={ariaLabel ?? '可选项'} data-overlay-owner={owner} ref={menuRef} style={menuStyle}
      onKeyDown={event => {
        const count = options.length
        const next = event.key === 'ArrowDown' ? (highlighted + 1) % Math.max(1, count) : event.key === 'ArrowUp' ? (highlighted - 1 + count) % Math.max(1, count) : event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, count - 1) : undefined
        if (next !== undefined) { event.preventDefault(); setHighlighted(next) }
        if (event.key === 'Tab') closeMenu()
        if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) {
          const now = Date.now(), before = now - search.current.at < 700 ? search.current.text : ''
          const text = (before + event.key).toLocaleLowerCase()
          search.current = { text, at: now }
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text))
          if (index >= 0) { event.preventDefault(); setHighlighted(index) }
        }
      }}>
      {options.map((option, index) => <li key={option.value} role="none"><button type="button" role="option" aria-selected={option.value === value} tabIndex={index === highlighted ? 0 : -1} title={option.label}
        className={`${option.value === value ? 'is-selected' : ''}${option.tone ? ` ${option.tone}` : ''}`} onPointerMove={() => setHighlighted(index)} onClick={() => { closeMenu(); onChange(option.value) }}>
        <span>{option.tone ? <i className="menu-select__swatch" aria-hidden="true" /> : null}{option.label}</span>{option.value === value ? <i className="menu-select__check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6" /></svg></i> : null}
      </button></li>)}
      {!options.length ? <li className="menu-select__empty">暂无可选项</li> : null}
    </ul>, document.body) : null}
  </div>
}
