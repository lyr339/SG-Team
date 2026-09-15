import { useEffect, useMemo, useState } from 'react'
import type { AccountAutomationPhase } from '../../../domain/account-automation'
import { detectPastedSecret, parseCursorAccountCard, type ParsedCursorAccountCard } from '../../../domain/cursor-account-card'
import { AccountBrowserPanel } from '../lobby/AccountBrowserPanel'
import { formatFullClock } from '../format'
import type { SettingsPageProps } from './settings-view'
import { isActiveAutomationPhase } from './settings-view'
import { SettingsSection } from './SettingsSection'

type ImportSourceProps = Pick<SettingsPageProps,
  | 'accounts' | 'busy' | 'onSave' | 'onSaveCard'
  | 'onImportFromLocal' | 'onImportFromBrowser' | 'onImportFromFingerprint'
  | 'onOpenFingerprintLogin' | 'onCleanupFingerprintEnvironment'
  | 'automationSettings' | 'onSaveAutomationSettings'
  | 'bitProfiles' | 'bitProfilesMessage' | 'onRefreshBitProfiles'
  | 'roxyApiKeyStatus' | 'onSaveRoxyApiKey' | 'platform' | 'aozaiBusy'
>

interface SettingsImportSourceProps extends ImportSourceProps {
  /** 自动化相位（导入按钮在自动化活跃期禁用，与原步骤一同一判定源）。 */
  phase: AccountAutomationPhase
}

/**
 * 导入来源分组：会话浏览器宿主（贯穿整条管线）+ 获取 Token 的入口。
 * 按钮的展示条件、禁用条件、title 文案逐字继承自原 LobbyAccountTile 步骤一。
 */
