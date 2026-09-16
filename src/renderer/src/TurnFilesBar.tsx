import { memo, useId, useState } from 'react'
import type { TurnFileView, TurnFilesView } from './turn-files-view'

interface TurnFilesBarProps {
  view: TurnFilesView
  /** 打开右栏审查页（范围切到「本轮」）；带 path 时同时定位该文件。缺省时行不可点、没有「审查」入口。 */
  onReview?: (path?: string) => void
}

export const TURN_FILES_COLLAPSED_KEY = 'sg-team.workspace:turn-files-collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(TURN_FILES_COLLAPSED_KEY) === '1' } catch { return false }
}

function storeCollapsed(value: boolean): void {
  try { localStorage.setItem(TURN_FILES_COLLAPSED_KEY, value ? '1' : '0') } catch { /* 当前窗口仍然生效。 */ }
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  )
}

const STATUS_TITLES: Record<NonNullable<TurnFileView['status']>, string> = {
  modified: '已修改',
  added: '新增',
  deleted: '已删除',
  renamed: '已重命名',
  untracked: '未跟踪',
  conflicted: '有冲突'
}

function fileTitle(file: TurnFileView): string {
  const counts = file.binary ? '二进制' : `+${file.additions} −${file.deletions}`
  const basis = file.source === 'git'
    ? `${file.status ? `${STATUS_TITLES[file.status]} · ` : ''}${counts}（工作树相对 HEAD 的未提交变更）`
    : `${counts}（按本轮编辑逐次累计的估算；Git 摘要就绪后换成文件级净变化）`
  return `${file.path}\n${basis}`
}

/**
 * 本轮文件栏：贴在输入区上方，列出本轮 Agent 改动过的文件与增删行数（Cursor 原生输入框上方
 * “N Files” 栏的拾光版）。数据来自右栏审查页已经在算的「本轮」范围——这里只是把它搬到视线的必经之路上。
 *
 * - 空集合不渲染；下一条用户消息被取走即为新回合，栏自然清零。
 * - 行以路径为 key：新文件只追加节点、数字变化只改文本，整块内容不重建。
 * - 折叠状态持久化；列表常驻挂载，收起走 grid-rows 过渡并 inert。
 * - 右端只有「审查」：中止 Cursor 回合不是拾光的能力（观察 + 自动化，不做控制依赖）。
 */
export const TurnFilesBar = memo(function TurnFilesBar({ view, onReview }: TurnFilesBarProps): React.JSX.Element | null {
  const listId = useId()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  if (!view.files.length) return null
  const open = !collapsed
  const toggle = (): void => {
    setCollapsed((value) => {
      storeCollapsed(!value)
      return !value
    })
  }
  return (
    <section
      className={`turn-files ${open ? 'is-open' : 'is-collapsed'}${view.working ? ' is-working' : ''}${view.estimated ? ' is-estimated' : ''}`}
      aria-label="本轮改动的文件"
      data-file-count={view.files.length}
    >
      <div className="turn-files__head">
        <button
          type="button"
          className="turn-files__toggle"
          aria-expanded={open}
          aria-controls={listId}
          title={open ? '收起文件列表' : '展开文件列表'}
          onClick={toggle}
        >
          <span className="turn-files__chevron"><ChevronIcon /></span>
          <strong className="turn-files__title"><b>{view.files.length}</b> 个文件</strong>
          <span
            className="turn-files__totals"
            title={view.estimated ? '含按编辑逐次累计的估算值' : '本轮文件的增删行数合计（工作树相对 HEAD）'}
            aria-label={`新增 ${view.additions} 行，删除 ${view.deletions} 行${view.estimated ? '（估算）' : ''}`}
          >
            {view.estimated ? <small aria-hidden="true">≈</small> : null}
            <b>+{view.additions}</b><em>−{view.deletions}</em>
          </span>
        </button>
        <div className="turn-files__aside">
          {view.working ? <i className="turn-files__spinner" role="img" aria-label="Agent 正在处理本轮消息" title="Agent 正在处理本轮消息，列表可能继续变化" /> : null}
          {onReview ? (
            <button type="button" className="turn-files__review" title="在右栏审查本轮改动（范围：本轮）" onClick={() => onReview()}>审查</button>
          ) : null}
        </div>
      </div>
      {/* 列表常驻挂载，收起走 grid-rows 高度过渡；收起后 inert 挡掉焦点与读屏。 */}
      <div id={listId} className="turn-files__listwrap" inert={!open}>
        <ul className="turn-files__list">
          {view.files.map((file) => (
            <li key={file.path} className={`turn-files__item${file.status ? ` is-${file.status}` : ''}${file.source === 'process' ? ' is-estimated' : ''}`} data-path={file.path}>
              <button
                type="button"
                className="turn-files__row"
                title={onReview ? `${fileTitle(file)}\n点击在右栏查看差异` : fileTitle(file)}
                disabled={!onReview}
                onClick={onReview ? () => onReview(file.path) : undefined}
              >
                <i className="turn-files__badge" aria-hidden="true">{file.badge}</i>
                <span className="turn-files__name">
                  <strong><span>{file.stem}</span>{file.ext ? <b>{file.ext}</b> : null}</strong>
                  {file.dir ? <small><bdi>{file.dir}</bdi></small> : null}
                </span>
                {file.status === 'deleted' ? <em className="turn-files__status" title="已删除">D</em> : null}
                {file.status === 'added' || file.status === 'untracked' ? <em className="turn-files__status" title={STATUS_TITLES[file.status]}>A</em> : null}
                <span className="turn-files__counts" aria-label={file.binary ? '二进制文件' : `新增 ${file.additions} 行，删除 ${file.deletions} 行`}>
                  {file.binary ? <small>BIN</small> : <><b>+{file.additions}</b><em>−{file.deletions}</em></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
})
