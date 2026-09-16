import { useState } from 'react'
import {
  ACCOUNT_AUTOMATION_DELAY_MAX_SEC,
  ACCOUNT_AUTOMATION_DELAY_MIN_SEC,
  selectAccountHandoverTarget,
  type AccountAutomationPhase
} from '../../../domain/account-automation'
import {
  DEFAULT_CURSOR_CHECKOUT_PROFILE,
  cursorCheckoutProfileIssue,
  type CursorCheckoutProfile
} from '../../../domain/cursor-checkout-profile'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { NumberStepperField } from '../lobby/NumberStepperField'
import { FlowStatusIcon } from '../lobby/FlowStatusIcon'
import { MenuSelect } from '../lobby/MenuSelect'
import type { SettingsPageProps } from './settings-view'
import {
  ACTIVE_PHASE_STEP,
  accountFlowStateLabel,
  accountFlowStatesFor,
  automationBrowserFollowText,
  automationDurationText,
  automationFailedStepHint,
  isActiveAutomationPhase,
  FLOW_STEP_LABEL,
  type AccountFlowStepKey
} from './settings-view'
import { SettingsSection } from './SettingsSection'

type AutomationProps = Pick<SettingsPageProps,
  | 'accounts' | 'automationSettings' | 'automationRun' | 'aozaiStatus'
  | 'aozaiBusy' | 'onSaveAutomationSettings' | 'onCancelAutomation' | 'bitProfiles'
>

const TRACKER_STEPS: readonly AccountFlowStepKey[] = ['acquire', 'countdown', 'processing', 'deleting', 'finish']

/**
 * 自动化分组：设置项（开关 + 双倒计时滑杆）+ 运行状态横幅。
 * 横幅是非空闲相位时的签名元素：横向五步追踪器 + 倒计时/实时消息/取消；
 * 空闲相位下横幅完全不渲染，设置项位置恒定。
 * 全部状态推导、消息与禁用条件逐字继承自原 LobbyAccountTile 步骤二至五。
 */
