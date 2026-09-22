import { useState } from 'react'
import { PROCESSING_PROVIDER_IDS, PROCESSING_PROVIDER_LABEL } from '../../../domain/processing-provider'
import type { SettingsPageProps } from './settings-view'
import { SettingsSection } from './SettingsSection'

type ProcessingProps = Pick<SettingsPageProps,
  | 'processingStatuses' | 'processingBusy' | 'processingError' | 'processingProgress' | 'processingFeedback'
  | 'onSaveProcessingCredential' | 'onClearProcessingCredential' | 'onRefreshProcessingBalance' | 'onProcessToken'
  | 'automationSettings' | 'onSaveAutomationSettings'
>

/** 处理服务分组：选择服务商、分别保存卡密、刷新余额与手动处理。 */
export function SettingsAozai({
  processingStatuses,
  processingBusy = false,
  processingError,
  processingProgress,
  processingFeedback,
  onSaveProcessingCredential,
  onClearProcessingCredential,
  onRefreshProcessingBalance,
  onProcessToken,
  automationSettings,
  onSaveAutomationSettings
}: ProcessingProps): React.JSX.Element {
  const [cardCode, setCardCode] = useState('')
  const [manualToken, setManualToken] = useState('')
  const providerId = automationSettings?.processingProvider ?? 'aozai'
  const providerLabel = PROCESSING_PROVIDER_LABEL[providerId]
  const status = processingStatuses?.[providerId]
  const enabled = Boolean(onSaveProcessingCredential)
  const balanceText = typeof status?.remaining === 'number'
    ? `剩余 ${status.remaining} ${status.unit === 'uses' ? '次' : '点'}`
    : '余额待刷新'
  const chargeText = typeof status?.costPerOperation === 'number'
    ? `每次 ${status.costPerOperation} ${status.unit === 'uses' ? '次' : '点'}`
    : '单次扣费以服务端为准'

  const selectProvider = (next: typeof providerId): void => {
    setCardCode('')
    setManualToken('')
    if (automationSettings && onSaveAutomationSettings) {
      void onSaveAutomationSettings({ ...automationSettings, processingProvider: next })
    }
  }

  const submitCard = async (): Promise<void> => {
    if (!onSaveProcessingCredential) return
    try {
      await onSaveProcessingCredential(providerId, cardCode)
      setCardCode('')
    } catch {
      // 错误由父级展示
    }
  }

  const submitManualToken = async (): Promise<void> => {
    if (!onProcessToken || processingBusy) return
    const token = manualToken.trim()
    if (!token) return
    try {
      await onProcessToken(providerId, token)
      setManualToken('')
    } catch {
      // 错误由父级展示
    }
  }

  return (
    <SettingsSection
      title="处理服务"
      description="选择账号处理服务；每家卡密、余额和认证会话完全隔离。"
      aside={status?.saved ? <span className="settings-section__meta">{providerLabel} · {balanceText} · {chargeText}</span> : undefined}
    >
      {enabled ? (
        <div className="account-aozai settings-aozai">
          <div className="processing-provider-tabs" role="radiogroup" aria-label="账号处理服务">
            {PROCESSING_PROVIDER_IDS.map((id) => (
              <button
                type="button"
                role="radio"
                aria-checked={providerId === id}
                className={providerId === id ? 'is-active' : ''}
                disabled={processingBusy}
                onClick={() => selectProvider(id)}
                key={id}
              >
                <strong>{PROCESSING_PROVIDER_LABEL[id]}</strong>
                <small>{processingStatuses?.[id]?.saved ? '已配置' : '未配置'}</small>
              </button>
            ))}
          </div>

          {providerId === 'henxin' ? (
            <p className="processing-provider-note">痕心卡密采用单网页会话；拾光仅在保存卡密或主动刷新余额时登录，自动处理直接使用机器 API。</p>
          ) : null}

          {status?.saved ? (
            <div className="account-aozai__card">
              <span className="account-aozai__code">{status.maskedCode}</span>
              <span className="account-aozai__meta">{providerLabel} · {balanceText} · {chargeText}</span>
              {onRefreshProcessingBalance ? (
                <button disabled={processingBusy} onClick={() => void onRefreshProcessingBalance(providerId)}>刷新余额</button>
              ) : null}
              {onClearProcessingCredential ? (
                <button className="account-aozai__change" disabled={processingBusy} onClick={() => void onClearProcessingCredential(providerId)}>更换卡密</button>
              ) : null}
            </div>
          ) : (
            <div className="account-aozai__setup">
              <input
                aria-label={`${providerLabel}卡密`}
                value={cardCode}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                placeholder={`粘贴${providerLabel}卡密`}
                disabled={processingBusy}
                onChange={(event) => setCardCode(event.target.value)}
              />
              <button disabled={processingBusy || cardCode.trim().length < 6} onClick={() => void submitCard()}>
                {processingBusy ? '验证中…' : '保存并验证'}
              </button>
            </div>
          )}

          {status?.saved && onProcessToken ? (
            <div className="account-aozai__manual">
              <div className="account-aozai__manual-copy">
                <strong>手动处理 · {providerLabel}</strong>
                <span className="account-aozai__manual-hint">
                  粘贴任意 Session Token 直接提交，独立于自动化——不触发账号加固、删除或换号；Token 不保存。
                </span>
              </div>
              <div className="account-aozai__manual-input">
                <textarea
                  aria-label="手动处理的 Session Token"
                  value={manualToken}
                  rows={3}
                  maxLength={16384}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="user_xxx::eyJhbGciOi… 或完整 JWT"
                  disabled={processingBusy}
                  onChange={(event) => setManualToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submitManualToken()
                    }
                  }}
                />
                <button
                  disabled={processingBusy || !manualToken.trim()}
                  title={`提交给${providerLabel}（⌘/Ctrl+Enter）`}
                  onClick={() => void submitManualToken()}
                >
                  {processingBusy ? '处理中…' : `提交给${providerLabel}`}
                </button>
              </div>
            </div>
          ) : null}
          {processingBusy && processingProgress?.providerId === providerId ? (
            <p className="account-aozai__progress">{processingProgress.message}</p>
          ) : null}
          {!processingBusy && processingFeedback?.providerId === providerId ? (
            <p className={processingFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'}>{processingFeedback.message}</p>
          ) : null}
          {processingError?.providerId === providerId ? <p className="account-aozai__fail">{processingError.message}</p> : null}
        </div>
      ) : (
        <p className="flow-step__hint">当前环境未接入账号处理服务。</p>
      )}
    </SettingsSection>
  )
}
