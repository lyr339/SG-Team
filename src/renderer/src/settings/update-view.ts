import {
  classifyAppUpdateError,
  releaseNotesToPlainText,
  shouldRemindAppUpdate,
  type AppUpdateFailureStep,
  type AppUpdateStatus
} from '../../../domain/app-update'
import { formatFileSize } from '../../../shared/format-file-size'

export type UpdateActionId =
  | 'check'
  | 'download'
  | 'cancel'
  | 'install'
  | 'skip'
  | 'unskip'
  | 'snooze'
  | 'dismiss'
  /** 失败后的一键重来：清掉失败态并立刻重新下载（`dismiss` 只清状态，不配叫「重试」）。 */
  | 'retry-download'
  | 'open-release'
  | 'rollback'

export interface UpdateAction {
  id: UpdateActionId
  label: string
  kind: 'primary' | 'secondary' | 'link'
  disabled?: boolean
}

export type UpdateTone = 'neutral' | 'accent' | 'info' | 'success' | 'danger' | 'muted'

/**
 * 版本状态的读法：一行设置（与 Cursor 维护页同一结构）——左边标签是版本，下面一两行说明，右边是操作；
 * 区块头右侧一枚文字胶囊说状态（已是最新 / 有新版本 / 下载中 42% / 检查失败……）。
 * 状态色只落在胶囊、进度条与主按钮上，标签与正文保持炭色——没有圆点，也没有大号数字。
 */
