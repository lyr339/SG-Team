import { useState } from 'react'
import type { SettingsPageProps } from './settings-view'
import { SettingsSection } from './SettingsSection'

type AozaiProps = Pick<SettingsPageProps,
  | 'aozaiStatus' | 'aozaiBusy' | 'aozaiError' | 'aozaiProgress' | 'aozaiFeedback'
  | 'onSaveAozaiCard' | 'onClearAozaiCard' | 'onRefreshAozaiBalance' | 'onProcessAozaiToken'
>

/**
 * 奥仔服务分组：卡密保存/更换、余额刷新、手动 token 处理、处理进度与反馈。
 * 点数与单次扣点来自公开 API；字段缺失时明确显示未知，不在前端猜价格。
 */
export function SettingsAozai({
  aozaiStatus,
  aozaiBusy = false,
  aozaiError,
  aozaiProgress,
  aozaiFeedback,
  onSaveAozaiCard,
  onClearAozaiCard,
  onRefreshAozaiBalance,
  onProcessAozaiToken
}: AozaiProps): React.JSX.Element {
  const [cardCode, setCardCode] = useState('')
  const [manualToken, setManualToken] = useState('')
  const aozaiEnabled = Boolean(onSaveAozaiCard)
  const balanceText = typeof aozaiStatus?.remainingPoints === 'number'
    ? `剩余 ${aozaiStatus.remainingPoints} 点`
    : '余额待刷新'
  const chargeText = typeof aozaiStatus?.pointsPerOperation === 'number'
    ? `每次 ${aozaiStatus.pointsPerOperation} 点`
    : '单次扣点以服务端为准'

  const submitCard = async (): Promise<void> => {
    if (!onSaveAozaiCard) return
    try {
      await onSaveAozaiCard(cardCode)
      setCardCode('')
    } catch {
      // 错误由父级展示
    }
  }

  const submitManualToken = async (): Promise<void> => {
    // busy 守卫必须在按钮 disabled 之外单设：⌘/Ctrl+Enter 快捷键不经过 disabled。
    if (!onProcessAozaiToken || aozaiBusy) return
    const token = manualToken.trim()
    if (!token) return
    try {
      await onProcessAozaiToken(token)
      setManualToken('')
    } catch {
      // 错误由父级展示
    }
  }

  return (
    <SettingsSection
      title="奥仔自助服务"
      description="处理成功后按服务端规则扣点，失败不扣点。"
      aside={aozaiStatus?.saved ? (
        <span className="settings-section__meta">
          {balanceText} · {chargeText}
        </span>
      ) : undefined}
    >
      {aozaiEnabled ? (
        <div className="account-aozai settings-aozai">
          {aozaiStatus?.saved ? (
            <div className="account-aozai__card">
              <span className="account-aozai__code">{aozaiStatus.maskedCode}</span>
              <span className="account-aozai__meta">
                点数卡 · {balanceText} · {chargeText}
              </span>
              {onRefreshAozaiBalance ? (
                <button disabled={aozaiBusy} onClick={() => void onRefreshAozaiBalance()}>刷新余额</button>
              ) : null}
              {onClearAozaiCard ? (
                <button className="account-aozai__change" disabled={aozaiBusy} onClick={() => void onClearAozaiCard()}>更换卡密</button>
              ) : null}
            </div>
          ) : (
            <div className="account-aozai__setup">
              <input
                aria-label="奥仔卡密"
                value={cardCode}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                placeholder="粘贴卡密"
                disabled={aozaiBusy}
                onChange={(event) => setCardCode(event.target.value)}
              />
              <button disabled={aozaiBusy || cardCode.trim().length < 6} onClick={() => void submitCard()}>
                {aozaiBusy ? '验证中…' : '保存并验证'}
              </button>
            </div>
          )}
          {aozaiStatus?.saved && onProcessAozaiToken ? (
            <div className="account-aozai__manual">
              <div className="account-aozai__manual-copy">
                <strong>手动处理</strong>
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
                  disabled={aozaiBusy}
                  onChange={(event) => setManualToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submitManualToken()
                    }
                  }}
                />
                <button
                  disabled={aozaiBusy || !manualToken.trim()}
                  title="提交处理（⌘/Ctrl+Enter）"
                  onClick={() => void submitManualToken()}
                >
                  {aozaiBusy ? '处理中…' : '提交处理'}
                </button>
              </div>
            </div>
          ) : null}
          {aozaiBusy && aozaiProgress ? (
            <p className="account-aozai__progress">{aozaiProgress.message}</p>
          ) : null}
          {!aozaiBusy && aozaiFeedback ? (
            <p className={aozaiFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'}>{aozaiFeedback.message}</p>
          ) : null}
          {aozaiError ? <p className="account-aozai__fail">{aozaiError}</p> : null}
        </div>
      ) : (
        <p className="flow-step__hint">当前环境未接入奥仔自助服务。</p>
      )}
    </SettingsSection>
  )
}
