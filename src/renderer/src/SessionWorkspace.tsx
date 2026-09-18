import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import { conversationTextIdentity, type ConversationEntry, type MessageAttachment, type ProcessBlock } from '../../domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState, NativeProcessStreamStatus } from '../../shared/desktop-api'
import { formatClock, formatFileSize, formatRelativeTime, statusLabel } from './format'
import { ComposerWorkbench } from './ComposerWorkbench'
import { AttachmentThumbnail } from './AttachmentImageViewer'
import { AgentAvatar } from './AgentAvatar'
import { ClampedMessage } from './ClampedMessage'
import { ProcessTurnCard } from './ProcessTurnCard'
import type { QuestionActions } from './QuestionCard'
import { QueuedMessageTray } from './QueuedMessageTray'
import { TurnFilesBar } from './TurnFilesBar'
import type { ReviewFocusRequest } from './inspector/review-focus-bus'
import type { TurnFilesView } from './turn-files-view'
import { TurnResponseText } from './TurnResponseText'
import { SessionUsageStat } from './SessionUsageStat'
import { suggestedActionsFromText } from './process-turn-view'
import { partitionTimelineEntries, projectTurnTimeline, type TurnTimelineItem } from './timeline-view'
import { useBottomFollow } from './use-bottom-follow'
import { revealAfterPaint, subscribeReveal } from './inspector/reveal-bus'

interface SessionWorkspaceProps {
  session: AgentSession
  entries: ConversationEntry[]
  currentProjectName?: string
  onSend: (text: string, attachments?: MessageAttachment[]) => Promise<void>
  onBack: () => void
  onHandoff?: () => void
  /** 交接按钮说明（不可用时解释原因）。 */
  handoffTitle?: string
  /** 席位所在协作组（入组席位才有）：头部组名 chip，点击跳到运行页对应卡片。 */
  group?: { id: string; name: string }
  onOpenGroup?: (groupId: string) => void
  /** 撤回仍在队列中的用户消息（成功返回 true）。 */
  onWithdrawQueued?: (entryId: string) => Promise<boolean>
  /** 解除「等待新会话」保持位。 */
  onReleaseQueued?: (entryId: string) => Promise<boolean>
  draft: string
  onDraftChange: (value: string) => void
  attachments: MessageAttachment[]
  onAttachmentsChange: (attachments: MessageAttachment[]) => void
  /** Cursor 内存模型直接推送的当前回合过程流。 */
  liveProcess?: LiveProcessState
  /** Cursor Composer 原生回复文本（CDP 250ms 增量）。 */
  liveAgentResponse?: LiveAgentResponseState
  nativeProcessStream?: NativeProcessStreamStatus
  /** 过程卡里 ask_question 的回答 / 跳过动作（绑定到本通道）。 */
  questionActions?: QuestionActions
  /** 本轮改动文件栏（贴在输入区上方）；缺省或空集合不渲染。 */
  turnFiles?: TurnFilesView
  /** 文件栏的「审查」：打开右栏审查页并切到请求的范围，带路径时定位到该文件。 */
  onReviewTurnFiles?: (request: ReviewFocusRequest) => void
}

/** 同角色且间隔小于该值的连续消息合并成一组（只显示一次头像与名称）。 */
const GROUP_WINDOW_MS = 5 * 60_000
/** 消息间隔超过该值时插入居中的时间分隔线。 */
const DIVIDER_WINDOW_MS = 10 * 60_000

type TimelineItem = { type: 'turn'; key: string; item: TurnTimelineItem }

/**
 * 历史脏数据兜底（2026-09-03 事故）：旧版封口曾把与回复正文相同的 cursor-msg
 * 固化进 processBlocks，过程卡与正文气泡会渲染同一文本两次。封口防线（§8.4-4）
 * 已阻止新数据产生；此处滤除历史残留的重复 message。
 */
function replyProcessBlocks(entry: ConversationEntry): ProcessBlock[] | undefined {
  const finalIdentity = entry.text.trim() ? conversationTextIdentity(entry.text) : undefined
  if (!entry.processBlocks?.length || !finalIdentity) return entry.processBlocks
  const filtered = entry.processBlocks.filter((block) => (
    !(block.kind === 'message' && conversationTextIdentity(block.text) === finalIdentity)
  ))
  return filtered.length === entry.processBlocks.length ? entry.processBlocks : filtered
}