export interface UpdatePanelView {
  tone: UpdateTone
  /** 区块头右侧的状态胶囊；空闲且无事可说时不显示。 */
  badge?: { label: string; tone: UpdateTone }
  /** 行标签：没有目标版本时「拾光 0.3.2」；有新版时「新版本 0.3.3」；回滚时「回滚到 0.3.2」。 */
  title: string
  /** 标签下的状态一句话：上次检查时间、发布日期与体积、人话说明、错误原因。 */
  headline: string
  /** 再往下一行更弱的补充（发布信息、上次尝试时间；有目标版本时带上「当前 x」）。 */
  detail?: string
  /** detail 的悬停全文（网络失败时给原始错误码，正文只留人话）。 */
  detailTitle?: string
  /** 发布说明的纯文本段落；没有新版时为空。 */
  notes: string[]
  progress?: { percent: number; received: string; total: string; rate?: string }
  actions: UpdateAction[]
  /** 已跳过当前发现的版本：面板里给一条可撤销的说明。 */
  skippedNote?: string
  /** 稍后期内：面板说明何时恢复提醒。 */
  snoozedNote?: string
  /** 检查进行中 / 下载进行中 / 安装中：控件禁用、显示活动态。 */
  busy: boolean
  /** mac：存在可回滚的备份且此刻没在忙——卡片底部给「回滚到 x」。 */
  rollback?: { version: string; note: string }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 今天只给时刻，其余给月-日 时:分（与统计页的本地时间习惯一致）。 */
export function formatUpdateTime(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    return `今天 ${time}`
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

export function formatReleaseDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const FAILURE_STEP_NAMES: Record<AppUpdateFailureStep, string> = {
  check: '检查',
  download: '下载',
  install: '安装',
  rollback: '回滚'
}

/**
 * 失败的人话：发生了什么、拾光此刻是哪个版本、下一步能做什么。技术原文不丢，退到下面的弱色行里——
 * 「sha512 checksum mismatch, expected …」当正文没人读得懂，但要能照抄来反馈。
 */
const FAILURE_HEADLINES: Record<AppUpdateFailureStep, string> = {
  check: '没能问到更新源；稍后再试，或到发布页查看。',
  download: '安装包没下完或没通过校验；重试即可，反复失败可在下方换用镜像源，或到发布页手动下载。',
  install: '安装没有完成，拾光仍是当前版本；重新下载后再装一次，或到发布页手动安装。',
  rollback: '回滚没有完成，当前版本没有改变；原因见数据目录 updates/apply.log。'
}

function releaseDetail(release: { releaseDate?: string; sizeBytes?: number }): string | undefined {
  const parts: string[] = []
  const date = formatReleaseDate(release.releaseDate)
  if (date) parts.push(`${date} 发布`)
  if (release.sizeBytes) parts.push(formatFileSize(release.sizeBytes))
  return parts.length ? parts.join(' · ') : undefined
}

export function buildUpdatePanelView(status: AppUpdateStatus, now: number): UpdatePanelView {
  const view = buildPhaseView(status, now)
  const rollback = status.rollback
  if (!rollback || view.busy) return view
  return {
    ...view,
    rollback: {
      version: rollback.version,
      note: `保留了 ${rollback.version} 的备份（${formatUpdateTime(rollback.createdAt, now)}）：回滚会退出拾光、换回旧版与更新前的数据库副本；当前数据库会另存一份，更新后产生的记录在旧版里不可见。`
    }
  }
}

function buildPhaseView(status: AppUpdateStatus, now: number): UpdatePanelView {
  const { state, settings } = status
  const openRelease: UpdateAction = { id: 'open-release', label: '打开发布页', kind: 'link' }
  const release = 'release' in state ? state.release : undefined
  const notes = release ? releaseNotesToPlainText(release.releaseNotes) : []
  const skippedNote = release && settings.skippedVersion && !shouldRemindAppUpdate(state, { ...settings, snoozedUntil: undefined }, now)
    ? `已跳过 ${settings.skippedVersion}，出现更高版本时再提醒`
    : undefined
  const snoozedNote = release && settings.snoozedUntil !== undefined && now < settings.snoozedUntil
    ? `已选择稍后，${formatUpdateTime(settings.snoozedUntil, now)} 后恢复提醒`
    : undefined
  const skipActions = (): UpdateAction[] => (
    skippedNote
      ? [{ id: 'unskip', label: '取消跳过', kind: 'secondary' }]
      : [{ id: 'skip', label: '跳过此版本', kind: 'secondary' }, { id: 'snooze', label: '稍后', kind: 'secondary', disabled: Boolean(snoozedNote) }]
  )

  // 行标签：没有目标版本时是「拾光 <当前>」；有目标时标签换成目标，当前版本退到补充行的「当前 x」。
  const current = `拾光 ${status.currentVersion}`
  const newVersion = (version: string): string => `新版本 ${version}`
  const facts = (meta?: string): string => [meta, `当前 ${status.currentVersion}`].filter(Boolean).join(' · ')
  // 有新版但被跳过：胶囊与色调都收成 muted，让「已跳过」的说明成为主角。
  const releaseBadge = (label: string): UpdatePanelView['badge'] => (skippedNote ? { label: '已跳过', tone: 'muted' } : { label, tone: 'accent' })

  switch (state.phase) {
    case 'unsupported':
      return {
        tone: 'muted',
        badge: { label: '不支持应用内更新', tone: 'muted' },
        title: current,
        headline: state.reason,
        notes: [],
        actions: [openRelease],
        busy: false
      }
    case 'idle': {
      // 网络类失败（瞬断、断网、被墙）不吓人：中性胶囊 + 人话 + 原始错误收进悬停；红色胶囊留给明确错误。
      const networkError = state.lastError !== undefined && state.lastErrorKind === 'network'
      const at = state.lastCheckedAt ? formatUpdateTime(state.lastCheckedAt, now) : undefined
      const base = { title: current, notes: [], actions: [{ id: 'check', label: '立即检查', kind: 'primary' }, openRelease] as UpdateAction[], busy: false }
      if (networkError) {
        return {
          ...base,
          tone: 'neutral',
          badge: { label: '暂时连不上更新源', tone: 'neutral' },
          headline: `${settings.autoCheck ? '稍后会自动重试，' : ''}网络恢复后也可「立即检查」`,
          ...(at ? { detail: `上次尝试 ${at}` } : {}),
          ...(state.lastError ? { detailTitle: state.lastError } : {})
        }
      }
      if (state.lastError) {
        return {
          ...base,
          tone: 'danger',
          badge: { label: '检查失败', tone: 'danger' },
          headline: state.lastError,
          ...(at ? { detail: `上次检查 ${at}` } : {})
        }
      }
      return { ...base, tone: 'neutral', headline: at ? `上次检查 ${at}` : '尚未检查过更新' }
    }
    case 'checking':
      return {
        tone: 'info',
        badge: { label: '正在检查…', tone: 'info' },
        title: current,
        headline: '正在向更新源核对版本…',
        notes,
        actions: [{ id: 'check', label: '正在检查', kind: 'primary', disabled: true }, openRelease],
        busy: true
      }
    case 'up_to_date':
      return {
        tone: 'success',
        badge: { label: '已是最新', tone: 'success' },
        title: current,
        headline: `上次检查 ${formatUpdateTime(state.checkedAt, now)}`,
        notes: [],
        actions: [{ id: 'check', label: '立即检查', kind: 'primary' }, openRelease],
        busy: false
      }
    case 'available': {
      const meta = releaseDetail(state.release)
      // 没有本平台资产（清单缺项 / 只拿到 tag）：只能去发布页手动更新。
      if (state.release.downloadable === false) {
        return {
          tone: skippedNote ? 'muted' : 'accent',
          badge: releaseBadge('有新版本'),
          title: newVersion(state.release.version),
          headline: '此版本未提供应用内下载，请到发布页手动更新',
          detail: facts(meta),
          notes,
          actions: [{ id: 'open-release', label: '打开发布页', kind: 'primary' }, ...skipActions()],
          ...(skippedNote ? { skippedNote } : {}),
          ...(snoozedNote ? { snoozedNote } : {}),
          busy: false
        }
      }
      // 有新版：标签下只留一行事实——发布日期、体积、当前版本；下载与否由右边的按钮说。
      return {
        tone: skippedNote ? 'muted' : 'accent',
        badge: releaseBadge('有新版本'),
        title: newVersion(state.release.version),
        headline: facts(meta),
        notes,
        actions: [{ id: 'download', label: '下载', kind: 'primary' }, ...skipActions(), openRelease],
        ...(skippedNote ? { skippedNote } : {}),
        ...(snoozedNote ? { snoozedNote } : {}),
        busy: false
      }
    }
    case 'downloading': {
      const verifying = state.activity === 'verify'
      const percent = verifying ? 100 : state.totalBytes > 0 ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : 0
      const meta = releaseDetail(state.release)
      return {
        tone: 'info',
        badge: { label: verifying ? '正在校验' : `下载中 ${percent}%`, tone: 'info' },
        title: newVersion(state.release.version),
        headline: verifying ? '下载已完成；正在核对签名与版本，几秒后就绪。' : '正在下载安装包…',
        detail: facts(meta),
        notes,
        progress: {
          percent,
          received: formatFileSize(state.receivedBytes),
          total: state.totalBytes > 0 ? formatFileSize(state.totalBytes) : '—',
          ...(!verifying && state.bytesPerSecond ? { rate: `${formatFileSize(state.bytesPerSecond)}/s` } : {})
        },
        actions: [{ id: 'cancel', label: '取消下载', kind: 'secondary', ...(verifying ? { disabled: true } : {}) }, openRelease],
        busy: true
      }
    }
    case 'downloaded': {
      const meta = releaseDetail(state.release)
      return {
        tone: skippedNote ? 'muted' : 'accent',
        badge: releaseBadge('待安装'),
        title: newVersion(state.release.version),
        headline: '已下载校验通过。安装会退出拾光、运行安装器（按机安装会弹一次系统授权），装完自动重新打开。',
        detail: facts(meta),
        notes,
        actions: [{ id: 'install', label: '安装并重启', kind: 'primary' }, ...skipActions(), openRelease],
        ...(skippedNote ? { skippedNote } : {}),
        ...(snoozedNote ? { snoozedNote } : {}),
        busy: false
      }
    }
    case 'installing':
      return {
        tone: 'info',
        badge: { label: '正在安装', tone: 'info' },
        title: newVersion(state.release.version),
        headline: '拾光即将退出；安装完成后会自动重新打开。',
        detail: facts(),
        notes: [],
        actions: [],
        busy: true
      }
    case 'rolling_back':
      return {
        tone: 'info',
        badge: { label: '正在回滚', tone: 'info' },
        title: `回滚到 ${state.targetVersion}`,
        headline: '拾光即将退出；换回旧版后会自动重新打开。',
        detail: facts(),
        notes: [],
        actions: [],
        busy: true
      }
    case 'failed': {
      // 下载是唯一走网络的失败步骤：瞬断不是判决，沿用检查失败那套中性读法，别为一次网络波动报红。
      const network = state.step === 'download' && classifyAppUpdateError(state.message) === 'network'
      // 「重试」必须真能一键重来。dismiss 后状态回到 available，那里唯一能接着做的是重新下载：
      // 下载 / 安装失败都从这里重来，回滚与检查失败没有一键可重的下一步，就老实叫「知道了」。
      const recoverable = state.release !== undefined && (state.step === 'download' || state.step === 'install')
      return {
        tone: network ? 'neutral' : 'danger',
        badge: network
          ? { label: '下载未完成', tone: 'neutral' }
          : { label: `${FAILURE_STEP_NAMES[state.step]}失败`, tone: 'danger' },
        title: state.release ? newVersion(state.release.version) : current,
        headline: network ? '下载中断了，多半是网络波动；重试即可，反复失败可在下方换用镜像源。' : FAILURE_HEADLINES[state.step],
        detail: state.message,
        notes,
        actions: [
          recoverable
            ? { id: 'retry-download', label: state.step === 'download' ? '重试下载' : '重新下载', kind: 'primary' }
            : { id: 'dismiss', label: '知道了', kind: 'primary' },
          openRelease
        ],
        busy: false
      }
    }
  }
}

export type ReleaseNoteBlock = { kind: 'text'; text: string } | { kind: 'list'; items: string[] }

/** 发布说明的纯文本行 → 段落与列表：连续的「- 」「* 」「• 」行合成一个列表（去掉记号），其余行各成一段。 */
export function groupReleaseNotes(lines: string[]): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = []
  for (const line of lines) {
    const item = /^[-*•]\s+(.*)$/.exec(line)?.[1]
    const last = blocks[blocks.length - 1]
    if (item !== undefined) {
      if (last?.kind === 'list') last.items.push(item)
      else blocks.push({ kind: 'list', items: [item] })
    } else {
      blocks.push({ kind: 'text', text: line })
    }
  }
  return blocks
}

export const UPDATE_INTERVAL_OPTIONS = [
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每天' }
] as const
