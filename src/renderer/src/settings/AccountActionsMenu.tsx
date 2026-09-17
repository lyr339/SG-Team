import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreIcon } from '../UiIcons'

export interface AccountMenuAction {
  key: string
  /** 菜单项文案；进行中由调用方换成「登录中…」这类进度文案。 */
  label: string
  title?: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * 账号卡片的次要操作菜单（⋯）。
 *
 * 存在的理由是布局而不只是收纳：操作行原先按账号状态渲染 4~6 个按钮，
 * 卡片一窄就有的卡换行、有的不换，而卡片等高 + 操作行 margin-top:auto
 * 会把不换行那张的按钮压到卡底，两张卡的按钮一上一下。次要动作收进弹层后，
 * 行内按钮数固定，换行与否不再随账号状态摇摆。
 *
 * 有动作在跑时触发器直接显示进度文案（如「结账中…」）——菜单收起也看得见，
 * 不会点完「升级 Pro」就失去反馈。
 */
export function AccountActionsMenu({ label, busyLabel, actions }: {
  /** 触发器的无障碍名，如「card@x.co 的更多操作」。 */
  label: string
  /** 非空时触发器改显进度文案并禁用（此时菜单内的动作也都在忙）。 */
  busyLabel?: string
  actions: AccountMenuAction[]
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // 先按触发器右下角落位，再在 layout 阶段用实测菜单尺寸夹进视口（不猜菜单高度，也不会闪）。
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current?.getBoundingClientRect()
    const menu = menuRef.current?.getBoundingClientRect()
    if (!trigger || !menu) return
    const gap = 6
    const edge = 8
    const left = Math.max(edge, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - edge))
    const below = trigger.bottom + gap
    const top = below + menu.height + edge <= window.innerHeight ? below : Math.max(edge, trigger.top - gap - menu.height)
    setPosition((current) => (current?.left === left && current?.top === top ? current : { left, top }))
  }, [open])

  // 展开即把焦点送进菜单：否则键盘用户打开后无处可去（Escape 再交还给触发器）。
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

  if (!actions.length) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`account-actions-menu__trigger${open ? ' is-open' : ''}${busyLabel ? ' is-busy' : ''}`}
        disabled={Boolean(busyLabel)}
        aria-label={label}
        title={busyLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          const trigger = triggerRef.current?.getBoundingClientRect()
          if (trigger) setPosition({ left: trigger.right, top: trigger.bottom + 6 })
          setOpen((current) => !current)
        }}
      >
        {busyLabel ?? <MoreIcon className="account-actions-menu__glyph" />}
      </button>
      {open && position ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="account-actions-menu"
          style={{ position: 'fixed', left: position.left, top: position.top }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                setOpen(false)
                action.onSelect()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </>
  )
}
