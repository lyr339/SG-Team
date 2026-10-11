import { FeedbackText } from './feedback/FeedbackText'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageAttachment } from '../../domain/conversation-entry'
import type { SgDesktopApi } from '../../shared/desktop-api'
import { formatFileSize } from '../../shared/format-file-size'
import { resolveMessageImageSource } from '../../shared/local-image'

/**
 * 图片附件的查看与操作（输入区芯片与时间线共用）：
 * - 点击缩略图 → 大图查看（Esc / 点击遮罩关闭）；
 * - 右键 → 上下文菜单：查看大图 / 复制图片 / 另存为… /（已落盘的）在文件夹中显示 /（输入区的）移除；
 * - 复制与另存经主进程 IPC（Electron clipboard / 保存对话框），渲染层只传 data URL。
 */

type Desktop = Pick<SgDesktopApi, 'copyImageToClipboard' | 'saveImageAs' | 'revealPathInFolder'>

/** 静态渲染 / 测试环境没有 preload 注入的 API：操作按钮退化为提示，不抛错。 */
function desktopApi(): Desktop | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { sgDesktop?: SgDesktopApi }).sgDesktop
}

function imageSource(attachment: MessageAttachment): string | undefined {
  if (attachment.previewUrl) return attachment.previewUrl
  if (attachment.data && attachment.mimeType.startsWith('image/')) return `data:${attachment.mimeType};base64,${attachment.data}`
  return undefined
}

/**
 * 复制/另存的入参：附件带 base64 时传 data URL；正文引用的本地图片（previewUrl 是
 * sg-image 协议）传路径，由主进程按同一套白名单读盘。
 */
function imagePayload(attachment: MessageAttachment): { dataUrl: string } | { path: string } | undefined {
  const source = imageSource(attachment)
  if (source?.startsWith('data:')) return { dataUrl: source }
  if (attachment.path) return { path: attachment.path }
  return undefined
}

export interface AttachmentActionState {
  /** 最近一次操作的短暂反馈文案（1.6s 后清空）。 */
  feedback: string
  copy(): Promise<void>
  save(): Promise<void>
  reveal(): Promise<void>
  canReveal: boolean
}

