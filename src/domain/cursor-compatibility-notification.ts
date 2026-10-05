import type { CursorCompatibility } from './cursor-compatibility'
import type { CursorSwitchPumpStatus } from './cursor-switch-pump'
import type { NotificationDraft } from './notification'
import { validateNotificationDraft } from './notification'

/** Whitelisted read facts only: no patch key/port, local path, diagnostics or installer commands. */
export interface CursorCompatibilityObservation {
  installationId?: string
  version?: string
  compatibility: CursorCompatibility['state']
  patch: CursorSwitchPumpStatus['kind']
  profileRefreshReady?: boolean
}
export interface CursorCompatibilityObserver {
  begin(): { complete(fact: CursorCompatibilityObservation): void }
}
interface CompatibilityRow {
  fact: CursorCompatibilityObservation
  issue?: string
  episode: number
  recorded: boolean
}
export interface CompatibilityNotificationState {
  version: 1
  key: string
  selected?: string
  rows: Record<string, CompatibilityRow>
}
export interface CompatibilityNotificationInput {
  key: string
  fact: CursorCompatibilityObservation
  now: number
}
export function cursorCompatibilityIssue(fact: CursorCompatibilityObservation): string | undefined {
  if (fact.compatibility === 'unsupported') return 'version'
  if (fact.patch === 'unsupported') return 'capability'
  if (fact.compatibility === 'unavailable' || fact.patch === 'unavailable') return 'unconfirmed'
  if (fact.patch === 'installed' && fact.profileRefreshReady === false) return 'profile'
  if (fact.patch === 'installed' && fact.profileRefreshReady === undefined) return 'unconfirmed'
  return undefined
}
export function readCompatibilityNotificationState(value: unknown, key: string): CompatibilityNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as CompatibilityNotificationState
  if (!state || state.version !== 1 || state.key !== key || !state.rows || typeof state.rows!=='object' || Array.isArray(state.rows) || Object.keys(state.rows).length > 64)
    throw Error('兼容检查通知状态无效')
  for (const [id, row] of Object.entries(state.rows)) {
    if (
      !row ||
      (id !== 'unidentified' && !/^[a-f0-9]{64}$/.test(id)) ||
      !Number.isSafeInteger(row.episode) ||
      row.episode < 0 ||
      typeof row.recorded !== 'boolean' ||
      (row.issue !== undefined && !['version', 'capability', 'unconfirmed', 'profile'].includes(row.issue))
    )
      throw Error('兼容通知身份无效')
    validateFact(row.fact)
    if(id!==(row.fact.installationId??'unidentified'))throw Error('兼容通知安装身份不一致')
  }
  if(state.selected!==undefined&&!state.rows[state.selected])throw Error('兼容通知当前安装身份无效')
  return state
}
function validateFact(fact: CursorCompatibilityObservation): void {
  if (
    !fact ||
    !['supported', 'unsupported', 'unavailable'].includes(fact.compatibility) ||
    !['installed', 'not-installed', 'unsupported', 'unavailable'].includes(fact.patch) ||
    (fact.installationId !== undefined && !/^[a-f0-9]{64}$/.test(fact.installationId)) ||
    (fact.version !== undefined && !/^\d+\.\d+\.\d+$/.test(fact.version)) || (fact.profileRefreshReady!==undefined&&typeof fact.profileRefreshReady!=='boolean')
  )
    throw Error('兼容观察事实无效')
}
export function reduceCompatibilityNotifications(
  previous: CompatibilityNotificationState | undefined,
  input: CompatibilityNotificationInput,
  baseline: boolean,
  revision: number
) {
  validateFact(input.fact)
  const rows = { ...previous?.rows },
    id = input.fact.installationId ?? 'unidentified',
    old = rows[id]
  const issue = cursorCompatibilityIssue(input.fact),
    newEpisode = Boolean(issue && !old?.issue),
    episode = newEpisode ? (old?.episode ?? 0) + 1 : (old?.episode ?? 0)
  const current: CompatibilityRow = {
    fact: input.fact,
    issue,
    episode,
    recorded: Boolean(old?.recorded || (issue && issue !== 'unconfirmed') || (issue && (old || previous?.selected)))
  }
  rows[id] = current
  if (Object.keys(rows).length > 64) throw Error('兼容安装身份超出容量，不能截掉重要历史')
  const drafts: NotificationDraft[] = [],
    base = {
      category: 'maintenance' as const,
      source: 'Cursor 兼容检查',
      scope: {
        ...(input.fact.installationId ? { installationId: input.fact.installationId } : {}),
        ...(input.fact.version ? { cursorVersion: input.fact.version } : {})
      },
      target: { kind: 'settings' as const, section: 'maintenance' as const },
      origin: { module: 'account' as const, section: 'maintenance' as const },
      occurredAt: input.now,
      timeBasis: 'observed' as const,
      sourceRevision: revision
    }
  const unidentified = rows.unidentified
  if (
    id !== 'unidentified' &&
    input.fact.compatibility !== 'unavailable' &&
    input.fact.patch !== 'unavailable' &&
    unidentified?.recorded &&
    unidentified.issue
  ) {
    rows.unidentified = { ...unidentified, issue: undefined }
    drafts.push({
      ...base,
      scope: {},
      key: `cursor-compatibility:unidentified:episode:${unidentified.episode}`,
      eventType: 'cursor.compatibility',
      subjectState: 'identified',
      title: '当前选择的 Cursor 安装已重新识别',
      detail: '原检查已确认当前安装身份。未据此推测先前其他安装也已恢复，具体版本/补丁检查结果仍各自保留。',
      tone: 'info',
      attention: 'notice',
      state: 'resolved',
      announce: false,
      renewAttention: false,
      respectCleared: true
    })
  }
  if (old?.fact.version && input.fact.version && old.fact.version !== input.fact.version)
    drafts.push({
      ...base,
      key: `cursor-version:${id}:${input.fact.version}`,
      eventType: 'cursor.version',
      subjectState: 'observed',
      title: '原检查发现 Cursor 版本已变化',
      detail: `${old.fact.version} → ${input.fact.version}。版本与补丁能力分别检查；未据此重启、安装或判断所有功能可用。`,
      tone: 'info',
      attention: 'activity',
      state: 'resolved',
      announce: false,
      respectCleared: true
    })
  if (current.recorded && (issue !== old?.issue || JSON.stringify(input.fact) !== JSON.stringify(old?.fact))) {
    const title =
      issue === 'version'
        ? '这份 Cursor 版本尚未适配'
        : issue === 'capability'
          ? '这份安装的补丁能力检查未通过'
          : issue === 'profile'
            ? '切号补丁在位，资料刷新能力仍需补全'
            : issue === 'unconfirmed'
              ? '当前 Cursor 安装状态待确认'
              : '原兼容检查已有确认结果'
    const detail =
      issue === 'version'
        ? `原检查版本为 ${input.fact.version ?? '未知'}，暂不在已适配范围。请在维护页核对；不能据此说其他所有功能都失效。`
        : issue === 'capability'
          ? '版本信息和实际 bundle 能力是两个边界。原检查没有确认补丁能力可用；请查看维护页的原诊断，不会自动覆盖或卸载补丁。'
          : issue === 'profile'
            ? '原检查确认切号泵在位，但没有确认账号资料刷新 hook 就绪。这不是账号切换失败，也不表示需要重跑账号流程。'
            : issue === 'unconfirmed'
              ? '原检查没有确认当前安装或版本，不能把上次的支持状态继续当作当前事实，也不据此认定补丁已丢失。'
              : `版本 ${input.fact.version ?? '未知'} 的原检查已返回确认结果；${input.fact.patch === 'installed' ? '补丁文件检查在位，不代表运行中的 Cursor 已加载。' : '补丁当前未安装，不代表无感切换已经可用。'}`
    drafts.push({
      ...base,
      key: `cursor-compatibility:${id}:episode:${episode}`,
      eventType: 'cursor.compatibility',
      subjectState: issue ?? 'confirmed',
      title,
      detail,
      tone: issue ? 'warning' : 'info',
      attention: 'notice',
      state: issue ? 'active' : 'resolved',
      announce: Boolean(issue && issue !== 'unconfirmed' && !baseline && old && newEpisode),
      renewAttention: newEpisode,
      respectCleared: !newEpisode
    })
  }
  drafts.forEach(validateNotificationDraft)
  return { state: { version: 1 as const, key: input.key, selected: id, rows }, drafts }
}
