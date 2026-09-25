import { useCallback, useEffect, useRef, useState } from 'react'
import type { CursorAccountMetadata } from '../../../domain/cursor-account'
import { RefreshIcon } from '../UiIcons'
import { MenuSelect, type MenuSelectOption } from '../lobby/MenuSelect'
import { AccountActionsMenu, type AccountMenuAction } from './AccountActionsMenu'
import type { SettingsPageProps } from './settings-view'
import {
  accountMembershipPlanFor,
  accountStatusLineFor,
  liveSwitchAvailability,
  profileDisplayName
} from './settings-view'
import { SettingsSection } from './SettingsSection'
import { PROCESSING_PROVIDER_LABEL } from '../../../domain/processing-provider'

type AccountsProps = Pick<SettingsPageProps,
  | 'accounts' | 'busy' | 'onSave' | 'onSelect' | 'onRemove' | 'onRestartWithAccount' | 'onSwitchLiveAccount' | 'switchPumpStatus'
  | 'runtimeMatch' | 'membership' | 'accountMemberships' | 'onRefreshMembership'
  | 'processingStatuses' | 'processingBusy' | 'processingProgress' | 'processingError' | 'processingFeedback' | 'onProcessAccount'
  | 'automationSettings'
  | 'bitProfiles' | 'onSetAccountFingerprintProfile' | 'onReloginAccount' | 'onStartProUpgrade' | 'proUpgradeFeedback'
>

interface SettingsAccountsProps extends AccountsProps {
  active?: boolean
  /** 空列表时「前往导入来源」的跨组导航（由 SettingsPage 注入）。 */
  onNavigateToImport?: () => void
}

/** 二次确认的存活时长：与「一键清理」同一节拍——够看清确认文案与提示，忘了就自动收回。 */
const CONFIRM_TTL_MS = 10_000

/** 待二次确认的破坏性动作：整张列表同一时刻只有一个。 */
interface ArmedAction { kind: 'remove' | 'restart'; accountId: string }

/** 正在执行的切换：只有发起那一行换「切换中…」，其他行只是禁用。 */
interface SwitchInFlight { kind: 'live' | 'restart'; accountId: string }

/**
 * 账号行的窗口绑定选项：「默认窗口」+ 当前窗口列表。
 * 已绑定但窗口不在列表（Roxy 未连/窗口被删）时保留当前绑定项——如实显示，不吞掉。
 */
function windowBindingOptions(
  account: CursorAccountMetadata,
  profiles: SettingsPageProps['bitProfiles']
): MenuSelectOption[] {
  const options: MenuSelectOption[] = [
    { value: '', label: '默认窗口' },
    ...(profiles ?? []).map((profile) => ({
      value: profile.id,
      label: profileDisplayName(profiles, profile.id)
    }))
  ]
  const bound = account.fingerprintProfileId
  if (bound && !options.some((option) => option.value === bound)) {
    options.push({ value: bound, label: profileDisplayName(profiles, bound) })
  }
  return options
}

/**
 * 账号分组：登录一致性状态行 + 已保存账号列表。
 *
 * 列表一账号一行，行是名册式的两行文本：首行邮箱（点击设为当前）+ 当前胶囊，
 * 次行 Token 与元信息 chip（档位 / 待对齐 / 窗口绑定）；头像跨两行，操作列右缘锚定。
 * 元信息含可交互控件（刷新、下拉），所以不在身份按钮之内。
 * 处理器、禁用条件与文案继承自原 LobbyAccountTile；二次确认收成「同一时刻只问一件事」
 * 并会自动收回（见 CONFIRM_TTL_MS），「切换中…」只落在发起切换的那一行。
 */
