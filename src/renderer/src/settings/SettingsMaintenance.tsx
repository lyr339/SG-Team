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
 * Cursor 本机维护分组：自动更新开关 + 受限模型数据政策自动确认。
 * 全部结构与文案逐字继承自原 LobbyAccountTile 底部维护块。
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
  const switchPumpTitle = switchPumpStatus?.kind === 'installed'
    ? externalCompatiblePump
      ? `兼容切号补丁可用（端口 ${switchPumpStatus.config?.port ?? '—'}）`
      : `拾光切号补丁已安装（端口 ${switchPumpStatus.config?.port ?? '—'}）`
    : switchPumpStatus?.kind === 'not-installed'
      ? switchPumpStatus.managed
        ? '切号补丁需要更新'
        : '切号补丁未安装'
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
      <div className="cursor-maintenance settings-maintenance">
        {onSetCursorAutoUpdateDisabled && cursorUpdatePreferences ? (
          <div className="cursor-maintenance__action">
            <ToggleSwitch
              checked={cursorUpdatePreferences.autoUpdateDisabled}
              disabled={cursorUpdateBusy}
              onChange={(checked) => void onSetCursorAutoUpdateDisabled(checked)}
            >
              关闭 Cursor 自动更新
            </ToggleSwitch>
            <em>{updateModeLabel(cursorUpdatePreferences.updateMode, cursorUpdatePreferences.autoUpdateDisabled)}</em>
          </div>
        ) : null}
        {onSetModelDataPolicyAutoAcknowledge && automationSettings ? (
          <div className="cursor-maintenance__action cursor-maintenance__policy">
            <ToggleSwitch
              checked={automationSettings.autoAcknowledgeModelDataPolicies !== false}
              disabled={policyBusy || isActiveAutomationPhase(phase)}
              title={!automationSettings.bitProfileId ? '关闭可直接生效；重新开启前请先在「导入来源」选择默认窗口' : '新账号导入与自动化预检时查询官网状态，缺失才确认'}
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
            >
              {policyBusy ? '正在更新受限模型政策' : '自动确认受限模型数据政策'}
            </ToggleSwitch>
            <em>{automationSettings.autoAcknowledgeModelDataPolicies !== false ? '自动' : '关闭'}</em>
          </div>
        ) : null}
        {policyFeedback ? (
          <p className={policyFeedback.ok ? 'cursor-maintenance__ok' : 'cursor-maintenance__error'} role={policyFeedback.ok ? 'status' : 'alert'}>
            {policyFeedback.message}
          </p>
        ) : null}
        {onEnsureSwitchPump ? (
          <div className={`cursor-maintenance__action cursor-maintenance__switch-pump${externalCompatiblePump ? ' is-compatible' : switchPumpStatus?.kind === 'installed' ? ' is-installed' : ' is-inactive'}`}>
            <span className="cursor-maintenance__switch-pump-copy">
              <span className="cursor-maintenance__switch-pump-title"><i aria-hidden="true" />{switchPumpBusy ? '正在处理切号补丁…' : switchPumpTitle}</span>
              <small>{externalCompatiblePump
                ? '由其他工具管理；拾光只复用，不覆盖或卸载'
                : switchPumpStatus?.kind === 'installed'
                  ? '运行中的 Cursor 已具备无感换号能力'
                  : '安装后重启一次 Cursor 即可启用无感换号'}</small>
            </span>
            {externalCompatiblePump ? (
              <em className="is-compatible">兼容可用</em>
            ) : switchPumpStatus?.kind === 'installed' ? (
              <button type="button" className="cursor-maintenance__pump-action is-remove" disabled={switchPumpBusy || !onRemoveSwitchPump} onClick={() => void onRemoveSwitchPump?.()}>移除</button>
            ) : (
              <button type="button" className="cursor-maintenance__pump-action" disabled={switchPumpBusy || switchPumpStatus?.kind === 'unsupported' || switchPumpStatus?.kind === 'unavailable'} onClick={() => void onEnsureSwitchPump()}>安装</button>
            )}
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
