import { useEffect, useState } from 'react'
import type { AppUpdateSettings, AppUpdateStatus, UpdateGate } from '../../../domain/app-update'
import { APP_UPDATE_CHECK_INTERVAL_HOURS, normalizeAppUpdateSettings } from '../../../domain/app-update'
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
  | 'skipAppUpdate' | 'unskipAppUpdate' | 'snoozeAppUpdate' | 'dismissAppUpdateFailure' | 'saveAppUpdateSettings'
  | 'openAppUpdateReleasePage' | 'onAppUpdateStatus'
>

function updateApi(): UpdateApi | undefined {
  const api = typeof window !== 'undefined' ? window.sgDesktop : undefined
  return api && typeof api.getAppUpdateStatus === 'function' ? api : undefined
}

/**
 * 设置页「软件更新」组：手动组件。状态卡 + 检查设置。主进程只推状态；这里只发意图，
 * 不经 App.tsx 传 props（自取 window.sgDesktop），与在途工作零冲突。
 */
export function SettingsUpdate({ initialStatus, now = () => Date.now() }: SettingsUpdateProps): React.JSX.Element {
  const [status, setStatus] = useState<AppUpdateStatus | undefined>(initialStatus)
  const [confirmGate, setConfirmGate] = useState<UpdateGate>()
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
          if (result.gate.verdict === 'confirm') setConfirmGate(result.gate)
          else if (result.gate.verdict === 'block') setBlockedNote(result.gate.reasons.join(' '))
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

  const confirmInstall = async (): Promise<void> => {
    const api = updateApi()
    if (!api) return
    setConfirmGate(undefined)
    setBusyAction('install')
    try {
      const result = await api.installAppUpdate({ confirmed: true })
      setStatus(result.status)
      if (result.gate.verdict === 'block') setBlockedNote(result.gate.reasons.join(' '))
    } catch (reason) {
      setBlockedNote(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  const feedValue = feedDraft ?? settings.feedUrl ?? ''
  const feedDirty = feedDraft !== undefined && feedDraft.trim() !== (settings.feedUrl ?? '')
  const unsupported = status?.state.phase === 'unsupported'

  return (
    <>
      <SettingsSection
        title="软件更新"
        description={status ? `当前版本 ${status.currentVersion}` : undefined}
        aside={view && view.tone === 'accent' && !view.skippedNote ? <span className="app-update__badge">有新版本</span> : undefined}
      >
        <div className="app-update">
          {status?.launchedAfterUpdate && !updatedNoteDismissed ? (
            <p className="app-update__updated" role="status">
              <span>已更新到 {status.currentVersion}。Cursor 里的 SG Team 服务器会随之重载一次；若席位长时间未恢复，到 Cursor 的 MCP 设置里刷新 SG Team。</span>
              <button type="button" aria-label="收起" onClick={() => setUpdatedNoteDismissed(true)}>×</button>
            </p>
          ) : null}
          {view ? (
            <div className={`app-update__card is-${view.tone}${view.busy ? ' is-busy' : ''}`} aria-busy={view.busy}>
              <div className="app-update__status">
                <i className="app-update__dot" aria-hidden="true" />
                <div className="app-update__copy">
                  <strong className="app-update__headline">{view.headline}</strong>
                  {view.detail ? <span className="app-update__detail">{view.detail}</span> : null}
                  {view.skippedNote ? <span className="app-update__note">{view.skippedNote}</span> : null}
                  {view.snoozedNote ? <span className="app-update__note">{view.snoozedNote}</span> : null}
                </div>
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
              {confirmGate?.verdict === 'confirm' ? (
                <div className="app-update__confirm" role="alertdialog" aria-label="确认安装">
                  {confirmGate.reasons.map((reason) => <p key={reason}>{reason}</p>)}
                  <div className="app-update__actions">
                    <button type="button" className="app-update__button is-primary" disabled={Boolean(busyAction)} onClick={() => void confirmInstall()}>仍然安装并重启</button>
                    <button type="button" className="app-update__button" onClick={() => setConfirmGate(undefined)}>取消</button>
                  </div>
                </div>
              ) : null}
              {blockedNote ? <p className="app-update__error" role="alert">{blockedNote}</p> : null}
              {view.actions.length && !confirmGate ? (
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
          <div className="settings-row settings-row--sub">
            <div className="settings-row__copy">
              <span className="settings-row__label">检查间隔</span>
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
          <details className="app-update__advanced settings-row--divided">
            <summary>自定义更新源（高级）</summary>
            <p className="app-update__advanced-hint">
              填一个静态目录地址（目录下有 <code>latest.yml</code> 与安装包），国内镜像或本机验收用；留空走 GitHub Releases。
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
