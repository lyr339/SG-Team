import { memo, useEffect, useId, useState } from 'react'
import type { ReviewFocusRequest } from './inspector/review-focus-bus'
import type { TurnFileView, TurnFilesView } from './turn-files-view'

interface TurnFilesBarProps {
  view: TurnFilesView
  /**
   * 打开右栏审查页；带 path 时同时定位该文件。范围由栏自己决定：本轮 → 「本轮」，
   * 上一轮保持态 → 「未提交」（右栏的「本轮」那时是空的）。缺省时行不可点、没有「审查」入口。
   */
  onReview?: (request: ReviewFocusRequest) => void
  /**
   * 让位给待投递托盘：托盘在场时栏默认只留 36px 头（计数、合计、审查都在头上），可手动展开；
   * 托盘走了恢复用户自己的折叠偏好。托盘可操作且短暂，文件栏是信息且有右栏兜底。
   * 同时不再转圈——托盘头已经在说「Agent 正在处理」。
   */
  yieldToTray?: boolean
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
 * - 空集合不渲染；新回合第一次编辑替换列表；新回合尚无编辑时保住上一轮并标「上一轮」（见 turn-files-view）。
 * - 行以路径为 key：新文件只追加节点、数字变化只改文本，整块内容不重建。
 * - 折叠状态持久化；托盘在场时让位（默认收起、可手动展开，不写入偏好）；列表常驻挂载，收起走 grid-rows 过渡并 inert。
 * - 右端只有「审查」：中止 Cursor 回合不是拾光的能力（观察 + 自动化，不做控制依赖）。
 */
export const TurnFilesBar = memo(function TurnFilesBar({ view, onReview, yieldToTray = false }: TurnFilesBarProps): React.JSX.Element | null {
  const listId = useId()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // 让位期间的手动展开是一次性的：托盘走了就清掉，下次托盘再来仍先让位。
  const [expandedWhileYielding, setExpandedWhileYielding] = useState(false)
  useEffect(() => {
    if (!yieldToTray) setExpandedWhileYielding(false)
  }, [yieldToTray])
  if (!view.files.length) return null
  const open = yieldToTray ? expandedWhileYielding : !collapsed
  const toggle = (): void => {
    if (yieldToTray) {
      setExpandedWhileYielding((value) => !value)
      return
    }
    setCollapsed((value) => {
      storeCollapsed(!value)
      return !value
    })
  }
  const previous = view.scope === 'previous'
  const reviewScope = previous ? 'uncommitted' : 'turn'
  const spinning = view.working && !yieldToTray
  return (
    <section
      className={`turn-files ${open ? 'is-open' : 'is-collapsed'}${spinning ? ' is-working' : ''}${view.estimated ? ' is-estimated' : ''}${previous ? ' is-previous' : ''}${yieldToTray ? ' is-yielding' : ''}`}
      aria-label={previous ? '上一轮改动的文件' : '本轮改动的文件'}
      data-file-count={view.files.length}
      data-scope={view.scope}
    >
      <div className="turn-files__head">
        <button
          type="button"
          className="turn-files__toggle"
          aria-expanded={open}
          aria-controls={listId}
          title={open ? '收起文件列表' : yieldToTray ? '展开文件列表（有消息待投递时默认收起）' : '展开文件列表'}
          onClick={toggle}
        >
          <span className="turn-files__chevron"><ChevronIcon /></span>
          {previous ? <em className="turn-files__scope" title="新一轮刚开始、还没有编辑：这里保留的是上一轮改动的文件，本轮第一次编辑后替换">上一轮</em> : null}
          <strong className="turn-files__title"><b>{view.files.length}</b> 个文件</strong>
          <span
            className="turn-files__totals"
            title={view.estimated ? '含按编辑逐次累计的估算值' : `${previous ? '上一轮' : '本轮'}文件的增删行数合计（工作树相对 HEAD）`}
            aria-label={`新增 ${view.additions} 行，删除 ${view.deletions} 行${view.estimated ? '（估算）' : ''}`}
          >
            {view.estimated ? <small aria-hidden="true">≈</small> : null}
            <b>+{view.additions}</b><em>−{view.deletions}</em>
          </span>
        </button>
        <div className="turn-files__aside">
          {spinning ? <i className="turn-files__spinner" role="img" aria-label="Agent 正在处理本轮消息" title="Agent 正在处理本轮消息，列表可能继续变化" /> : null}
          {onReview ? (
            <button
              type="button"
              className="turn-files__review"
              title={previous ? '在右栏审查这些改动（范围：未提交）' : '在右栏审查本轮改动（范围：本轮）'}
              onClick={() => onReview({ scope: reviewScope })}
            >
              审查
            </button>
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
                onClick={onReview ? () => onReview({ path: file.path, scope: reviewScope }) : undefined}
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
