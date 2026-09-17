import { useEffect, useState } from 'react'
import type { AppUpdateApplyResult, AppUpdateSettings, AppUpdateStatus, UpdateGate } from '../../../domain/app-update'
import { APP_UPDATE_CHECK_INTERVAL_HOURS, APP_UPDATE_MIRROR_FEED, normalizeAppUpdateSettings } from '../../../domain/app-update'
import { MenuSelect } from '../lobby/MenuSelect'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { SettingsSection } from './SettingsSection'
import { UPDATE_INTERVAL_OPTIONS, buildUpdatePanelView, type UpdateActionId } from './update-view'

interface SettingsUpdateProps {
  /** 测试 / 预览可注入初始状态；生产从 window.sgDesktop 拉取并订阅推送。 */
  initialStatus?: AppUpdateStatus
  now?: () => number
}

type UpdateApi = Pick<Window['sgDesktop'],
  | 'getAppUpdateStatus' | 'checkAppUpdate' | 'downloadAppUpdate' | 'cancelAppUpdateDownload' | 'installAppUpdate'
  | 'rollbackAppUpdate' | 'dismissAppUpdateApplyResult'
  | 'skipAppUpdate' | 'unskipAppUpdate' | 'snoozeAppUpdate' | 'dismissAppUpdateFailure' | 'saveAppUpdateSettings'
  | 'openAppUpdateReleasePage' | 'onAppUpdateStatus'
>

function updateApi(): UpdateApi | undefined {
  const api = typeof window !== 'undefined' ? window.sgDesktop : undefined
  return api && typeof api.getAppUpdateStatus === 'function' ? api : undefined
}

/** 上次退出时辅助脚本留下的结果（mac）的一句话。 */
export function applyResultText(result: AppUpdateApplyResult): { tone: 'success' | 'danger'; text: string } {
  switch (result.status) {
    case 'applied':
      return {
        tone: 'success',
        text: `已更新到 ${result.to}（原 ${result.from}）。Cursor 里的 SG Team 服务器会随之重载一次；若席位长时间未恢复，到 Cursor 的 MCP 设置里刷新 SG Team。`
      }
    case 'rolled_back':
      return {
        tone: 'success',
        text: `已回滚到 ${result.to}。${result.from} 期间产生的数据库记录已另存在数据目录的 updates/rollback-… 下，旧版里不可见但没有丢。`
      }
    case 'apply_failed':
      return {
        tone: 'danger',
        text: `更新到 ${result.to} 失败，已恢复 ${result.from}${result.reason ? `（${result.reason}）` : ''}。详情见数据目录 updates/apply.log。`
      }
    case 'rollback_failed':
      return {
        tone: 'danger',
        text: `回滚到 ${result.to} 失败${result.reason ? `（${result.reason}）` : ''}，当前仍是 ${result.from}。详情见数据目录 updates/apply.log。`
      }
  }
}

type PendingConfirm = { action: 'install' | 'rollback'; gate: UpdateGate }

/**
 * 设置页「软件更新」组：手动组件。状态卡 + 检查设置。主进程只推状态；这里只发意图，
 * 不经 App.tsx 传 props（自取 window.sgDesktop），与在途工作零冲突。
 */
