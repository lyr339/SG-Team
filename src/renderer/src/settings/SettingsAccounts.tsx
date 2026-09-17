import { useEffect, useState } from 'react'
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

type AccountsProps = Pick<SettingsPageProps,
  | 'accounts' | 'busy' | 'onSave' | 'onSelect' | 'onRemove' | 'onRestartWithAccount' | 'onSwitchLiveAccount' | 'switchPumpStatus'
  | 'runtimeMatch' | 'membership' | 'accountMemberships' | 'onRefreshMembership'
  | 'aozaiStatus' | 'aozaiBusy' | 'aozaiProgress' | 'aozaiError' | 'aozaiFeedback' | 'onProcessAozaiAccount'
  | 'bitProfiles' | 'onSetAccountFingerprintProfile' | 'onReloginAccount' | 'onStartProUpgrade' | 'proUpgradeFeedback'
>

interface SettingsAccountsProps extends AccountsProps {
  active?: boolean
  /** 空列表时「前往导入来源」的跨组导航（由 SettingsPage 注入）。 */
  onNavigateToImport?: () => void
}

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
 * 全部处理器、禁用条件、二次确认语义与文案逐字继承自原 LobbyAccountTile 步骤一。
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
  aozaiStatus,
  aozaiBusy = false,
  aozaiProgress,
  aozaiError,
  aozaiFeedback,
  onProcessAozaiAccount,
  onNavigateToImport,
  bitProfiles,
  onSetAccountFingerprintProfile,
  onReloginAccount,
  onStartProUpgrade,
  proUpgradeFeedback
}: SettingsAccountsProps): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState('')
  const [confirmRestart, setConfirmRestart] = useState('')
  useEffect(() => { if (!active) { setConfirmRemove(''); setConfirmRestart('') } }, [active])
  const [refreshingMembershipAccountId, setRefreshingMembershipAccountId] = useState('')
  // 自动登录按账号粒度置忙（可能等人机验证，不锁全局面板）
  const [reloginAccountId, setReloginAccountId] = useState('')
  // 升级 Pro 结账按账号粒度置忙（直达+填单最长约 2 分钟，不锁全局面板）
  const [proUpgradeAccountId, setProUpgradeAccountId] = useState('')
  const activeAccount = accounts.find((account) => account.active)
  const aozaiEnabled = Boolean(onProcessAozaiAccount)
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
        <div className="account-list settings-account-list">
          {accounts.map((account) => (
            <article className={account.active ? 'is-active' : ''} key={account.id}>
              <button
                className="account-card__main"
                disabled={busy || account.active}
                title={account.active ? '当前活跃账号' : `把 ${account.label} 设为当前账号`}
                onClick={() => void onSelect(account.id)}
              >
                <i>{account.label.slice(0, 1).toUpperCase()}</i>
                <span><strong>{account.label}</strong><small>{account.maskedToken}</small></span>
                <em className={account.active ? 'account-card__current' : 'account-card__select-hint'}>
                  {account.active ? '当前' : '选择'}
                </em>
              </button>
              <div className="account-card__meta">
                {(() => {
                  const accountMembership = accountMemberships?.[account.id]
                    ?? (account.active ? membership : undefined)
                  const membershipPlan = accountMembershipPlanFor(accountMembership)
                  return membershipPlan ? (
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
                  ) : null
                })()}
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
                      disabled={busy || aozaiBusy}
                      ariaLabel={`${account.label} 的指纹窗口绑定`}
                      menuMinWidth={240}
                      options={windowBindingOptions(account, bitProfiles)}
                      onChange={(value) => void onSetAccountFingerprintProfile(account.id, value || undefined)}
                    />
                  </span>
                ) : null}
              </div>
              <div className="lobby-account__row-actions account-card__actions">
                {(() => {
                  // 次要动作（低频、非切换语义）收进「⋯」：行内按钮数固定为
                  // 无感切换 / 切换并重启 / 删除，操作行不再因账号状态不同而换行错位。
                  const secondary: AccountMenuAction[] = []
                  if (account.hasCredentials && onReloginAccount) {
                    secondary.push({
                      key: 'relogin',
                      label: reloginAccountId === account.id ? '登录中…' : '重新登录',
                      title: '用保存的邮箱与 Cursor 密码在指纹浏览器窗口自动登录并刷新 Token；若弹出人机验证，在窗口中手动完成即可',
                      disabled: busy || aozaiBusy || Boolean(reloginAccountId),
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
                      disabled: busy || aozaiBusy || Boolean(reloginAccountId) || Boolean(proUpgradeAccountId),
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
                  if (aozaiEnabled && aozaiStatus?.saved && onProcessAozaiAccount) {
                    secondary.push({
                      key: 'aozai',
                      label: aozaiBusy && aozaiProgress?.accountId === account.id ? '处理中…' : '处理',
                      title: '将此账号的 Session Token 提交奥仔自助服务处理（扣 1 次）',
                      disabled: busy || aozaiBusy,
                      onSelect: () => void onProcessAozaiAccount(account.id)
                    })
                  }
                  // 进行中的动作提到触发器上，菜单收起时也看得见进度。
                  const busyLabel = reloginAccountId === account.id ? '登录中…'
                    : proUpgradeAccountId === account.id ? '结账中…'
                    : aozaiBusy && aozaiProgress?.accountId === account.id ? '处理中…'
                    : undefined
                  return <AccountActionsMenu label={`${account.label} 的更多操作`} busyLabel={busyLabel} actions={secondary} />
                })()}
                {onSwitchLiveAccount && !account.active ? (
                  <button
                    className="account-process account-switch-live"
                    disabled={busy || aozaiBusy || !liveSwitch.enabled}
                    title={liveSwitch.title}
                    onClick={() => void onSwitchLiveAccount(account.id)}
                  >
                    {busy ? '切换中…' : '无感切换'}
                  </button>
                ) : null}
                {onRestartWithAccount ? (
                  <button
                    className={`account-process lobby-account__inject ${confirmRestart === account.id ? 'is-confirming' : ''}`}
                    disabled={busy || aozaiBusy}
                    title={confirmRestart === account.id
                      ? '再次点击确认：关闭全部 Cursor 窗口（若有未保存内容请先保存，超过 10 秒未退出将强制关闭），写入登录态与机器码后带调试端口重启'
                      : '切换账号将关闭并重启 Cursor（未保存内容可能丢失）；首次点击仅进入确认状态'}
                    onClick={() => {
                      if (confirmRestart !== account.id) {
                        setConfirmRestart(account.id)
                        return
                      }
                      setConfirmRestart('')
                      void onRestartWithAccount(account.id)
                    }}
                  >{busy ? '切换中…' : confirmRestart === account.id ? '确认重启' : '切换并重启'}</button>
                ) : null}
                <button className="account-remove" disabled={busy} onClick={() => {
                  if (confirmRemove !== account.id) { setConfirmRemove(account.id); return }
                  void onRemove(account.id).then(() => setConfirmRemove(''))
                }}>{confirmRemove === account.id ? '确认' : '删除'}</button>
              </div>
            </article>
          ))}
          {!accounts.length ? (
            <p className="settings-empty">
              还没有账号。
              {onNavigateToImport ? (
                <button type="button" onClick={onNavigateToImport}>前往「导入来源」获取</button>
              ) : null}
            </p>
          ) : null}
        </div>
        {aozaiError ? <p className="account-aozai__fail" role="alert">{aozaiError}</p> : null}
        {!aozaiBusy && aozaiFeedback ? <p className={aozaiFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'} role="status">{aozaiFeedback.message}</p> : null}
        {proUpgradeFeedback ? <p className={proUpgradeFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'} role="status">{proUpgradeFeedback.message}</p> : null}
      </SettingsSection>
    </>
  )
}