export function SettingsAutomation({
  accounts,
  automationSettings,
  automationRun,
  aozaiStatus,
  aozaiBusy = false,
  onSaveAutomationSettings,
  onCancelAutomation,
  bitProfiles
}: AutomationProps): React.JSX.Element {
  const aozaiReady = Boolean(aozaiStatus?.saved)
  const automationEnabled = Boolean(automationSettings?.enabled)
  const phase = automationRun?.phase ?? 'idle'
  // 失败归属：跟踪本次运行最后活跃的步骤（render 期派生状态，React 官方模式）；
  // 组件挂载后直接就是失败态（如持久化恢复）时退化为按消息文案推断。
  const [lastActiveStep, setLastActiveStep] = useState<AccountFlowStepKey | null>(null)
  const activeStep = ACTIVE_PHASE_STEP[phase]
  if (activeStep && activeStep !== lastActiveStep) setLastActiveStep(activeStep)

  const runMessage = automationRun?.message ?? ''
  const states = accountFlowStatesFor({
    phase,
    hasAccount: accounts.length > 0,
    automationEnabled,
    aozaiReady,
    lastActiveStep: lastActiveStep ?? automationFailedStepHint(runMessage)
  })
  const durationText = automationRun ? automationDurationText(automationRun) : ''
  const automationControlsReady = aozaiReady && Boolean(automationSettings) && Boolean(onSaveAutomationSettings)
  const active = isActiveAutomationPhase(phase)
  const activeAccount = accounts.find((account) => account.active)
  const handoverCandidates = accounts.filter((account) => !account.active)
  const preferredHandoverId = automationSettings?.seamlessHandoverAccountId
  const handoverTarget = selectAccountHandoverTarget(accounts, activeAccount?.id, preferredHandoverId)
  const effectivePreferredId = handoverCandidates.some((account) => account.id === preferredHandoverId)
    ? preferredHandoverId ?? ''
    : ''
  const handoverDuration = automationRun?.handover?.finishedAt
    ? Math.max(0, automationRun.handover.finishedAt - automationRun.handover.startedAt) / 1_000
    : undefined
  // 展开区可见性与父级联动：自动化关闭时整个参数区折叠，嵌套的接手账号区亦不标记展开。
  const handoverOpen = automationSettings?.enabled === true && automationSettings.seamlessHandoverEnabled !== false
  // 升级 Pro 账单资料：存储层恒归一为完整结构（编辑中途空串原样保留），缺省给整套默认。
  const checkoutProfile = automationSettings?.checkoutProfile ?? DEFAULT_CURSOR_CHECKOUT_PROFILE
  const checkoutIssue = cursorCheckoutProfileIssue(checkoutProfile)
  const updateCheckoutField = (key: keyof CursorCheckoutProfile, value: string): void => {
    if (!automationSettings || !onSaveAutomationSettings) return
    void onSaveAutomationSettings({ ...automationSettings, checkoutProfile: { ...checkoutProfile, [key]: value } })
  }

  return (
    <>
      {phase !== 'idle' ? (
        <div className={`settings-flow-banner is-${phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : 'active'}`}>
          <ol className="settings-flow-track" aria-label="账号自动化流程">
            {TRACKER_STEPS.map((key, index) => {
              const state = states[key]
              return (
                <li
                  key={key}
                  className={`settings-flow-track__step is-${state}`}
                  aria-label={`步骤 ${index + 1}：${FLOW_STEP_LABEL[key]}，${accountFlowStateLabel(state)}`}
                >
                  <FlowStatusIcon state={state} index={index + 1} />
                  <span>{FLOW_STEP_LABEL[key]}</span>
                </li>
              )
            })}
          </ol>

          <div className="settings-flow-banner__live">
            {phase === 'countdown' && automationRun ? (
              <div className="flow-step__countdown" aria-live="polite" aria-label="自动化倒计时">
                <b>{typeof automationRun.remainingSec === 'number' ? automationRun.remainingSec : '—'}</b>
                <span>秒后自动处理当前账号</span>
                {onCancelAutomation ? (
                  <button className="flow-step__cancel" onClick={onCancelAutomation}>取消</button>
                ) : null}
              </div>
            ) : null}
            {phase === 'hardening-countdown' && automationRun ? (
              <div className="flow-step__countdown" aria-live="polite" aria-label="账号加固倒计时">
                <b>{typeof automationRun.remainingSec === 'number' ? automationRun.remainingSec : '—'}</b>
                <span>秒后加固当前账号</span>
                {onCancelAutomation ? (
                  <button className="flow-step__cancel" onClick={onCancelAutomation}>取消</button>
                ) : null}
              </div>
            ) : null}

            {phase === 'countdown' && runMessage ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.countdown === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}
            {states.countdown === 'cancelled' && runMessage ? (
              <p className="flow-step__live is-cancelled">{runMessage}</p>
            ) : null}

            {phase === 'processing' && runMessage ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.processing === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}

            {phase === 'hardening-countdown' || phase === 'deleting' || phase === 'importing' || phase === 'cleaning' ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.deleting === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}

            {phase === 'done' && runMessage ? (
              <p className="flow-step__live is-done" aria-live="polite">{runMessage}</p>
            ) : null}
            {phase === 'cancelled' && runMessage ? (
              <p className="flow-step__live is-cancelled">{runMessage}</p>
            ) : null}
            {phase === 'failed' ? (
              <p className="flow-step__live is-failed" role="alert">流程未完成：{runMessage}</p>
            ) : null}
            {durationText ? (
              <p className="settings-flow-banner__duration">耗时 {durationText}</p>
            ) : null}
            {automationRun?.handover ? (
              <div className={`settings-handover-status is-${automationRun.handover.status}`}>
                <span>接手账号</span>
                <strong>{automationRun.handover.label}</strong>
                <em>{automationRun.handover.message}{handoverDuration !== undefined ? ` · ${handoverDuration.toFixed(1)}s` : ''}</em>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <SettingsSection
        title="自动化"
        description="会话创建全部提交成功后，自动处理当前账号并按需接续到下一账号。"
      >
        {automationControlsReady && automationSettings && onSaveAutomationSettings ? (
          <div className="account-automation settings-automation">
            <div className="settings-row">
              <div className="settings-row__copy">
                <span className="settings-row__label">会话创建后自动处理账号</span>
                <span className="settings-row__hint">处理完成后秒级加固账号（不可撤销），必要时自动刷新会话获取新 Token</span>
              </div>
              <ToggleSwitch
                checked={automationSettings.enabled}
                disabled={aozaiBusy || active}
                label="会话创建后自动处理账号"
                onChange={(enabled) => onSaveAutomationSettings({ ...automationSettings, enabled })}
              />
            </div>

            <div className={`settings-collapse${automationSettings.enabled ? ' is-open' : ''}`}>
              <div className="settings-collapse__inner">
                <div className="settings-subgroup">
                  <div className="settings-row settings-row--sub">
                    <div className="settings-row__copy">
                      <span className="settings-row__label">处理前倒计时</span>
                      <span className="settings-row__hint">处理前等待，期间可随时取消</span>
                    </div>
                    <NumberStepperField
                      value={automationSettings.delaySec}
                      min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                      max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                      step={0.5}
                      unit="秒"
                      disabled={aozaiBusy}
                      label="奥仔处理前倒计时秒数"
                      onChange={(delaySec) => onSaveAutomationSettings({ ...automationSettings, delaySec })}
                    />
                  </div>
                  <div className="settings-row settings-row--sub">
                    <div className="settings-row__copy">
                      <span className="settings-row__label">加固前倒计时</span>
                      <span className="settings-row__hint">处理完成后等待，随后秒级加固账号</span>
                    </div>
                    <NumberStepperField
                      value={automationSettings.postProcessDelaySec}
                      min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                      max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                      step={0.5}
                      unit="秒"
                      disabled={aozaiBusy}
                      label="奥仔完成后账号加固前倒计时秒数"
                      onChange={(postProcessDelaySec) => onSaveAutomationSettings({ ...automationSettings, postProcessDelaySec })}
                    />
                  </div>
                </div>

                <div className="settings-row settings-row--divided">
                  <div className="settings-row__copy">
                    <span className="settings-row__label">倒计时后复核会话</span>
                    <span className="settings-row__hint">倒计时结束时再读一次浏览器会话，期间改动会被拦截；关闭可省去一次会话读取（连/开窗）</span>
                  </div>
                  <ToggleSwitch
                    checked={automationSettings.preflightRecheckEnabled !== false}
                    disabled={aozaiBusy || active}
                    label="倒计时后复核会话"
                    onChange={(preflightRecheckEnabled) => onSaveAutomationSettings({ ...automationSettings, preflightRecheckEnabled })}
                  />
                </div>

                <div className="settings-row settings-row--divided">
                  <div className="settings-row__copy">
                    <span className="settings-row__label">退款完成后无感切换</span>
                    <span className="settings-row__hint">不重启 Cursor，接续到下一可用账号</span>
                  </div>
                  <ToggleSwitch
                    checked={automationSettings.seamlessHandoverEnabled !== false}
                    disabled={aozaiBusy || active}
                    label="退款完成后无感切换"
                    title="奥仔退款成功后，经切号补丁把运行中的 Cursor 直接换到指定接手账号（不换机器码、不中断会话）"
                    onChange={(seamlessHandoverEnabled) => onSaveAutomationSettings({ ...automationSettings, seamlessHandoverEnabled })}
                  />
                </div>

                <div className={`settings-collapse${handoverOpen ? ' is-open' : ''}`}>
                  <div className="settings-collapse__inner">
                    <div className="settings-subgroup">
                      <div className="settings-row settings-row--sub">
                        <div className="settings-row__copy">
                          <span className="settings-row__label">接手账号</span>
                          <span className="settings-row__hint">不指定时自动接续最近可用的账号</span>
                        </div>
                        <MenuSelect
                          value={effectivePreferredId}
                          disabled={aozaiBusy || active || handoverCandidates.length === 0}
                          ariaLabel="自动化无感换号接手账号"
                          options={[
                            { value: '', label: `自动${handoverTarget ? ` · ${handoverTarget.label}` : ' · 暂无可用账号'}` },
                            ...handoverCandidates.map((account) => ({ value: account.id, label: account.label }))
                          ]}
                          onChange={(value) => onSaveAutomationSettings({
                            ...automationSettings,
                            seamlessHandoverAccountId: value || undefined
                          })}
                        />
                      </div>
                      <div className="settings-row settings-row--sub">
                        <div className="settings-row__copy">
                          <span className="settings-row__label">切换前等待</span>
                          <span className="settings-row__hint">退款成功后等待再热切运行中的 Cursor；0 = 立即。等待期间取消自动化则不再切换；等待长于加固倒计时时，切换会发生在旧号删除之后</span>
                        </div>
                        <NumberStepperField
                          value={automationSettings.handoverDelaySec ?? 0}
                          min={0}
                          max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                          step={0.5}
                          unit="秒"
                          disabled={aozaiBusy || active}
                          label="无感切换前等待秒数"
                          onChange={(handoverDelaySec) => onSaveAutomationSettings({ ...automationSettings, handoverDelaySec })}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <p className="account-automation__follow">
                  执行浏览器：{automationBrowserFollowText({
                    browserHost: automationSettings.browserHost,
                    accounts,
                    defaultProfileId: automationSettings.bitProfileId,
                    profiles: bitProfiles
                  })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="flow-step__hint">保存奥仔卡密后开启自动化。</p>
        )}
      </SettingsSection>

      {automationSettings && onSaveAutomationSettings ? (
        <SettingsSection
          title="升级 Pro 账单资料"
          description="账号卡片「升级 Pro」在 Stripe 结账页自动填写的姓名与中国账单地址；国家（中国）、币种（USD）、月付由链路固定，付款在指纹窗口内用支付宝扫码完成。"
        >
          <div className="account-add-form settings-add-form settings-checkout-form">
            <label>
              <span>账单姓名</span>
              <input
                value={checkoutProfile.name}
                maxLength={80}
                autoComplete="off"
                placeholder="拼音 / 英文，如 Li Ming"
                onChange={(event) => updateCheckoutField('name', event.target.value)}
              />
            </label>
            <label>
              <span>省份</span>
              <input
                value={checkoutProfile.province}
                maxLength={40}
                autoComplete="off"
                placeholder="与 Stripe 选项一致，如 湖北省"
                onChange={(event) => updateCheckoutField('province', event.target.value)}
              />
            </label>
            <label>
              <span>城市</span>
              <input
                value={checkoutProfile.city}
                maxLength={60}
                autoComplete="off"
                placeholder="如 武汉市"
                onChange={(event) => updateCheckoutField('city', event.target.value)}
              />
            </label>
            <label>
              <span>区 / 县</span>
              <input
                value={checkoutProfile.district}
                maxLength={60}
                autoComplete="off"
                placeholder="如 洪山区"
                onChange={(event) => updateCheckoutField('district', event.target.value)}
              />
            </label>
            <label className="settings-checkout-form__wide">
              <span>地址行 1</span>
              <input
                value={checkoutProfile.line1}
                maxLength={120}
                autoComplete="off"
                placeholder="街道、门牌号，如 珞喻路 456 号"
                onChange={(event) => updateCheckoutField('line1', event.target.value)}
              />
            </label>
            <label className="settings-checkout-form__wide">
              <span>地址行 2（可选）</span>
              <input
                value={checkoutProfile.line2 ?? ''}
                maxLength={120}
                autoComplete="off"
                placeholder="楼栋、单元、室等补充信息"
                onChange={(event) => updateCheckoutField('line2', event.target.value)}
              />
            </label>
            <label>
              <span>邮编</span>
              <input
                value={checkoutProfile.postalCode}
                maxLength={10}
                autoComplete="off"
                inputMode="numeric"
                placeholder="如 430070"
                onChange={(event) => updateCheckoutField('postalCode', event.target.value)}
              />
            </label>
            {checkoutIssue ? (
              <p className="settings-add-form__warn settings-checkout-form__wide">资料不完整：缺{checkoutIssue}，补齐后才能发起升级</p>
            ) : (
              <p className="settings-add-form__ok settings-checkout-form__wide">资料完整，可在账号卡片发起「升级 Pro」</p>
            )}
          </div>
        </SettingsSection>
      ) : null}
    </>
  )
}