function renderAttachments(entry: ConversationEntry): React.JSX.Element | null {
  if (!entry.attachments?.length) return null
  return (
    <div className="chat-attachments">
      {entry.attachments.map((attachment) => (
        <div key={attachment.id} className="chat-attachment">
          {attachment.mimeType.startsWith('image/') && attachment.previewUrl ? (
            <AttachmentThumbnail attachment={attachment} className="chat-attachment-image" />
          ) : (
            <div className="chat-attachment-file">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M9 2v3h3" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
              <span>{attachment.name}</span>
              <small>{formatFileSize(attachment.size)}</small>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function entryLabel(entry: ConversationEntry): string {
  if (entry.role === 'user') return entry.source === 'desktop' ? '你' : '用户'
  if (entry.role === 'assistant') return 'Agent'
  if (entry.role === 'error') return '错误'
  return '系统'
}

function dividerLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  if (sameDay) return formatClock(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatClock(timestamp)}`
}

/** 页头副标题只保留一个身份线索；状态由旁边的状态胶囊承担。 */
function workspaceSubtitle(session: AgentSession): string {
  const identity = session.roleTemplateKey === 'solo'
    ? session.roleName
    : session.composerTitle?.trim() || `SG Team · CH-${session.channelId}`
  return session.online ? `${identity} · ${formatRelativeTime(session.lastSeenAt)}` : identity
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.5h-6a2 2 0 0 0-2 2v6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function QuoteIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5V6.8A3.3 3.3 0 0 1 6.3 3.5M3 8.5h3.2v4H3v-4ZM9.5 8.5V6.8a3.3 3.3 0 0 1 3.3-3.3M9.5 8.5h3.2v4H9.5v-4Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  )
}

function RetryIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 6A5.5 5.5 0 1 0 13 10.7M13.2 2.8V6H10" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35"/></svg>
}

function StarIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2"/></svg>
}

function ListenIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.3h2.4L8.2 4v8L5.4 9.7H3zM10.7 5.6a3.2 3.2 0 0 1 0 4.8M12.5 3.8a5.8 5.8 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25"/></svg>
}

export function SessionWorkspace({
  session,
  entries,
  currentProjectName,
  onSend,
  onBack,
  onHandoff,
  handoffTitle,
  group,
  onOpenGroup,
  onWithdrawQueued,
  onReleaseQueued,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
  liveProcess,
  liveAgentResponse,
  nativeProcessStream,
  questionActions,
  turnFiles,
  onReviewTurnFiles
}: SessionWorkspaceProps): React.JSX.Element {
  const [sendError, setSendError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(new Set())
  // draft 的最新值镜像到 ref：时间线的「引用」按钮要读最新草稿，但引用不进
  // timelineContent 的 useMemo 依赖——否则每敲一个键整条时间线都重渲染（打字延迟根因）。
  const draftRef = useRef(draft)
  useLayoutEffect(() => { draftRef.current = draft }, [draft])
  const visibleEntries = useMemo(() => entries.filter((entry) => !entry.silent), [entries])
  const queuedTransport = session.deliveryMode === 'queued'
  // 时间线只放已进入对话的内容；队列传输下尚未被 check_messages 取走的用户消息停在
  // 输入区上方的待投递托盘，被取走那一刻才进入时间线（两处互斥，同一条消息只出现一次）。
  const { timeline: timelineEntries, queued: queuedEntries } = useMemo(
    () => partitionTimelineEntries(visibleEntries, !queuedTransport),
    [visibleEntries, queuedTransport]
  )
  // 托盘是否在场（与 QueuedMessageTray 自己的渲染判定同一口径：服务端计数与可见排队条目取大）。
  const trayVisible = Math.max(session.queueDepth, queuedEntries.length) > 0
  const latestAssistantId = [...timelineEntries].reverse().find((entry) => entry.role === 'assistant')?.id
  const seenCount = useRef(timelineEntries.length)
  /**
   * 观看者到来（本视图按 channelId 挂载）时已存在的实时过程块：切换会话进入正在
   * 生成的回合，这些块的正文已经"呈现过"，落位不重播；之后新出现的块才打字。
   */
  const hydratedBlockIds = useRef<ReadonlySet<string> | null>(null)
  if (hydratedBlockIds.current === null) {
    // 已持久化的续作块与直播块同属"观看者到来时已存在"：续作卡在直播中挂载时
    // 它们同样直接落位，不从空串重播。
    hydratedBlockIds.current = new Set([
      ...(liveProcess?.blocks ?? []).map((block) => block.id),
      ...entries.flatMap((entry) => entry.continuationBlocks?.map((block) => block.id) ?? [])
    ])
  }
  const agentOffline = !session.online
  const lastEntry = timelineEntries.at(-1)
  const lastEntryKey = lastEntry
    ? `${lastEntry.id}:${lastEntry.status}:${lastEntry.text.length}`
    : 'empty'
  // live 过程流指纹：块数/状态翻转都改变它，驱动贴底滚动跟上实时过程
  const liveProcessKey = liveProcess
    ? [
        liveProcess.turn,
        liveProcess.updatedAt,
        ...liveProcess.blocks.slice(-8).map((block) => [
          block.id,
          block.status,
          'summary' in block ? block.summary : '',
          'text' in block ? block.text : '',
          'output' in block ? block.output : ''
        ].join(':'))
      ].join('|')
    : ''
  const finalizedLiveResponse = liveAgentResponse && timelineEntries.some((entry) => (
    entry.role === 'assistant'
    && entry.status === 'complete'
    && entry.timestamp >= liveAgentResponse.startedAt - 5_000
    && entry.text.trim() === liveAgentResponse.text.trim()
  ))
  const visibleLiveResponse = liveAgentResponse && !finalizedLiveResponse ? liveAgentResponse : undefined
  const liveResponseKey = visibleLiveResponse
    ? `${visibleLiveResponse.id}:${visibleLiveResponse.status}:${visibleLiveResponse.text.length}:${visibleLiveResponse.updatedAt}`
    : ''
  const agentRunning = session.online && session.status === 'running'
  const turnTimeline = useMemo(
    () => projectTurnTimeline({
      entries: timelineEntries,
      liveProcess,
      liveResponse: visibleLiveResponse,
      immediateDelivery: !queuedTransport,
      agentRunning
    }),
    [timelineEntries, liveProcess, visibleLiveResponse, queuedTransport, agentRunning]
  )
  // 占位判定沿用：时间线最后一个条目是已投递的用户消息且没有任何回合产物（过程/回复流）
  // 接管该消息——responding 但零产物（过程流未就绪）同样显示占位。
  const pendingVisibleUser = timelineEntries.at(-1)?.role === 'user' ? timelineEntries.at(-1) : undefined
  const lastTurn = pendingVisibleUser
    ? turnTimeline.find((item) => item.key === `turn:${pendingVisibleUser.id}`)
    : undefined
  const lastTurnHasOutput = Boolean(lastTurn?.process?.blocks.length || lastTurn?.response)
  const showRunningPlaceholder = Boolean(pendingVisibleUser && agentRunning
    && (pendingVisibleUser.deliveredAt !== undefined || !queuedTransport)
    && lastTurn && !lastTurn.reply && !lastTurnHasOutput)
  // 「正在处理」占位不再是独立时间线项，而是该回合 Agent 行的空态：过程首帧
  // 到达时同一行原地填充，不会先卸掉占位行再插入新行（两次布局跳动）。
  const placeholderTurnKey = showRunningPlaceholder ? lastTurn?.key : undefined
  const timelineItems = useMemo<TimelineItem[]>(() => (
    turnTimeline.map((item) => ({ type: 'turn', key: item.key, item }))
  ), [turnTimeline])
  const follow = useBottomFollow(
    `${session.id}:${session.composerId ?? ''}`,
    `${timelineEntries.length}:${lastEntryKey}:${liveProcessKey}:${liveResponseKey}:${timelineItems.length}`
  )
  const canSend = (session.online || queuedTransport) && !submitting
  // 独立席位：solo 角色模板的 roleTemplateKey 流经 AgentSession（团队席为
  // lead/frontend 等真实模板键）。措辞分支用它，避免把 solo 会话表述成团队协作一环。
  const soloSeat = session.roleTemplateKey === 'solo'
  const disconnected = agentOffline && !queuedTransport
  const queuedOffline = agentOffline && queuedTransport
  const notWaiting = !disconnected && !queuedOffline && !session.waiting && session.status !== 'running'
  useEffect(() => {
    if (!follow.awayFromBottom) {
      seenCount.current = timelineEntries.length
    }
  }, [follow.awayFromBottom, timelineEntries.length])

  useEffect(() => {
    if (!copiedId) return
    const timer = setTimeout(() => setCopiedId(''), 1_600)
    return () => clearTimeout(timer)
  }, [copiedId])

  // 右栏「在时间线中定位」：滚到对应过程步骤 / 消息并短暂高亮；用户由此离开底部，
  // 贴底跟随按既有意图模型自动暂停。等过程卡把目标步骤展开提交后再定位，并把
  // 「是否找到」回给右栏——找不到时右栏会给出提示，而不是静默无事发生。
  useEffect(() => subscribeReveal((target) => (
    revealAfterPaint(() => follow.viewportRef.current, target)
  )), [follow.viewportRef])

  const pendingBelow = follow.awayFromBottom ? Math.max(0, timelineEntries.length - seenCount.current) : 0

  const jumpToBottom = (): void => {
    seenCount.current = timelineEntries.length
    follow.jumpToBottom()
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !canSend) return
    setSubmitting(true)
    follow.beginFollowing()
    setSendError('')
    try {
      await onSend(text, attachments.length > 0 ? attachments : undefined)
      onDraftChange('')
      onAttachmentsChange([])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const copyEntry = async (entry: ConversationEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.text)
      setCopiedId(entry.id)
    } catch {
      setSendError('复制失败：系统剪贴板不可用')
    }
  }

  const quoteEntry = (entry: ConversationEntry): void => {
    const quoted = entry.text.split('\n').map((line) => `> ${line}`).join('\n')
    const currentDraft = draftRef.current
    onDraftChange(currentDraft ? `${currentDraft}\n\n${quoted}\n\n` : `${quoted}\n\n`)
  }

  const retryEntry = async (entry: ConversationEntry): Promise<void> => {
    const index = timelineEntries.findIndex((candidate) => candidate.id === entry.id)
    const previousUser = timelineEntries.slice(0, index).reverse().find((candidate) => candidate.role === 'user')
    await quickSend(previousUser?.text
      ? `请重新处理上一条请求，保留有效结论并修正不足：\n\n${previousUser.text}`
      : '请重新检查并回答上一条请求，保留有效结论并修正不足。')
  }

  const listenEntry = (entry: ConversationEntry): void => {
    if (!('speechSynthesis' in window)) {
      setSendError('当前系统没有可用的朗读服务')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(entry.text)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.speak(utterance)
  }

  const quickSend = async (text: string): Promise<void> => {
    if (!canSend || !text.trim()) return
    setSubmitting(true)
    follow.beginFollowing()
    setSendError('')
    try {
      await onSend(text.trim())
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const exportTranscript = (): void => {
    const header = `# ${session.displayName} · CH-${session.channelId} 会话记录\n\n导出于 ${new Date().toLocaleString()} · 共 ${visibleEntries.length} 条\n\n---\n`
    const body = visibleEntries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString()
      return `\n## ${entryLabel(entry)} · ${time}\n\n${entry.text || '（空）'}\n`
    }).join('')
    const blob = new Blob([header + body], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `shiguang-ch${session.channelId}-transcript.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  /** 用户消息行：统一 turn 身份（key=turn:<outboundId>），阶段推进不卸载组件。 */
  const renderUserRow = (
    key: string,
    entry: ConversationEntry,
    grouped: boolean,
    needDivider: boolean
  ): React.JSX.Element => {
    return (
      <div key={key}>
        {needDivider && (
          <div className="chat-divider"><span>{dividerLabel(entry.timestamp)}</span></div>
        )}
        <div className={`chat-row chat-row--mine ${grouped ? 'is-grouped' : ''}`} data-entry-id={entry.id}>
          <span className="chat-gutter" aria-hidden={grouped}>
            {!grouped && <i className="chat-face chat-face--mine">你</i>}
          </span>
          <div className="chat-col">
            {!grouped && (
              <div className="chat-name">
                <strong>{entry.source === 'desktop' ? '你' : '用户'}</strong>
                <time>{formatClock(entry.timestamp)}</time>
              </div>
            )}
            <div className="chat-bubble">
              {entry.text
                ? <ClampedMessage text={entry.text} />
                : entry.status === 'streaming' ? '正在生成…' : '（空）'}
              {renderAttachments(entry)}
              {entry.status === 'streaming' && (
                <span className="typing-indicator"><i /><i /><i /></span>
              )}
            </div>
            <div className="chat-tail">
              {/* 进入时间线的用户消息一定已投递（排队中的停在待投递托盘），尾注只剩发送时刻。 */}
              <span className={`chat-state ${entry.status === 'failed' ? 'is-failed' : ''}`}>
                {entry.status === 'pending' && '发送中…'}
                {entry.status === 'complete' && `已发送 ${formatClock(entry.timestamp)}`}
                {entry.status === 'failed' && `发送失败：${entry.error || '未知原因'}`}
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /** 非 Agent 条目行（error / system）：保持 entry 身份直渲染。 */
  const renderSystemRow = (entry: ConversationEntry): React.JSX.Element => {
    const isError = entry.role === 'error'
    return (
      <div key={`reply:${entry.id}`} className={`chat-row chat-row--${isError ? 'error' : 'agent'}`}>
        <span className="chat-gutter">
          {isError ? <i className="chat-face chat-face--error">!</i> : null}
        </span>
        <div className="chat-col">
          <div className="chat-name">
            <strong>{isError ? '错误' : '系统'}</strong>
            <time>{formatClock(entry.timestamp)}</time>
          </div>
          <div className="chat-bubble">
            {entry.text ? <ClampedMessage text={entry.text} /> : '（空）'}
            {renderAttachments(entry)}
          </div>
          <div className="chat-tail">
            {entry.text && (
              <button
                className="chat-action"
                title="复制消息全文"
                onClick={() => void copyEntry(entry)}
              >
                <CopyIcon /><span>{copiedId === entry.id ? '已复制' : '复制'}</span>
              </button>
            )}
            <span className={`chat-state ${entry.status === 'failed' ? 'is-failed' : ''}`}>
              {entry.status === 'failed' && `发送失败：${entry.error || '未知原因'}`}
            </span>
          </div>
        </div>
      </div>
    )
  }

  /**
   * Agent 回合行（阶段 F/G，RC-8/RC-9）：responding 与 sealed 共用同一组件树与
   * key（`${turnKey}:agent`），record_reply 落库只是 props 推进——过程卡、播放器
   * 缓冲、展开状态、DOM 节点全部保留；正文尾部由 TurnResponseText 继续匀速播完。
   */
  const renderAgentTurnRow = (input: {
    turnKey: string
    process?: LiveProcessState
    response?: LiveAgentResponseState
    reply?: ConversationEntry
    grouped: boolean
    detached: boolean
    /** 已投递、Agent 运行中、尚无任何产物：同一行以空态占位（打字指示 + 过程流健康提示）。 */
    idle: boolean
    /**
     * 续作行：回复封口之后 Agent 继续工作的过程，紧贴在该回复之下（同一回合 DOM 身份）。
     * anchorReplyId 用于判定默认展开（只有最新一条回复的续作默认展开，与回复过程卡一致）。
     */
    continuation?: { anchorReplyId: string }
  }): React.JSX.Element => {
    const { turnKey, process, response, reply, grouped, detached, idle, continuation } = input
    const responding = reply === undefined
    // 落库回复优先用持久化过程；封口帧尚未到达时用仍锚定在本回合的实时过程兜底。
    const replyBlocks = reply ? replyProcessBlocks(reply) : undefined
    const blocks = replyBlocks?.length ? replyBlocks : process?.blocks
    const hasProcess = Boolean(blocks?.length)
    // live 信号（RC-9）：服务端 generating 为权威——Cursor 常把生成中的 Thinking
    // 块标记为 done，仅靠「某块 running」会把直播过程误判为历史而跳过打字机。
    const liveActive = responding && (
      process?.generating === true
      || response?.status === 'streaming'
      || Boolean(process?.blocks.some((block) => block.status === 'running'))
    )
    const suggestions = reply?.status === 'complete' ? suggestedActionsFromText(reply.text) : []
    const at = reply?.timestamp ?? process?.startedAt ?? response?.startedAt ?? Date.now()
    const defaultOpen = continuation
      ? liveActive || continuation.anchorReplyId === latestAssistantId
      : responding || reply?.id === latestAssistantId
    // 宽度在回合开始时就定下（responding 恒用宽列）：首个过程块到达时不再把整行
    // 从 82% 拉宽到 94%。
    const className = [
      'chat-row chat-row--agent',
      responding ? 'live-process-row' : '',
      detached ? 'live-process-row--detached' : '',
      responding || hasProcess ? 'chat-row--process' : '',
      continuation ? 'chat-row--continuation' : '',
      grouped ? 'is-grouped' : ''
    ].filter(Boolean).join(' ')
    return (
      <div key={continuation ? `${turnKey}:continuation` : `${turnKey}:agent`} className={className} data-entry-id={reply?.id} data-continuation-of={continuation?.anchorReplyId}>
        <span className="chat-gutter" aria-hidden={grouped}>
          {!grouped
            ? <span className="chat-face-avatar"><AgentAvatar avatarId={session.avatarId} name={session.displayName} crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'} size="sm" /></span>
            : null}
        </span>
        <div className="chat-col">
          {!grouped && (
            <div className="chat-name">
              <strong>Agent</strong>
              {/* 过程卡本身就是"进行中"的表达，无需再挂"正在处理"徽章（用户反馈 2026-09-13）。 */}
              <time>{formatClock(at)}</time>
            </div>
          )}
          <div className={`chat-bubble${idle ? ' live-process-idle' : ''}`}>
            {continuation ? (
              // 直播态由过程卡自己的「Cursor 实时过程」标记表达，这里只说明这一段是什么。
              <div className={`chat-continuation-caption${liveActive ? ' is-live' : ''}`} role="status">
                {liveActive ? '回复后继续工作中' : '回复后继续工作'}
              </div>
            ) : null}
            {idle ? (
              // 回合开场（已投递、首个过程块未到）：链路健康时说 Agent 在做什么
              //（Cursor 开场 Planning next moves 的同款表达，文字流光），不再报系统腔的
              // 「过程流就绪后将在此实时展示」；只有链路真出问题才降级为诊断提示。
              nativeProcessStream?.state === 'connected' ? (
                <span className="live-process-planning" role="status">正在规划下一步</span>
              ) : (
                <>
                  <span className="typing-indicator"><i /><i /><i /></span>
                  <span className="live-process-idle__hint is-warning">
                    {`原生过程流${nativeProcessStream?.state === 'reconnecting' ? '正在重连' : '当前不可用'}：${nativeProcessStream?.detail ?? '等待 Cursor 调试连接'}`}
                  </span>
                </>
              )
            ) : null}
            {hasProcess ? (
              <ProcessTurnCard
                id={reply?.turn ?? process?.turn ?? turnKey}
                blocks={blocks}
                truncatedItemCount={replyBlocks?.length ? reply?.processTruncatedItemCount : process?.truncatedItemCount}
                startedAt={replyBlocks?.length ? reply?.processBlocks?.[0]?.startedAt : process?.startedAt}
                updatedAt={reply ? reply.timestamp : process?.updatedAt}
                defaultOpen={defaultOpen}
                compact
                live={liveActive}
                hydratedBlockIds={hydratedBlockIds.current ?? undefined}
                questionActions={questionActions}
              />
            ) : null}
            <TurnResponseText turnKey={continuation ? `${turnKey}:continuation` : turnKey} live={response} reply={reply} />
            {reply && !reply.text ? (reply.status === 'streaming' ? '正在生成…' : '（空）') : null}
            {reply ? renderAttachments(reply) : null}
            {reply?.status === 'streaming' ? (
              <span className="typing-indicator"><i /><i /><i /></span>
            ) : null}
            {suggestions.length && reply ? (
              <div className="response-suggestions" aria-label="接下来可以">
                <span>接下来可以：</span>
                <div>{suggestions.map((suggestion, index) => (
                  <button key={`${reply.id}:suggestion:${index}`} onClick={() => onDraftChange(suggestion)}>
                    <i>{index + 1}</i><span>{suggestion}</span>
                  </button>
                ))}</div>
              </div>
            ) : null}
          </div>
          <div className="chat-tail">
            {reply ? (
              <>
                {reply.text && (
                  <button
                    className="chat-action"
                    title="复制消息全文"
                    onClick={() => void copyEntry(reply)}
                  >
                    <CopyIcon /><span>{copiedId === reply.id ? '已复制' : '复制'}</span>
                  </button>
                )}
                {reply.status === 'complete' && reply.text ? (
                  <>
                    <button
                      className="chat-action"
                      title="引用这条消息回复"
                      onClick={() => quoteEntry(reply)}
                    >
                      <QuoteIcon /><span>引用</span>
                    </button>
                    <button className="chat-action" title="重新生成这条回答" onClick={() => void retryEntry(reply)}><RetryIcon /><span>重试</span></button>
                    <button className={`chat-action ${starredIds.has(reply.id) ? 'is-active' : ''}`} title={starredIds.has(reply.id) ? '取消收藏' : '收藏回答'} onClick={() => setStarredIds((current) => {
                      const next = new Set(current)
                      if (next.has(reply.id)) next.delete(reply.id)
                      else next.add(reply.id)
                      return next
                    })}><StarIcon filled={starredIds.has(reply.id)} /><span>收藏</span></button>
                    <button className="chat-action" title="朗读回答" onClick={() => listenEntry(reply)}><ListenIcon /><span>朗读</span></button>
                  </>
                ) : null}
                <span className={`chat-state ${reply.status === 'failed' ? 'is-failed' : ''}`}>
                  {reply.status === 'failed' && `发送失败：${reply.error || '未知原因'}`}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  /** 分组判定基于最终可视时间线的相邻项（阶段 F/H，RC-12）：Agent 回合、占位、
   *  分隔线均打断用户消息组；附件消息本身也开启新视觉组。 */
  const renderTimelineItems = (): React.JSX.Element[] => {
    let previousUserEntry: ConversationEntry | undefined
    let previousAssistantEntry: ConversationEntry | undefined
    let previousEntryForDivider: ConversationEntry | undefined
    return timelineItems.map((item) => {
      const turn = item.item
      const renderedRows: React.JSX.Element[] = []
      // ---- 用户气泡（全阶段渲染；分组只针对连续纯文本用户消息）----
      if (turn.user) {
        const previous = previousUserEntry
        const gap = previous ? turn.user.timestamp - previous.timestamp : Number.POSITIVE_INFINITY
        const needDivider = previousEntryForDivider
          ? turn.user.timestamp - previousEntryForDivider.timestamp > DIVIDER_WINDOW_MS
          : gap > DIVIDER_WINDOW_MS
        const grouped = !needDivider
          && previous?.role === 'user'
          && previous?.source === turn.user.source
          && gap < GROUP_WINDOW_MS
          && !turn.user.attachments?.length
          && !previous.attachments?.length
        renderedRows.push(renderUserRow(turn.key, turn.user, grouped, needDivider))
        previousUserEntry = turn.user
        previousAssistantEntry = undefined
      }
      previousEntryForDivider = turn.user ?? previousEntryForDivider
      // ---- Agent 回合行：idle（占位）/ responding（live 过程/回复流）/ sealed（落库回复）同一节点 ----
      const idle = placeholderTurnKey === turn.key
      const responding = idle || (turn.phase === 'responding' && Boolean(turn.process?.blocks.length || turn.response))
      const assistantReply = turn.reply?.role === 'assistant' ? turn.reply : undefined
      if (responding || assistantReply) {
        let grouped = false
        if (assistantReply) {
          const previous = previousAssistantEntry
          const gap = previous ? assistantReply.timestamp - previous.timestamp : Number.POSITIVE_INFINITY
          // 分隔线只在回合没有自己的用户气泡（遗留 entry 身份的回复）时才按回复时间
          // 判定：用户消息与它自己的回复属同一回合，长任务跨过 10 分钟不该在两者
          // 之间插一条分隔线——那会在封口那一帧把 Agent 行整体下推。
          const needDivider = !turn.user && (previousEntryForDivider
            ? assistantReply.timestamp - previousEntryForDivider.timestamp > DIVIDER_WINDOW_MS
            : gap > DIVIDER_WINDOW_MS)
          grouped = !needDivider
            && previous?.role === 'assistant'
            && previous?.source === assistantReply.source
            && gap < GROUP_WINDOW_MS
          // 分隔线作为带 key 的兄弟节点插入，而不是包裹回合行——包裹会改变树形，
          // 让刚从 responding 过渡来的 Agent 行被卸载重建（播放器缓冲丢失）。
          if (needDivider) {
            renderedRows.push(
              <div key={`${turn.key}:agent-divider`} className="chat-divider"><span>{dividerLabel(assistantReply.timestamp)}</span></div>
            )
          }
          previousAssistantEntry = assistantReply
          previousEntryForDivider = assistantReply
        } else {
          previousAssistantEntry = undefined
        }
        renderedRows.push(renderAgentTurnRow({
          turnKey: turn.key,
          process: turn.process,
          response: responding ? turn.response : undefined,
          reply: assistantReply,
          grouped,
          detached: turn.detached !== undefined,
          idle
        }))
        // 续作行：回复封口后 Agent 继续工作（会话交接后接续任务等），过程流与正文流
        // 紧贴回复之下继续直播/回放，而不是被当成传输空档丢弃。
        const continuation = turn.continuation
        if (assistantReply && continuation && (continuation.process?.blocks.length || continuation.response)) {
          renderedRows.push(renderAgentTurnRow({
            turnKey: turn.key,
            process: continuation.process,
            response: continuation.response,
            grouped: true,
            detached: false,
            idle: false,
            continuation: { anchorReplyId: assistantReply.id }
          }))
        }
        // Agent 活动/回复打断用户消息组（RC-12）：u1 与 u2 之间出现过过程/回复，
        // u2 不得与 u1 合并成组（隐藏头像与名称）。
        previousUserEntry = undefined
      } else if (turn.reply) {
        const needDivider = previousEntryForDivider
          ? turn.reply.timestamp - previousEntryForDivider.timestamp > DIVIDER_WINDOW_MS
          : false
        if (needDivider) {
          renderedRows.push(
            <div key={`${turn.key}:system-divider`} className="chat-divider"><span>{dividerLabel(turn.reply.timestamp)}</span></div>
          )
        }
        renderedRows.push(renderSystemRow(turn.reply))
        previousAssistantEntry = undefined
        previousUserEntry = undefined
        previousEntryForDivider = turn.reply
      }
      return <Fragment key={turn.key}>{renderedRows}</Fragment>
    })
  }

  // 时间线渲染结果按语义依赖 memo：draft（每键变）不在依赖内——quoteEntry 经 draftRef
  // 读最新草稿。打字时只重渲染输入区，时间线（含全部历史过程卡/消息行）整体 bailout。
  const timelineContent = useMemo(
    () => renderTimelineItems(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderTimelineItems 是纯投影：依赖即闭包读取的全部响应式值
    [timelineItems, timelineEntries, session, copiedId, starredIds, latestAssistantId, placeholderTurnKey,
      nativeProcessStream, questionActions, onDraftChange, onSend, canSend, follow.beginFollowing]
  )

  return (
    <section className="workspace-main">
      <header className="workspace-header">
        <button className="workspace-back" onClick={onBack} aria-label="返回会话列表">←</button>
        <AgentAvatar
          avatarId={session.avatarId}
          name={session.displayName}
          crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'}
          online={session.online}
          size="lg"
        />
        <div className="workspace-identity">
          <div>
            <h1>{session.displayName}</h1>
            {group ? (
              onOpenGroup ? (
                <button
                  type="button"
                  className="workspace-group-chip"
                  title={`协作组「${group.name}」：查看运行页的组卡片`}
                  onClick={() => onOpenGroup(group.id)}
                >
                  {group.name}
                </button>
              ) : (
                <span className="workspace-group-chip is-static">{group.name}</span>
              )
            ) : null}
            <span className={`status-pill status-pill--${session.status}`}>{statusLabel(session.status)}</span>
          </div>
          <p>{workspaceSubtitle(session)}</p>
        </div>
        <div className="workspace-header__usage">
          <SessionUsageStat usage={session.usage} />
        </div>
      </header>

      <div
        className={disconnected
          ? 'workspace-warning'
          : queuedOffline || notWaiting
            ? 'workspace-warning workspace-warning--idle'
            : 'workspace-warning workspace-warning--hidden'}
        aria-hidden={!disconnected && !queuedOffline && !notWaiting}
      >
        {/* solo 独立席与团队席同服（统一 SG Team 服务器），但措辞按席位区分：
            solo 是「你的专属会话」语义，不该被表述成团队协作的一环。 */}
        <strong>{queuedOffline
          ? 'Cursor Agent 已离线，消息会先进入队列'
          : agentOffline
          ? 'Cursor Agent 已离线，这条会话此刻不能发送'
          : 'Cursor Agent 在线，但没有进入待命'}</strong>
        <span>{queuedOffline
          ? (soloSeat
            ? '只要该 Cursor 会话继续调用 check_messages 轮询，消息就会自动取走；不会因为心跳过期阻止发送。'
            : '只要该 Cursor 会话继续调用 SG Team 的 check_messages，就会自动取走；不会因为心跳过期阻止发送。')
          : disconnected
          ? '会话与本地时间线仍保留，重新启动对应 Cursor Agent 后可以继续。'
          : (soloSeat
            ? '消息会排队，直到该 Cursor 会话调用 check_messages 取走。'
            : `消息会排队，直到对应 Cursor 会话调用 SG Team 的 check_messages。`)}</span>
      </div>

      <div className="workspace-timeline-wrap">
        <div
          className="workspace-timeline"
          ref={follow.viewportRef}
          onScroll={follow.onScroll}
          onWheel={follow.onWheel}
          onPointerDown={follow.onPointerDown}
          onPointerUp={follow.onPointerUp}
          onPointerCancel={follow.onPointerUp}
          onKeyDown={follow.onKeyDown}
        >
          <div className="workspace-timeline__content" ref={follow.contentRef}>
            {timelineItems.length === 0 ? (
              <div className="timeline-empty">
                <h2>还没有消息</h2>
                <p>这里只显示本会话的消息；更早的对话仍保留在 Cursor 历史中。</p>
              </div>
            ) : timelineContent}
          </div>
        </div>
        {follow.awayFromBottom && timelineItems.length > 0 && (
          <button className="timeline-jump" role="status" aria-live="polite" onClick={jumpToBottom}>
            {pendingBelow > 0 ? `${pendingBelow} 条新消息` : '回到底部'} ↓
          </button>
        )}
      </div>

      {/*
        停靠区：时间线与输入区之间的两段——待投递托盘（发送后的即时回显，等 Agent 取走）在上，
        本轮文件栏（这一轮改动过的文件与增删行数）在下。两段同时出现时共用一个外框（CSS :has），
        整个停靠区在纵向预算不够时先于时间线收缩（时间线有下限，列表各自滚动）；
        托盘在场时文件栏让位（只留头部）。
      */}
      <div className="session-dock">
        <QueuedMessageTray
          session={session}
          entries={queuedEntries}
          onWithdraw={onWithdrawQueued ? (entryId) => {
            void onWithdrawQueued(entryId).catch((error: unknown) => {
              setSendError(error instanceof Error ? error.message : String(error))
            })
          } : undefined}
          onRelease={onReleaseQueued ? (entryId) => {
            void onReleaseQueued(entryId).catch((error: unknown) => {
              setSendError(error instanceof Error ? error.message : String(error))
            })
          } : undefined}
        />
        {turnFiles ? <TurnFilesBar view={turnFiles} onReview={onReviewTurnFiles} yieldToTray={trayVisible} /> : null}
      </div>

      <ComposerWorkbench
        session={session}
        currentProjectName={currentProjectName}
        draft={draft}
        canSend={canSend}
        notWaiting={notWaiting}
        submitting={submitting}
        sendError={sendError}
        onDraftChange={onDraftChange}
        onSubmit={() => void submit()}
        onExport={exportTranscript}
        exportEnabled={visibleEntries.length > 0}
        onHandoff={onHandoff}
        handoffTitle={handoffTitle}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
      />
    </section>
  )
}
