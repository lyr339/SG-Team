import { useState } from 'react'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import type { SettingsPageProps } from './settings-view'
import { isActiveAutomationPhase } from './settings-view'
import { SettingsSection } from './SettingsSection'

type MaintenanceProps = Pick<SettingsPageProps,
  | 'cursorUpdatePreferences' | 'cursorUpdateBusy' | 'cursorUpdateError'
  | 'onSetCursorAutoUpdateDisabled' | 'onSetModelDataPolicyAutoAcknowledge'
  | 'automationSettings' | 'automationRun'
  | 'switchPumpStatus' | 'switchPumpBusy' | 'switchPumpFeedback'
  | 'onEnsureSwitchPump' | 'onRemoveSwitchPump'
>

function updateModeLabel(mode: string | undefined, disabled: boolean): string {
  if (disabled || mode === 'none') return '已关闭'
  if (mode === 'manual') return '手动'
  if (mode === 'start') return '启动时'
  return '默认'
}

/**
 * Cursor 本机维护分组：自动更新开关 + 受限模型数据政策自动确认 + 切号补丁。
 * 行结构与自动化分组同一语言：左文案（标题 + 说明），右控件，右缘对齐。
 */
export function SettingsMaintenance({
  cursorUpdatePreferences,
  cursorUpdateBusy = false,
  cursorUpdateError,
  onSetCursorAutoUpdateDisabled,
  onSetModelDataPolicyAutoAcknowledge,
  automationSettings,
  automationRun,
  switchPumpStatus,
  switchPumpBusy = false,
  switchPumpFeedback,
  onEnsureSwitchPump,
  onRemoveSwitchPump
}: MaintenanceProps): React.JSX.Element | null {
  const [policyBusy, setPolicyBusy] = useState(false)
  const [policyFeedback, setPolicyFeedback] = useState<{ ok: boolean; message: string }>()
  const phase = automationRun?.phase ?? 'idle'

  const externalCompatiblePump = switchPumpStatus?.kind === 'installed' && switchPumpStatus.managed === false
  const pumpInstalled = switchPumpStatus?.kind === 'installed'
  const pumpPort = switchPumpStatus?.config?.port
  // 切号补丁建模为开关：开 = 无感换号能力已就位。两种不可操作态用禁用表达——
  // 外部工具管理的兼容补丁（开态禁用：拾光只复用，不卸载）与不支持的版本（关态禁用）。
  const pumpDisabled = switchPumpBusy
    || externalCompatiblePump
    || switchPumpStatus?.kind === 'unsupported'
    || switchPumpStatus?.kind === 'unavailable'
    || (pumpInstalled && !onRemoveSwitchPump)
  const switchPumpHint = switchPumpBusy
    ? '正在处理切号补丁…'
    : externalCompatiblePump
      ? `已安装（端口 ${pumpPort ?? '—'}）；由其他工具管理，拾光只复用、不覆盖或卸载`
      : pumpInstalled
        ? `已安装（端口 ${pumpPort ?? '—'}）；运行中的 Cursor 已具备无感换号能力`
        : switchPumpStatus?.kind === 'not-installed'
          ? switchPumpStatus.managed
            ? '补丁需要更新；重新安装后重启一次 Cursor 即可启用无感换号'
            : '未安装；安装后重启一次 Cursor 即可启用无感换号'
          : switchPumpStatus?.kind === 'unsupported'
            ? '当前 Cursor 版本装不了切号补丁'
            : '切号补丁状态未检测'

  if (!(onSetCursorAutoUpdateDisabled && cursorUpdatePreferences) && !onSetModelDataPolicyAutoAcknowledge && !onEnsureSwitchPump) {
    return null
  }

  return (
    <SettingsSection
      title="Cursor 本机维护"
      description={cursorUpdatePreferences ? 'settings.json' : 'Roxy profile'}
      descriptionTitle={cursorUpdatePreferences?.settingsPath}
    >
      <div className="settings-maintenance">
        {onSetCursorAutoUpdateDisabled && cursorUpdatePreferences ? (
          <div className="settings-row">
            <div className="settings-row__copy">
              <span className="settings-row__label">关闭 Cursor 自动更新</span>
              <span className="settings-row__hint">
                {cursorUpdatePreferences.autoUpdateDisabled
                  ? '已关闭自动更新；新版本发布后需手动安装'
                  : `当前更新策略：${updateModeLabel(cursorUpdatePreferences.updateMode, false)}；关闭后需手动升级`}
              </span>
            </div>
            <ToggleSwitch
              checked={cursorUpdatePreferences.autoUpdateDisabled}
              disabled={cursorUpdateBusy}
              label="关闭 Cursor 自动更新"
              onChange={(checked) => void onSetCursorAutoUpdateDisabled(checked)}
            />
          </div>
        ) : null}
        {onSetModelDataPolicyAutoAcknowledge && automationSettings ? (
          <div className="settings-row settings-row--divided">
            <div className="settings-row__copy">
              <span className="settings-row__label">自动确认受限模型数据政策</span>
              <span className="settings-row__hint">
                {policyBusy ? '正在更新受限模型政策…' : '新账号导入与自动化预检时查询官网状态，缺失才确认'}
              </span>
            </div>
            <ToggleSwitch
              checked={automationSettings.autoAcknowledgeModelDataPolicies !== false}
              disabled={policyBusy || isActiveAutomationPhase(phase)}
              label="自动确认受限模型数据政策"
              title={!automationSettings.bitProfileId ? '关闭可直接生效；重新开启前请先在「导入来源」选择默认窗口' : undefined}
              onChange={(enabled) => {
                setPolicyBusy(true)
                setPolicyFeedback(undefined)
                void onSetModelDataPolicyAutoAcknowledge(enabled)
                  .then((result) => setPolicyFeedback({ ok: true, message: result.message }))
                  .catch((reason: unknown) => setPolicyFeedback({
                    ok: false,
                    message: reason instanceof Error ? reason.message : String(reason)
                  }))
                  .finally(() => setPolicyBusy(false))
              }}
            />
          </div>
        ) : null}
        {policyFeedback ? (
          <p className={policyFeedback.ok ? 'cursor-maintenance__ok' : 'cursor-maintenance__error'} role={policyFeedback.ok ? 'status' : 'alert'}>
            {policyFeedback.message}
          </p>
        ) : null}
        {onEnsureSwitchPump ? (
          <div className={`settings-row settings-row--divided cursor-maintenance__switch-pump${externalCompatiblePump ? ' is-compatible' : pumpInstalled ? ' is-installed' : ' is-inactive'}`}>
            <div className="settings-row__copy">
              <span className="settings-row__label">切号补丁（无感换号）</span>
              <span className="settings-row__hint">{switchPumpHint}</span>
            </div>
            <ToggleSwitch
              checked={pumpInstalled}
              disabled={pumpDisabled}
              label="切号补丁（无感换号）"
              onChange={(checked) => {
                if (checked) void onEnsureSwitchPump()
                else void onRemoveSwitchPump?.()
              }}
            />
          </div>
        ) : null}
        {switchPumpStatus?.message && (switchPumpStatus.kind === 'unsupported' || switchPumpStatus.kind === 'unavailable') ? (
          <p className="cursor-maintenance__hint">{switchPumpStatus.message}</p>
        ) : null}
        {switchPumpFeedback ? (
          <p className={switchPumpFeedback.ok ? 'cursor-maintenance__ok' : 'cursor-maintenance__error'} role={switchPumpFeedback.ok ? 'status' : 'alert'}>
            {switchPumpFeedback.message}
          </p>
        ) : null}
        {cursorUpdateError ? <p className="cursor-maintenance__error">{cursorUpdateError}</p> : null}
      </div>
    </SettingsSection>
  )
}
