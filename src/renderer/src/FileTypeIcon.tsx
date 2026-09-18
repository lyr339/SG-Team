import type { FileIconKind } from './file-type'

/**
 * 文件类型图标（16px 单色 SVG）：本轮文件栏里替代文字徽标指认语言，与 Cursor 原生
 * “N Files” 栏同一做法。每一族一个形状、一个识别色（色值在 styles.css 的 --filetype-* 里，
 * 只用于文件身份，不与状态色混用）；名字后面本来就带扩展名，图标只是让眼睛先落到族上。
 */
const OUTLINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function glyph(kind: FileIconKind): React.JSX.Element {
  switch (kind) {
    case 'typescript':
      return <><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" /><text x="8" y="8.4" textAnchor="middle" dominantBaseline="central">TS</text></>
    case 'javascript':
      return <><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" /><text x="8" y="8.4" textAnchor="middle" dominantBaseline="central">JS</text></>
    case 'react':
      return (
        <g {...OUTLINE} strokeWidth="1.1">
          <ellipse cx="8" cy="8" rx="6.6" ry="2.5" />
          <ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(60 8 8)" />
          <ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(120 8 8)" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
        </g>
      )
    case 'json':
      return <path {...OUTLINE} d="M6.3 2.6c-1.5 0-2.1.6-2.1 2v1.5c0 .9-.4 1.5-1.4 1.9 1 .4 1.4 1 1.4 1.9v1.5c0 1.4.6 2 2.1 2M9.7 2.6c1.5 0 2.1.6 2.1 2v1.5c0 .9.4 1.5 1.4 1.9-1 .4-1.4 1-1.4 1.9v1.5c0 1.4-.6 2-2.1 2" />
    case 'styles':
      return <path {...OUTLINE} d="M6.6 2.6 5.1 13.4M10.9 2.6 9.4 13.4M2.9 6.2h10.6M2.5 9.8h10.6" />
    case 'markdown':
      return (
        <g {...OUTLINE} strokeWidth="1.2">
          <rect x="1.2" y="3" width="13.6" height="10" rx="2" />
          <path d="M3.7 10.4V5.6h1.1l1.6 2.2 1.6-2.2h1.1v4.8" />
          <path d="M11.6 5.6v4.6M10.1 8.6l1.5 1.7 1.5-1.7" />
        </g>
      )
    case 'markup':
      return <path {...OUTLINE} strokeWidth="1.4" d="M5.4 4.2 1.9 8l3.5 3.8M10.6 4.2 14.1 8l-3.5 3.8M9.3 2.8 6.7 13.2" />
    case 'image':
      return (
        <g {...OUTLINE}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M2 12.4l3.7-4.1 2.7 2.9 2-2.2 3.6 3.4" />
          <circle cx="10.7" cy="5.9" r="1.2" fill="currentColor" stroke="none" />
        </g>
      )
    case 'shell':
      return (
        <g {...OUTLINE}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M4.2 5.7 6.7 8l-2.5 2.3M8.2 10.4h3.6" />
        </g>
      )
    case 'config':
      return (
        <g {...OUTLINE}>
          <path d="M2.5 4.4h11M2.5 8h11M2.5 11.6h11" />
          <circle cx="10.2" cy="4.4" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="5.6" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="8.8" cy="11.6" r="1.4" fill="currentColor" stroke="none" />
        </g>
      )
    case 'code':
      return (
        <g {...OUTLINE}>
          <path d="M4 1.6h5.4L13 5.2v9.2H4z" />
          <path d="M9.4 1.6v3.6H13" />
          <path d="M6 8.6h4M6 11.1h2.6" />
        </g>
      )
    case 'file':
      return (
        <g {...OUTLINE}>
          <path d="M4 1.6h5.4L13 5.2v9.2H4z" />
          <path d="M9.4 1.6v3.6H13" />
        </g>
      )
  }
}

export function FileTypeIcon({ kind }: { kind: FileIconKind }): React.JSX.Element {
  return (
    <svg className={`file-type-icon is-${kind}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {glyph(kind)}
    </svg>
  )
}