export function SettingsUpdate({ initialStatus, now = () => Date.now() }: SettingsUpdateProps): React.JSX.Element {
  const [status, setStatus] = useState<AppUpdateStatus | undefined>(initialStatus)
  const [confirm, setConfirm] = useState<PendingConfirm>()
  const [blockedNote, setBlockedNote] = useState<string>()
  const [feedDraft, setFeedDraft] = useState<string>()
  const [updatedNoteDismissed, setUpdatedNoteDismissed] = useState(false)
  const [busyAction, setBusyAction] = useState<UpdateActionId>()

  useEffect(() => {
    const api = updateApi()
    if (!api) return
    let cancelled = false
    void api.getAppUpdateStatus().then((next) => { if (!cancelled) setStatus(next) }).catch(() => {})
    const unsubscribe = api.onAppUpdateStatus((next) => setStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const settings = status?.settings ?? normalizeAppUpdateSettings(undefined)
  const view = status ? buildUpdatePanelView(status, now()) : undefined

  const saveSettings = (patch: Partial<AppUpdateSettings>): void => {
    const api = updateApi()
    if (!api) return
    const next = normalizeAppUpdateSettings({ ...settings, ...patch })
    void api.saveAppUpdateSettings(next).then(setStatus).catch(() => {})
  }

  const run = async (id: UpdateActionId): Promise<void> => {
    const api = updateApi()
    if (!api || busyAction) return
    setBusyAction(id)
    setBlockedNote(undefined)
    try {
      switch (id) {
        case 'check': setStatus(await api.checkAppUpdate()); break
        case 'download':
          // 下载的 IPC 直到下载结束（完成 / 取消 / 失败）才返回：不能用它占住 busyAction，否则整个
          // 下载期间「取消下载」点不动。进度与终态都由状态推送驱动，这里只在结束时兜底收一次状态。
          void api.downloadAppUpdate().then(setStatus).catch((reason: unknown) => {
            setBlockedNote(reason instanceof Error ? reason.message : String(reason))
          })
          break
        case 'cancel': setStatus(await api.cancelAppUpdateDownload()); break
        case 'install': {
          const result = await api.installAppUpdate({ confirmed: false })
          setStatus(result.status)
          if (result.gate.verdict === 'confirm') setConfirm({ action: 'install', gate: result.gate })
          else if (result.gate.verdict === 'block') setBlockedNote(result.gate.reasons.join(' '))
          break
        }
        case 'rollback': {
          // 回滚总要确认（会用更新前的库快照覆盖当前库）；confirmed:false 只是拿门禁结论。
          const result = await api.rollbackAppUpdate({ confirmed: false })
          setStatus(result.status)
          if (result.gate.verdict === 'block') setBlockedNote(result.gate.reasons.join(' '))
          else setConfirm({ action: 'rollback', gate: result.gate })
          break
        }
        case 'skip': setStatus(await api.skipAppUpdate()); break
        case 'unskip': setStatus(await api.unskipAppUpdate()); break
        case 'snooze': setStatus(await api.snoozeAppUpdate()); break
        case 'dismiss': setStatus(await api.dismissAppUpdateFailure()); break
        case 'open-release': await api.openAppUpdateReleasePage(); break
      }
    } catch (reason) {
      setBlockedNote(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  const confirmPending = async (): Promise<void> => {
    const api = updateApi()
    if (!api || !confirm) return
    const action = confirm.action
    setConfirm(undefined)
    setBusyAction(action)
    try {
      const result = action === 'install'
        ? await api.installAppUpdate({ confirmed: true })
        : await api.rollbackAppUpdate({ confirmed: true })
      setStatus(result.status)
      if (result.gate.verdict === 'block') setBlockedNote(result.gate.reasons.join(' '))
    } catch (reason) {
      setBlockedNote(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  const dismissApplyResult = (): void => {
    const api = updateApi()
    if (!api) {
      setStatus((current) => current ? { ...current, applyResult: undefined } : current)
      return
    }
    void api.dismissAppUpdateApplyResult().then(setStatus).catch(() => {})
  }

  const feedValue = feedDraft ?? settings.feedUrl ?? ''
  const feedDirty = feedDraft !== undefined && feedDraft.trim() !== (settings.feedUrl ?? '')
  const unsupported = status?.state.phase === 'unsupported'

  return (
    <>
      <SettingsSection
        title="版本状态"
        aside={view?.badge ? <span className={`app-update__badge is-${view.badge.tone}`}>{view.badge.label}</span> : undefined}
      >
        <div className="app-update">
          {status?.applyResult ? (
            <p className={`app-update__updated is-${applyResultText(status.applyResult).tone}`} role={applyResultText(status.applyResult).tone === 'danger' ? 'alert' : 'status'}>
              <span>{applyResultText(status.applyResult).text}</span>
              <button type="button" aria-label="收起" onClick={dismissApplyResult}>×</button>
            </p>
          ) : status?.launchedAfterUpdate && !updatedNoteDismissed ? (
            <p className="app-update__updated" role="status">
              <span>已更新到 {status.currentVersion}。Cursor 里的 SG Team 服务器会随之重载一次；若席位长时间未恢复，到 Cursor 的 MCP 设置里刷新 SG Team。</span>
              <button type="button" aria-label="收起" onClick={() => setUpdatedNoteDismissed(true)}>×</button>
            </p>
          ) : null}
          {view ? (
            <div className={`app-update__card is-${view.tone}`} aria-busy={view.busy}>
              {/* 英雄行：大号版本数字（当前 → 目标）+ 状态一句话在左，操作在右；状态色只在区块头的胶囊上。 */}
              <div className="app-update__hero">
                <div className="app-update__summary">
                  <div className="app-update__versions">
                    <div className="app-update__version">
                      <span className="app-update__eyebrow">当前版本</span>
                      <strong className="app-update__number">{status?.currentVersion}</strong>
                    </div>
                    {view.next ? (
                      <>
                        <span className="app-update__arrow" aria-hidden="true">→</span>
                        <div className="app-update__version is-next">
                          <span className="app-update__eyebrow">{view.next.label}</span>
                          <strong className="app-update__number">{view.next.version}</strong>
                        </div>
                      </>
                    ) : null}
                  </div>
                  <p className="app-update__headline">{view.headline}</p>
                  {view.detail ? <p className="app-update__detail" title={view.detailTitle}>{view.detail}</p> : null}
                  {view.skippedNote ? <p className="app-update__note">{view.skippedNote}</p> : null}
                  {view.snoozedNote ? <p className="app-update__note">{view.snoozedNote}</p> : null}
                </div>
                {view.actions.length && !confirm ? (
                  <div className="app-update__actions">
                    {view.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className={`app-update__button${action.kind === 'primary' ? ' is-primary' : action.kind === 'link' ? ' is-link' : ''}`}
                        disabled={action.disabled || (Boolean(busyAction) && action.id !== 'open-release')}
                        onClick={() => void run(action.id)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {view.progress ? (
                <div className="app-update__progress">
                  <div
                    className="app-update__bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={view.progress.percent}
                    aria-label="下载进度"
                  >
                    <i style={{ width: `${view.progress.percent}%` }} />
                  </div>
                  <span className="app-update__readout">
                    {view.progress.received} / {view.progress.total}{view.progress.rate ? ` · ${view.progress.rate}` : ''}
                  </span>
                </div>
              ) : null}
              {view.notes.length ? (
                <div className="app-update__notes">
                  {view.notes.slice(0, 12).map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
                </div>
              ) : null}
              {confirm ? (
                <div className="app-update__confirm" role="alertdialog" aria-label={confirm.action === 'install' ? '确认安装' : '确认回滚'}>
                  {confirm.action === 'rollback' && view.rollback ? <p>{view.rollback.note}</p> : null}
                  {confirm.gate.verdict === 'confirm' ? confirm.gate.reasons.map((reason) => <p key={reason}>{reason}</p>) : null}
                  <div className="app-update__actions">
                    <button type="button" className="app-update__button is-primary" disabled={Boolean(busyAction)} onClick={() => void confirmPending()}>
                      {confirm.action === 'install' ? '仍然安装并重启' : `回滚到 ${view.rollback?.version ?? status?.rollback?.version ?? ''} 并重启`}
                    </button>
                    <button type="button" className="app-update__button" onClick={() => setConfirm(undefined)}>取消</button>
                  </div>
                </div>
              ) : null}
              {blockedNote ? <p className="app-update__error" role="alert">{blockedNote}</p> : null}
              {view.rollback && !confirm ? (
                <div className="app-update__rollback">
                  <span>保留了 {view.rollback.version} 的备份，可以回滚。</span>
                  <button
                    type="button"
                    className="app-update__button is-link"
                    disabled={Boolean(busyAction)}
                    onClick={() => void run('rollback')}
                  >
                    回滚到 {view.rollback.version}…
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="app-update__loading">正在读取更新状态…</p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="检查设置" description="只静默检查，发现新版给一个小提醒；下载与安装都由你来点">
        <div className="app-update__settings">
          <div className="settings-row">
            <div className="settings-row__copy">
              <span className="settings-row__label">自动检查新版本</span>
              <span className="settings-row__hint">
                {unsupported ? '此平台暂不支持应用内更新' : settings.autoCheck ? '启动后约 45 秒静默检查一次，之后按间隔检查；不会自动下载' : '已关闭；可随时在上方「立即检查」'}
              </span>
            </div>
            <ToggleSwitch
              checked={settings.autoCheck}
              disabled={unsupported}
              label="自动检查新版本"
              onChange={(checked) => saveSettings({ autoCheck: checked })}
            />
          </div>
          {/* 间隔隶属于开关：关掉就收起（与自动化页的子组同一手法），不留一个灰掉的下拉。 */}
          <div className={`settings-collapse${settings.autoCheck && !unsupported ? ' is-open' : ''}`}>
            <div className="settings-collapse__inner">
              <div className="settings-subgroup">
                <div className="settings-row settings-row--sub">
                  <div className="settings-row__copy">
                    <span className="settings-row__label">检查间隔</span>
                    <span className="settings-row__hint">到点静默检查一次；连不上更新源时按 2 → 10 → 30 分钟退避重试</span>
                  </div>
                  <MenuSelect
                    ariaLabel="检查间隔"
                    value={String(settings.checkIntervalHours)}
                    options={[...UPDATE_INTERVAL_OPTIONS]}
                    disabled={unsupported || !settings.autoCheck}
                    onChange={(value) => {
                      const hours = APP_UPDATE_CHECK_INTERVAL_HOURS.find((candidate) => String(candidate) === value)
                      if (hours) saveSettings({ checkIntervalHours: hours })
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
          <details className="app-update__advanced settings-row--divided">
            <summary>自定义更新源（高级）</summary>
            <p className="app-update__advanced-hint">
              填一个静态目录地址：Windows 读目录下的 <code>latest.yml</code>，mac 读 <code>update-manifest.json</code>，安装包同目录；留空走 GitHub Releases。
            </p>
            <p className="app-update__feed-presets">
              直连 GitHub 不稳时可填入
              <button
                type="button"
                className={`app-update__preset${settings.feedUrl === APP_UPDATE_MIRROR_FEED.url ? ' is-active' : ''}`}
                title={APP_UPDATE_MIRROR_FEED.url}
                disabled={unsupported}
                onClick={() => setFeedDraft(APP_UPDATE_MIRROR_FEED.url)}
              >
                {APP_UPDATE_MIRROR_FEED.label}
              </button>
              ，保存后检查与下载都经镜像中转。
            </p>
            <div className="app-update__feed">
              <input
                type="url"
                className="app-update__feed-input"
                placeholder="https://mirror.example.com/shiguang/"
                value={feedValue}
                disabled={unsupported}
                aria-label="自定义更新源"
                onChange={(event) => setFeedDraft(event.target.value)}
              />
              <button
                type="button"
                className="app-update__button is-primary"
                disabled={unsupported || !feedDirty}
                onClick={() => {
                  const trimmed = (feedDraft ?? '').trim()
                  saveSettings(trimmed ? { feedUrl: trimmed } : { feedUrl: undefined })
                  setFeedDraft(undefined)
                }}
              >
                保存
              </button>
              {settings.feedUrl ? (
                <button
                  type="button"
                  className="app-update__button"
                  disabled={unsupported}
                  onClick={() => {
                    saveSettings({ feedUrl: undefined })
                    setFeedDraft(undefined)
                  }}
                >
                  恢复默认
                </button>
              ) : null}
            </div>
          </details>
        </div>
      </SettingsSection>
    </>
  )
}