export function SettingsImportSource({
  busy,
  onSave,
  onSaveCard,
  onImportFromLocal,
  onImportFromBrowser,
  onImportFromFingerprint,
  onOpenFingerprintLogin,
  onCleanupFingerprintEnvironment,
  automationSettings,
  onSaveAutomationSettings,
  bitProfiles,
  bitProfilesMessage,
  onRefreshBitProfiles,
  roxyApiKeyStatus,
  onSaveRoxyApiKey,
  platform,
  aozaiBusy = false,
  phase
}: SettingsImportSourceProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  // 平台仅决定「系统浏览器」宿主是否展示（Keychain/Apple Events 是 macOS 专属）；
  // 指纹浏览器提供方与平台无关，恒 Roxy（比特已全面退役）。
  const resolvedPlatform = platform
    ?? (typeof document !== 'undefined' ? document.documentElement.dataset.platform : undefined)
  const isWindows = resolvedPlatform === 'win32'
  const fingerprintProviderLabel = 'Roxy'

  return (
    <>
      {/* 导入来源：选定后贯穿整条管线（获取 Token → 奥仔后换发 → 删除官网账号同一宿主） */}
      {automationSettings && onSaveAutomationSettings ? (
        <SettingsSection
          title="会话浏览器"
          description="Token 获取、刷新与账号处理沿用同一来源。"
          aside={<span className="settings-section__meta">贯穿全流程</span>}
        >
          <AccountBrowserPanel
            settings={automationSettings}
            disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
            isWindows={isWindows}
            providerLabel={fingerprintProviderLabel}
            profiles={bitProfiles}
            profilesMessage={bitProfilesMessage}
            apiKeyStatus={roxyApiKeyStatus}
            onSettingsChange={onSaveAutomationSettings}
            onRefreshProfiles={onRefreshBitProfiles}
            onSaveApiKey={onSaveRoxyApiKey}
            onCleanupEnvironment={onCleanupFingerprintEnvironment}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="获取 Token"
        description="读取所选浏览器的登录会话；浏览器刷新需要联网。"
      >
        <div className="lobby-account__quick settings-import-actions" aria-label="获取账号来源">
          {onImportFromFingerprint && (automationSettings?.browserHost ?? 'fingerprint') === 'fingerprint' ? (
            <button className="lobby-account__quick-primary" disabled={busy || !automationSettings?.bitProfileId}
              title={automationSettings?.bitProfileId
                ? '打开选定的指纹浏览器窗口读取登录态 Token——导入后该账号自动绑定此窗口，自动化固定在此窗口执行'
                : '请先在上方选择指纹浏览器窗口'}
              onClick={() => void onImportFromFingerprint()}>
              {busy ? '导入中…' : '从指纹浏览器导入（推荐）'}
            </button>
          ) : null}
          {/* 提前登录入口：开窗导航 cursor.com，用户登录后 cookie 落 profile；窗口不自动关。
              自动化活跃阶段必须禁用——此时导航的正是自动化链在用的 tab，
              会破坏就绪探测与 token 轮换基准（与窗口选择器同一禁用条件）。 */}
          {onOpenFingerprintLogin && (automationSettings?.browserHost ?? 'fingerprint') === 'fingerprint' ? (
            <button disabled={busy || aozaiBusy || isActiveAutomationPhase(phase) || !automationSettings?.bitProfileId}
              title={automationSettings?.bitProfileId
                ? '打开选定的指纹浏览器窗口并进入 cursor.com——未登录可先登录（登录态保存到该窗口，之后导入直接读取）'
                : '请先在上方选择指纹浏览器窗口'}
              onClick={() => void onOpenFingerprintLogin()}>
              {busy ? '打开中…' : '打开网页登录'}
            </button>
          ) : null}
          {/* 系统浏览器导入依赖 Keychain（macOS 专属）；Windows 上即使旧设置残留 external 也不展示 */}
          {onImportFromBrowser && !isWindows && (automationSettings?.browserHost ?? 'fingerprint') === 'external' ? (
            <button disabled={busy} onClick={() => void onImportFromBrowser()}
              title="读取本机外部浏览器已登录的 cursor.com 会话">
              {busy ? '导入中…' : '从浏览器导入 Token'}
            </button>
          ) : null}
          {onImportFromLocal ? (
            <button disabled={busy} onClick={() => void onImportFromLocal()}
              title="读取本机 Cursor 客户端当前登录的会话">
              {busy ? '获取中…' : '自动获取本机 Token'}
            </button>
          ) : null}
          <button className={adding ? 'is-active' : ''} onClick={() => setAdding((value) => !value)}
            title="粘贴账号卡号（邮箱----邮箱密码----Cursor密码----辅邮----辅邮密码----Token）或单独的 Session Token">
            {adding ? '收起手动添加' : '手动粘贴卡号 / Token'}
          </button>
        </div>
        {!adding ? (
          <p className="lobby-account__note">Token 仅在本机加密保存，不会写入明文存储、日志或再次显示；读取所选浏览器的登录会话；浏览器刷新需要联网。</p>
        ) : null}
        {adding ? <SettingsManualAddForm busy={busy} onSave={onSave} onSaveCard={onSaveCard} /> : null}
      </SettingsSection>
    </>
  )
}

/** 粘贴内容的识别结果：空 / 单独 Token / 合法卡号（含预览信息）/ 卡号但字段非法。 */
type SecretDetection =
  | { kind: 'empty' }
  | { kind: 'token' }
  | { kind: 'card'; card: ParsedCursorAccountCard }
  | { kind: 'card-error'; message: string }

/**
 * 手动粘贴表单：一个输入框自动识别卡号（邮箱----…----Token）与单独 Token。
 * 卡号识别成功即出预览（邮箱/有效期/辅邮），备注自动跟随邮箱（可改）；
 * 解析与主进程入库共用同一领域实现，预览所见即所得。
 */
function SettingsManualAddForm({
  busy,
  onSave,
  onSaveCard
}: Pick<SettingsPageProps, 'busy' | 'onSave' | 'onSaveCard'>): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [labelTouched, setLabelTouched] = useState(false)
  const [secret, setSecret] = useState('')

  const detection = useMemo<SecretDetection>(() => {
    const kind = detectPastedSecret(secret)
    if (kind === 'empty') return { kind: 'empty' }
    if (kind === 'token') return { kind: 'token' }
    try {
      return { kind: 'card', card: parseCursorAccountCard(secret) }
    } catch (reason) {
      return { kind: 'card-error', message: reason instanceof Error ? reason.message : String(reason) }
    }
  }, [secret])

  // 卡号识别成功且用户未手动改过备注时，备注跟随邮箱（用户一改即不再覆盖）；
  // 离开卡号形态（清空/改贴单独 Token）时清掉自动填充，避免旧邮箱残留误导保存。
  useEffect(() => {
    if (labelTouched) return
    if (detection.kind === 'card') setLabel(detection.card.label)
    else if (label) setLabel('')
  }, [detection, labelTouched, label])

  const isCard = detection.kind === 'card'
  const cardExpired = isCard && detection.card.expiresAt !== undefined && detection.card.expiresAt <= Date.now()
  const canSubmit = isCard
    ? Boolean(onSaveCard) && !busy
    : detection.kind === 'token' && Boolean(label.trim()) && secret.trim().length >= 8 && !busy

  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn'; message: string }>()

  const submit = async (): Promise<void> => {
    setFeedback(undefined)
    try {
      if (detection.kind === 'card' && onSaveCard) {
        const result = await onSaveCard({ card: secret })
        const base = result.outcome === 'updated'
          ? `已更新账号「${result.label}」的 Token 与登录凭据`
          : `已导入账号「${result.label}」；登录凭据已加密保存，可用于自动登录`
        if (result.tokenRefreshed) {
          setFeedback({ tone: 'ok', message: `${base}；卡内 Token 已过期，已用凭据自动登录刷新` })
        } else if (result.loginError) {
          setFeedback({ tone: 'warn', message: `${base}。卡内 Token 已过期，自动登录未成功（可在账号卡片点「重新登录」重试）：${result.loginError}` })
        } else {
          setFeedback({ tone: 'ok', message: base })
        }
      } else if (detection.kind === 'token') {
        await onSave({ label, token: secret })
      } else {
        return
      }
      setLabel('')
      setSecret('')
      setLabelTouched(false)
    } catch {
      // 错误由父级在卡片底部展示，避免回显凭据。
    }
  }

  return (
    <div className="account-add-form settings-add-form">
      <label>
        <span>卡号 / Token</span>
        <textarea
          value={secret}
          rows={3}
          maxLength={16384}
          autoComplete="off"
          spellCheck={false}
          placeholder="粘贴卡号：邮箱----邮箱密码----Cursor密码----辅邮----辅邮密码----Token；或单独粘贴 Token"
          disabled={busy}
          onChange={(event) => { setSecret(event.target.value); setFeedback(undefined) }}
        />
      </label>
      {detection.kind === 'card' ? (
        <div className="settings-card-preview" data-expired={cardExpired || undefined}>
          <span>识别为卡号：{detection.card.email}</span>
          <small>
            {detection.card.expiresAt
              ? `Token 有效期至 ${formatFullClock(detection.card.expiresAt).split(' ')[0]}${cardExpired ? '（已过期，保存后可自动登录刷新）' : ''}`
              : 'Token 有效期未知'}
            {detection.card.recoveryEmail ? ' · 含辅邮' : ''} · 密码凭据随账号加密保存
          </small>
        </div>
      ) : null}
      {detection.kind === 'card-error' ? <p className="settings-add-form__error" role="alert">{detection.message}</p> : null}
      <label>
        <span>账号备注</span>
        <input
          value={label}
          maxLength={80}
          placeholder={isCard ? '默认为卡号邮箱' : '例如：工作账号 A'}
          disabled={busy}
          onChange={(event) => { setLabel(event.target.value); setLabelTouched(true) }}
        />
      </label>
      <small>明文不会写入 SQLite、日志或再次显示。</small>
      {feedback ? (
        <p className={feedback.tone === 'warn' ? 'settings-add-form__warn' : 'settings-add-form__ok'} role="status">{feedback.message}</p>
      ) : null}
      <button className="lobby-account__save" disabled={!canSubmit} onClick={() => void submit()}>
        {busy ? '保存中…' : isCard ? '导入卡号' : '保存账号'}
      </button>
    </div>
  )
}