export function SettingsAccounts({
  active = true,
  accounts,
  busy,
  onSelect,
  onRemove,
  onRestartWithAccount,
  onSwitchLiveAccount,
  switchPumpStatus,
  runtimeMatch,
  membership,
  accountMemberships,
  onRefreshMembership,
  processingStatuses,
  processingBusy = false,
  processingProgress,
  processingError,
  processingFeedback,
  onProcessAccount,
  automationSettings,
  onNavigateToImport,
  bitProfiles,
  onSetAccountFingerprintProfile,
  onReloginAccount,
  onStartProUpgrade,
  proUpgradeFeedback
}: SettingsAccountsProps): React.JSX.Element {
  // 二次确认（删除 / 切换并重启）是一个转瞬的提问：同一时刻只问一件事，再点别处、Esc、
  // 10s 未决或切走分组都收回——不会留下一枚「确认」等着几分钟后被误点。
  const [armed, setArmed] = useState<ArmedAction | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disarm = useCallback((): void => { clearTimeout(armTimer.current); setArmed(null) }, [])
  const arm = (next: ArmedAction): void => {
    clearTimeout(armTimer.current)
    setArmed(next)
    armTimer.current = setTimeout(() => setArmed(null), CONFIRM_TTL_MS)
  }
  const isArmed = (kind: ArmedAction['kind'], accountId: string): boolean =>
    armed?.kind === kind && armed.accountId === accountId
  useEffect(() => () => clearTimeout(armTimer.current), [])
  useEffect(() => { if (!active) disarm() }, [active, disarm])
  useEffect(() => {
    if (!armed) return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') disarm() }
    // 按在待确认按钮之外的任何地方都算「不了」——包括同一行的其他按钮与「⋯」。
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.account-row__actions > .is-confirming')) disarm()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [armed, disarm])

  // 面板 busy 是全局的（导入 / 删除 / 设为当前也会置忙）：记住是哪一行发起了哪种切换，
  // 「切换中…」只落在那一枚按钮上，其他行保持原文案、仅禁用。busy 归零即清。
  const [switching, setSwitching] = useState<SwitchInFlight | null>(null)
  useEffect(() => { if (!busy) setSwitching(null) }, [busy])
  const isSwitching = (kind: SwitchInFlight['kind'], accountId: string): boolean =>
    busy && switching?.kind === kind && switching.accountId === accountId

  const [refreshingMembershipAccountId, setRefreshingMembershipAccountId] = useState('')
  // 自动登录按账号粒度置忙（可能等人机验证，不锁全局面板）
  const [reloginAccountId, setReloginAccountId] = useState('')
  // 升级 Pro 结账按账号粒度置忙（直达+填单最长约 2 分钟，不锁全局面板）
  const [proUpgradeAccountId, setProUpgradeAccountId] = useState('')
  const activeAccount = accounts.find((account) => account.active)
  const providerId = automationSettings?.processingProvider ?? 'aozai'
  const providerLabel = PROCESSING_PROVIDER_LABEL[providerId]
  const processingStatus = processingStatuses?.[providerId]
  const processingEnabled = Boolean(onProcessAccount)
  const liveSwitch = liveSwitchAvailability(switchPumpStatus)
  // 合并状态行上移卡片头：替换「当前 xxx」（email 重复），无信号时回退原文案
  const statusLine = accountStatusLineFor(runtimeMatch, membership)

  return (
    <>
      {statusLine || activeAccount ? (
        <div className="settings-status-strip">
          <em className="lobby-account__current">
            {statusLine ? (
              <span
                className={`account-status-line${statusLine.tone ? ` ${statusLine.tone}` : ''}`}
                title={statusLine.detail}
              >
                <i aria-hidden="true" />
                <span className="account-status-line__text">{statusLine.text}</span>
              </span>
            ) : activeAccount ? <>当前 <b>{activeAccount.label}</b></> : '未选择账号'}
          </em>
        </div>
      ) : null}

      <SettingsSection
        title="已保存账号"
        description="Token 仅在本机加密保存，不会写入明文存储、日志或再次显示。"
        aside={accounts.length ? <i className="settings-count">{accounts.length}</i> : undefined}
      >
        {accounts.length ? (
          <ul className="settings-account-list">
            {accounts.map((account) => {
              const accountMembership = accountMemberships?.[account.id]
                ?? (account.active ? membership : undefined)
              const membershipPlan = accountMembershipPlanFor(accountMembership)

              // 次要动作（低频、非切换语义）收进行尾的「⋯」：行内按钮固定为
              // 无感切换 / 切换并重启 / 删除 / ⋯，右缘锚定的常驻三枚在所有行里对齐，
              // 只有「无感切换」按是否当前账号出现在最左。
              const secondary: AccountMenuAction[] = []
              if (account.hasCredentials && onReloginAccount) {
                secondary.push({
                  key: 'relogin',
                  label: reloginAccountId === account.id ? '登录中…' : '重新登录',
                  title: '用保存的邮箱与 Cursor 密码在指纹浏览器窗口自动登录并刷新 Token；若弹出人机验证，在窗口中手动完成即可',
                  disabled: busy || processingBusy || Boolean(reloginAccountId),
                  onSelect: () => {
                    if (reloginAccountId) return
                    setReloginAccountId(account.id)
                    void Promise.resolve()
                      .then(() => onReloginAccount(account.id))
                      .catch(() => undefined)
                      .finally(() => setReloginAccountId(''))
                  }
                })
              }
              if (onStartProUpgrade) {
                secondary.push({
                  key: 'pro-upgrade',
                  label: proUpgradeAccountId === account.id ? '结账中…' : '升级 Pro',
                  title: '在账号绑定的指纹窗口直达 Stripe 月付结账（USD · 支付宝），自动填写「自动化」设置里的账单资料并提交；随后在窗口中用支付宝扫码完成付款',
                  disabled: busy || processingBusy || Boolean(reloginAccountId) || Boolean(proUpgradeAccountId),
                  onSelect: () => {
                    if (proUpgradeAccountId) return
                    setProUpgradeAccountId(account.id)
                    void Promise.resolve()
                      .then(() => onStartProUpgrade(account.id))
                      .catch(() => undefined)
                      .finally(() => setProUpgradeAccountId(''))
                  }
                })
              }
              if (processingEnabled && processingStatus?.saved && onProcessAccount) {
                const unit = processingStatus.unit === 'uses' ? '次' : '点'
                const charge = typeof processingStatus.costPerOperation === 'number'
                  ? `扣 ${processingStatus.costPerOperation} ${unit}`
                  : '按服务端规则扣费'
                secondary.push({
                  key: 'processing',
                  label: processingBusy && processingProgress?.accountId === account.id ? '处理中…' : `${providerLabel}处理`,
                  title: `将此账号的 Session Token 提交${providerLabel}处理（${charge}）`,
                  disabled: busy || processingBusy,
                  onSelect: () => void onProcessAccount(providerId, account.id)
                })
              }
              // 进行中的动作提到触发器上，菜单收起时也看得见进度。
              const busyLabel = reloginAccountId === account.id ? '登录中…'
                : proUpgradeAccountId === account.id ? '结账中…'
                : processingBusy && processingProgress?.accountId === account.id ? '处理中…'
                : undefined

              return (
                <li className={`account-row${account.active ? ' is-active' : ''}`} key={account.id}>
                  <i className="account-row__avatar" aria-hidden="true">{account.label.slice(0, 1).toUpperCase()}</i>
                  <button
                    className="account-row__identity"
                    disabled={busy || account.active}
                    title={account.active ? '当前活跃账号' : `把 ${account.label} 设为当前账号`}
                    onClick={() => void onSelect(account.id)}
                  >
                    <strong>{account.label}</strong>
                    <em className={account.active ? 'account-row__current' : 'account-row__select-hint'}>
                      {account.active ? '当前' : '设为当前'}
                    </em>
                  </button>
                  <div className="account-row__meta">
                    <small className="account-row__token">{account.maskedToken}</small>
                    {membershipPlan ? (
                      <span className="account-membership-inline">
                        <span className={`account-membership-plan ${membershipPlan.className}`}>
                          账号类型：<b>{membershipPlan.label}</b>
                        </span>
                        {onRefreshMembership ? (
                          <button
                            className={`account-membership-refresh ${membershipPlan.className}${refreshingMembershipAccountId === account.id ? ' is-refreshing' : ''}`}
                            type="button"
                            disabled={refreshingMembershipAccountId === account.id}
                            title="刷新此账号会员等级"
                            aria-label={`刷新 ${account.label} 的会员等级`}
                            onClick={() => {
                              if (refreshingMembershipAccountId) return
                              setRefreshingMembershipAccountId(account.id)
                              void Promise.resolve()
                                .then(() => onRefreshMembership(account.id))
                                .catch(() => undefined)
                                .finally(() => setRefreshingMembershipAccountId(''))
                            }}
                          ><RefreshIcon /></button>
                        ) : null}
                      </span>
                    ) : null}
                    {account.pendingMachineAlign ? (
                      <small className="account-machine-pending" title="无感换号未更换机器码；下次「切换并重启」时自动对齐">待重启对齐</small>
                    ) : null}
                    {onSetAccountFingerprintProfile ? (
                      <span
                        className={`account-window-binding${account.fingerprintProfileId ? ' is-bound' : ''}`}
                        title={account.fingerprintProfileId
                          ? `自动化固定在此窗口执行（导入时绑定）；可改绑其他窗口或选「默认窗口」解绑`
                          : `未绑定窗口：自动化将使用「导入来源」的默认窗口；在此选择窗口即绑定`}
                      >
                        <MenuSelect
                          value={account.fingerprintProfileId ?? ''}
                          placeholder="默认窗口"
                          disabled={busy || processingBusy}
                          ariaLabel={`${account.label} 的指纹窗口绑定`}
                          menuMinWidth={240}
                          options={windowBindingOptions(account, bitProfiles)}
                          onChange={(value) => void onSetAccountFingerprintProfile(account.id, value || undefined)}
                        />
                      </span>
                    ) : null}
                  </div>
                  <div className="account-row__actions">
                    {onSwitchLiveAccount && !account.active ? (
                      <button
                        className={`account-process account-switch-live${isSwitching('live', account.id) ? ' is-busy' : ''}`}
                        disabled={busy || processingBusy || !liveSwitch.enabled}
                        title={liveSwitch.title}
                        onClick={() => {
                          setSwitching({ kind: 'live', accountId: account.id })
                          void onSwitchLiveAccount(account.id)
                        }}
                      >
                        {isSwitching('live', account.id) ? '切换中…' : '无感切换'}
                      </button>
                    ) : null}
                    {onRestartWithAccount ? (
                      <button
                        className={`account-process lobby-account__inject${isArmed('restart', account.id) ? ' is-confirming' : ''}${isSwitching('restart', account.id) ? ' is-busy' : ''}`}
                        disabled={busy || processingBusy}
                        title={isArmed('restart', account.id)
                          ? '再次点击确认：关闭全部 Cursor 窗口（若有未保存内容请先保存，超过 10 秒未退出将强制关闭），写入登录态与机器码后带调试端口重启；按 Esc 或点击其他位置取消'
                          : '切换账号将关闭并重启 Cursor（未保存内容可能丢失）；首次点击仅进入确认状态'}
                        onClick={() => {
                          if (!isArmed('restart', account.id)) {
                            arm({ kind: 'restart', accountId: account.id })
                            return
                          }
                          disarm()
                          setSwitching({ kind: 'restart', accountId: account.id })
                          void onRestartWithAccount(account.id)
                        }}
                      >{isSwitching('restart', account.id) ? '切换中…' : isArmed('restart', account.id) ? '确认重启' : '切换并重启'}</button>
                    ) : null}
                    <button
                      className={`account-remove${isArmed('remove', account.id) ? ' is-confirming' : ''}`}
                      disabled={busy}
                      title={isArmed('remove', account.id)
                        ? `再次点击确认删除${account.active ? '；这是当前账号，删除后由列表中的下一个账号接任' : ''}；按 Esc 或点击其他位置取消`
                        : '从本机移除此账号保存的 Token 与凭据（不影响 Cursor 官网账号）；首次点击仅进入确认状态'}
                      onClick={() => {
                        if (!isArmed('remove', account.id)) {
                          arm({ kind: 'remove', accountId: account.id })
                          return
                        }
                        disarm()
                        void onRemove(account.id)
                      }}
                    >{isArmed('remove', account.id) ? '确认' : '删除'}</button>
                    <AccountActionsMenu label={`${account.label} 的更多操作`} busyLabel={busyLabel} actions={secondary} />
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="settings-empty">
            还没有账号。
            {onNavigateToImport ? (
              <button type="button" onClick={onNavigateToImport}>前往「导入来源」获取</button>
            ) : null}
          </p>
        )}
        {processingError?.providerId === providerId ? <p className="account-aozai__fail" role="alert">{processingError.message}</p> : null}
        {!processingBusy && processingFeedback?.providerId === providerId ? <p className={processingFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'} role="status">{processingFeedback.message}</p> : null}
        {proUpgradeFeedback ? <p className={proUpgradeFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'} role="status">{proUpgradeFeedback.message}</p> : null}
      </SettingsSection>
    </>
  )
}