export function useAttachmentActions(attachment: MessageAttachment): AttachmentActionState {
  const [feedback, setFeedback] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const identity = useMemo(() => ({}), [attachment.id, attachment.path, attachment.previewUrl, attachment.data, attachment.mimeType, attachment.name])
  const current = useRef<object | undefined>(identity)
  useLayoutEffect(() => {
    current.current = identity
    setFeedback('')
    return () => {
      current.current = undefined
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [identity])
  const flash = (text: string): void => {
    if (current.current !== identity) return
    setFeedback(text)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFeedback(''), 1_600)
  }
  const payload = imagePayload(attachment)
  return {
    feedback,
    canReveal: Boolean(attachment.path),
    copy: async () => {
      const api = desktopApi()
      if (!api || !payload) { flash('无法复制'); return }
      try {
        flash(await api.copyImageToClipboard(payload) ? '已复制到剪贴板' : '复制失败')
      } catch (error) {
        flash(error instanceof Error ? error.message : '复制失败')
      }
    },
    save: async () => {
      const api = desktopApi()
      if (!api || !payload) { flash('无法保存'); return }
      try {
        const saved = await api.saveImageAs({ ...payload, name: attachment.name })
        flash(saved ? '已保存' : '')
      } catch (error) {
        flash(error instanceof Error ? error.message : '保存失败')
      }
    },
    reveal: async () => {
      const api = desktopApi()
      if (!api || !attachment.path) return
      try {
        if (!(await api.revealPathInFolder({ path: attachment.path }))) flash('文件不在拾光附件目录内')
      } catch (error) {
        flash(error instanceof Error ? error.message : '无法显示')
      }
    }
  }
}

interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

function AttachmentContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    })
  }, [x, y])
  useLayoutEffect(() => {
    const opener = document.activeElement, element = ref.current
    element?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected
        && (document.activeElement === document.body || element?.contains(document.activeElement))) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node | null)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    const onScroll = (event: Event): void => { if (!ref.current?.contains(event.target as Node | null)) onClose() }
    const onFocus = (event: FocusEvent): void => { if (!ref.current?.contains(event.target as Node | null)) onClose() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('focusin', onFocus)
    }
  }, [onClose])
  return (
    <div ref={ref} className="attachment-menu" role="menu" aria-label="图片操作" style={{ left: position.left, top: position.top }}
      onKeyDown={event => {
        event.stopPropagation()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
          : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined
        if (next !== undefined) { event.preventDefault(); buttons[next]?.focus() }
      }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'is-danger' : ''}
          onClick={() => { onClose(); item.onSelect() }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function AttachmentLightbox({
  attachment,
  actions,
  onClose
}: {
  attachment: MessageAttachment
  actions: AttachmentActionState
  onClose: () => void
}): React.JSX.Element | null {
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  const dialog = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const opener = document.activeElement, element = dialog.current
    element?.querySelector<HTMLButtonElement>('.is-primary')?.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected
        && (document.activeElement === document.body || element?.contains(document.activeElement))) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const source = imageSource(attachment)
  if (!source) return null
  const meta = [
    attachment.size > 0 ? formatFileSize(attachment.size) : '',
    dimensions ? `${dimensions.width} × ${dimensions.height}` : '',
    attachment.mimeType,
    attachment.path && !attachment.data && !source.startsWith('data:') ? attachment.path : ''
  ].filter(Boolean).join(' · ')
  return (
    <div
      ref={dialog}
      className="attachment-lightbox"
      role="dialog"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key !== 'Tab') return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus()
        }
      }}
      aria-modal="true"
      aria-label={`查看图片 ${attachment.name}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <figure>
        <img
          src={source}
          alt={attachment.name}
          draggable={false}
          onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
        <figcaption>
          <div className="attachment-lightbox__meta">
            <strong title={attachment.name}>{attachment.name}</strong>
            <span>{meta}</span>
          </div>
          <div className="attachment-lightbox__actions">
            {actions.feedback ? <FeedbackText className="attachment-lightbox__feedback" role="status" tone={actions.feedback === '已保存' || actions.feedback === '已复制到剪贴板' ? 'success' : 'error'}>{actions.feedback}</FeedbackText> : null}
            <button type="button" onClick={() => void actions.copy()}>复制图片</button>
            <button type="button" onClick={() => void actions.save()}>另存为…</button>
            {actions.canReveal ? <button type="button" onClick={() => void actions.reveal()}>在文件夹中显示</button> : null}
            <button type="button" className="is-primary" onClick={onClose}>关闭</button>
          </div>
        </figcaption>
      </figure>
    </div>
  )
}

export function AttachmentThumbnail({
  attachment,
  className,
  onRemove
}: {
  attachment: MessageAttachment
  className?: string
  /** 输入区芯片：菜单里多一项「移除」。 */
  onRemove?: () => void
}): React.JSX.Element | null {
  const [viewerOpen, setViewerOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const actions = useAttachmentActions(attachment)
  const source = imageSource(attachment)
  if (!source) return null
  const items: MenuItem[] = [
    { label: '查看大图', onSelect: () => setViewerOpen(true) },
    { label: '复制图片', onSelect: () => void actions.copy() },
    { label: '另存为…', onSelect: () => void actions.save() },
    ...(actions.canReveal ? [{ label: '在文件夹中显示', onSelect: () => void actions.reveal() }] : []),
    ...(onRemove ? [{ label: '移除附件', onSelect: onRemove, danger: true }] : [])
  ]
  return (
    <>
      <button
        type="button"
        className={`attachment-thumb ${className ?? ''}`}
        title={`${attachment.name} · ${actions.feedback || '点击查看大图，右键更多操作'}`}
        onClick={() => setViewerOpen(true)}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.focus({ preventScroll: true })
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <img src={source} alt={attachment.name} draggable={false} loading="lazy" />
        {actions.feedback && !viewerOpen ? <span className="attachment-thumb__feedback" role="status">{actions.feedback}</span> : null}
      </button>
      {menu ? <AttachmentContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(undefined)} /> : null}
      {viewerOpen ? <AttachmentLightbox attachment={attachment} actions={actions} onClose={() => setViewerOpen(false)} /> : null}
    </>
  )
}

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

/**
 * Markdown 正文里的图片 `![说明](目标)`：
 * - 本地绝对路径 / file:// / data: → 经 sg-image 协议渲染，可点击查看、右键复制/另存/在文件夹中显示；
 * - http(s) → 只给外链（会话页不加载远程资源）；
 * - 无法识别的目标 → 原样文本，不留破图。
 */
export function MessageImage({ alt, target }: { alt: string; target: string }): React.JSX.Element {
  const source = useMemo(() => resolveMessageImageSource(target), [target])
  const attachment = useMemo<MessageAttachment | undefined>(() => {
    if (!source || source.kind === 'remote') return undefined
    return {
      id: `message-image:${target}`,
      name: alt.trim() || (source.kind === 'local' ? fileNameOf(source.path) : 'image'),
      mimeType: source.mimeType,
      size: 0,
      previewUrl: source.src,
      ...(source.kind === 'local' ? { path: source.path } : {})
    }
  }, [alt, source, target])
  if (!source) return <span className="message-image message-image--raw">![{alt}]({target})</span>
  if (source.kind === 'remote') {
    return <a className="message-image message-image--link" href={source.href} target="_blank" rel="noreferrer noopener">{alt.trim() || source.href}</a>
  }
  return (
    <span className="message-image">
      <AttachmentThumbnail attachment={attachment!} className="message-image__thumb" />
      {alt.trim() ? <small className="message-image__caption">{alt.trim()}</small> : null}
    </span>
  )
}
