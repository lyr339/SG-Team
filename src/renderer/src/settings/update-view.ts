import {
  releaseNotesToPlainText,
  shouldRemindAppUpdate,
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
  | 'open-release'
  | 'rollback'

export interface UpdateAction {
  id: UpdateActionId
  label: string
  kind: 'primary' | 'secondary' | 'link'
  disabled?: boolean
}

export type UpdateTone = 'neutral' | 'accent' | 'info' | 'success' | 'danger' | 'muted'

export interface UpdatePanelView {
  tone: UpdateTone
  /** 状态卡主句：「已是最新版本 0.3.2」「发现新版本 0.3.3」…… */
  headline: string
  /** 一行补充：上次检查时间、发布日期与体积、错误原因。 */
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
  const { state, settings, currentVersion } = status
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

  switch (state.phase) {
    case 'unsupported':
      return {
        tone: 'muted',
        headline: `当前版本 ${currentVersion}`,
        detail: state.reason,
        notes: [],
        actions: [openRelease],
        busy: false
      }
    case 'idle': {
      // 网络类失败（瞬断、断网、被墙）不吓人：中性色 + 人话 + 原始错误收进悬停；红色留给明确错误。
      const networkError = state.lastError !== undefined && state.lastErrorKind === 'network'
      const at = state.lastCheckedAt ? `（${formatUpdateTime(state.lastCheckedAt, now)}）` : ''
      return {
        tone: state.lastError && !networkError ? 'danger' : 'neutral',
        headline: `当前版本 ${currentVersion}`,
        detail: networkError
          ? `连不上更新源${at}：${settings.autoCheck ? '稍后会自动重试，' : ''}网络恢复后也可「立即检查」`
          : state.lastError
            ? `上次检查失败${at}：${state.lastError}`
            : state.lastCheckedAt
              ? `上次检查 ${formatUpdateTime(state.lastCheckedAt, now)}`
              : '尚未检查过更新',
        ...(networkError && state.lastError ? { detailTitle: state.lastError } : {}),
        notes: [],
        actions: [{ id: 'check', label: '立即检查', kind: 'primary' }, openRelease],
        busy: false
      }
    }
    case 'checking':
      return {
        tone: 'info',
        headline: '正在检查更新…',
        detail: `当前版本 ${currentVersion}`,
        notes,
        actions: [{ id: 'check', label: '正在检查', kind: 'primary', disabled: true }, openRelease],
        busy: true
      }
    case 'up_to_date':
      return {
        tone: 'success',
        headline: `已是最新版本 ${currentVersion}`,
        detail: `上次检查 ${formatUpdateTime(state.checkedAt, now)}`,
        notes: [],
        actions: [{ id: 'check', label: '立即检查', kind: 'primary' }, openRelease],
        busy: false
      }
    case 'available': {
      // 没有本平台资产（清单缺项 / 只拿到 tag）：只能去发布页手动更新。
      if (state.release.downloadable === false) {
        const detail = releaseDetail(state.release)
        return {
          tone: skippedNote ? 'muted' : 'accent',
          headline: `发现新版本 ${state.release.version}`,
          detail: `此版本未提供应用内下载，请到发布页手动更新${detail ? `（${detail}）` : ''}`,
          notes,
          actions: [{ id: 'open-release', label: '打开发布页', kind: 'primary' }, ...skipActions()],
          ...(skippedNote ? { skippedNote } : {}),
          ...(snoozedNote ? { snoozedNote } : {}),
          busy: false
        }
      }
      return {
        tone: skippedNote ? 'muted' : 'accent',
        headline: `发现新版本 ${state.release.version}`,
        detail: releaseDetail(state.release),
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
      return {
        tone: 'info',
        headline: verifying ? `正在校验并解压 ${state.release.version}…` : `正在下载 ${state.release.version}…`,
        detail: verifying ? '下载已完成；正在核对签名与版本，几秒后就绪。' : releaseDetail(state.release),
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
    case 'downloaded':
      return {
        tone: 'accent',
        headline: `${state.release.version} 已就绪`,
        detail: '安装会退出拾光、运行安装器（按机安装会弹一次系统授权），装完自动重新打开。',
        notes,
        actions: [{ id: 'install', label: '安装并重启', kind: 'primary' }, ...skipActions(), openRelease],
        ...(skippedNote ? { skippedNote } : {}),
        ...(snoozedNote ? { snoozedNote } : {}),
        busy: false
      }
    case 'installing':
      return {
        tone: 'info',
        headline: `正在安装 ${state.release.version}…`,
        detail: '拾光即将退出；安装完成后会自动重新打开。',
        notes: [],
        actions: [],
        busy: true
      }
    case 'rolling_back':
      return {
        tone: 'info',
        headline: `正在回滚到 ${state.targetVersion}…`,
        detail: '拾光即将退出；换回旧版后会自动重新打开。',
        notes: [],
        actions: [],
        busy: true
      }
    case 'failed': {
      const step = state.step === 'download' ? '下载' : state.step === 'install' ? '安装' : state.step === 'rollback' ? '回滚' : '检查'
      return {
        tone: 'danger',
        headline: `${step}失败`,
        detail: state.message,
        notes,
        actions: [
          { id: 'dismiss', label: state.release ? '重试' : '知道了', kind: 'primary' },
          openRelease
        ],
        busy: false
      }
  }
  }
}

export const UPDATE_INTERVAL_OPTIONS = [
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每天' }
] as const
