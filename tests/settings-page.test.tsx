import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
  selectAccountHandoverTarget,
  type AccountAutomationRun
} from '../src/domain/account-automation'
import {
  accountFlowStatesFor,
  automationBrowserFollowText,
  automationDurationText,
  automationFailedStepHint,
  liveSwitchAvailability,
  profileDisplayName,
  type SettingsPageProps
} from '../src/renderer/src/settings/settings-view'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'

const accounts: SettingsPageProps['accounts'] = [
  { id: 'account:1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: 1, updatedAt: 1 },
  { id: 'account:2', label: 'spare@example.com', maskedToken: '••••41qz', active: false, createdAt: 2, updatedAt: 2 }
]

function propsFor(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    accounts,
    busy: false,
    error: '',
    onSave: async () => {},
    onSelect: async () => {},
    onRemove: async () => {},
    onRestartWithAccount: async () => {},
    onImportFromLocal: async () => {},
    onImportFromBrowser: async () => {},
    aozaiStatus: { saved: true, maskedCode: '••••card', type: '次卡', remaining: 5 },
    aozaiBusy: false,
    aozaiError: '',
    onSaveAozaiCard: async () => {},
    onClearAozaiCard: async () => {},
    onRefreshAozaiBalance: async () => {},
    onProcessAozaiAccount: async () => {},
    onProcessAozaiToken: async () => {},
    automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10 },
    automationRun: { phase: 'idle', message: '', startedAt: 0 },
    cursorUpdatePreferences: {
      settingsPath: '/Users/example/Library/Application Support/Cursor/User/settings.json',
      updateMode: 'none',
      autoUpdateDisabled: true,
      settingsExists: true
    },
    cursorUpdateBusy: false,
    cursorUpdateError: '',
    onSetCursorAutoUpdateDisabled: async () => {},
    onSetModelDataPolicyAutoAcknowledge: async () => ({ message: '已确认' }),
    onSaveAutomationSettings: () => {},
    onCancelAutomation: () => {},
    ...overrides
  }
}

function runFor(overrides: Partial<AccountAutomationRun>): AccountAutomationRun {
  return { phase: 'idle', message: '', startedAt: 0, ...overrides }
}

describe('accountFlowStatesFor', () => {
  it('maps idle phase to stock-driven resting states', () => {
    expect(accountFlowStatesFor({
      phase: 'idle', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'done', countdown: 'ready', processing: 'ready', deleting: 'waiting', finish: 'waiting' })
    expect(accountFlowStatesFor({
      phase: 'idle', hasAccount: false, automationEnabled: false, aozaiReady: false, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'waiting', countdown: 'off', processing: 'waiting', deleting: 'waiting', finish: 'waiting' })
  })

  it('walks active phases in order and attributes failure to the last active step', () => {
    expect(accountFlowStatesFor({
      phase: 'processing', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'processing'
    })).toEqual({ acquire: 'done', countdown: 'done', processing: 'running', deleting: 'waiting', finish: 'waiting' })
    expect(accountFlowStatesFor({
      phase: 'importing', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    }).deleting).toBe('running')
    const failed = accountFlowStatesFor({
      phase: 'failed', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    })
    expect(failed).toEqual({ acquire: 'done', countdown: 'done', processing: 'done', deleting: 'failed', finish: 'failed' })
  })

  it('marks cancelled runs at the countdown step', () => {
    expect(accountFlowStatesFor({
      phase: 'cancelled', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'done', countdown: 'cancelled', processing: 'waiting', deleting: 'waiting', finish: 'cancelled' })
  })

  it('marks hardening-countdown as the deleting step, and its cancel keeps prior steps done', () => {
    expect(accountFlowStatesFor({
      phase: 'hardening-countdown', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    })).toEqual({ acquire: 'done', countdown: 'done', processing: 'done', deleting: 'running', finish: 'waiting' })
    expect(accountFlowStatesFor({
      phase: 'cancelled', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    })).toEqual({ acquire: 'done', countdown: 'done', processing: 'done', deleting: 'cancelled', finish: 'cancelled' })
  })
})

describe('automationDurationText', () => {
  it('formats sub-minute and multi-minute durations', () => {
    expect(automationDurationText(runFor({ startedAt: 1_000, finishedAt: 13_500 }))).toBe('12.5 秒')
    expect(automationDurationText(runFor({ startedAt: 2_000, finishedAt: 77_000 }))).toBe('1 分 15 秒')
    expect(automationDurationText(runFor({ startedAt: 0, finishedAt: 5_000 }))).toBe('')
    expect(automationDurationText(runFor({ startedAt: 1_000, finishedAt: undefined }))).toBe('')
  })
})

describe('automationBrowserFollowText（执行窗口跟随文案，与主进程同一解析规则）', () => {
  const profiles = [
    { id: 'win-1', name: '代理窗口', seq: 4 },
    { id: 'win-2', name: '直连窗口', seq: 5 }
  ]

  it('活跃账号已绑定 → 指到绑定窗口（含序号与名称）', () => {
    expect(automationBrowserFollowText({
      accounts: [{ ...accounts[0]!, fingerprintProfileId: 'win-1' }],
      defaultProfileId: 'win-2',
      profiles
    })).toBe('指纹浏览器（Roxy）· 跟随活跃账号 → #4 代理窗口')
  })

  it('活跃账号未绑定 → 回退默认窗口并明示「未绑定」', () => {
    expect(automationBrowserFollowText({
      accounts: [accounts[0]!],
      defaultProfileId: 'win-2',
      profiles
    })).toBe('指纹浏览器（Roxy）· 未绑定，走默认窗口「#5 直连窗口」')
  })

  it('未绑定且无默认窗口 → 明示未选择', () => {
    expect(automationBrowserFollowText({ accounts: [accounts[0]!], profiles }))
      .toBe('指纹浏览器（Roxy）· 未绑定，走默认窗口（未选择）')
  })

  it('绑定窗口不在列表（Roxy 未连/窗口被删）→ 如实回退原始 id', () => {
    expect(automationBrowserFollowText({
      accounts: [{ ...accounts[0]!, fingerprintProfileId: 'win-gone' }],
      profiles
    })).toBe('指纹浏览器（Roxy）· 跟随活跃账号 → win-gone')
    expect(profileDisplayName(undefined, 'win-x')).toBe('win-x')
  })

  it('系统浏览器宿主与无活跃账号的兜底文案', () => {
    expect(automationBrowserFollowText({ browserHost: 'external', accounts: [accounts[0]!] }))
      .toBe('系统浏览器（Edge/Chrome）')
    expect(automationBrowserFollowText({ accounts: [] }))
      .toBe('指纹浏览器（Roxy）· 跟随活跃账号窗口')
  })
})

describe('SettingsPage', () => {
  it('renders settings navigation without an idle pipeline taking up the page', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor()} />)
    expect(html).toContain('aria-label="设置分组"')
    for (const label of ['账号', '导入来源', '自动化', '奥仔服务', 'Cursor 维护']) expect(html).toContain(label)
    expect(html).not.toContain('aria-label="账号自动化流程"')
    expect(html).not.toContain('lobby-account__columns')
  })

  it('会员等级移入当前账号卡：Free Plan 使用绿色等级类并带刷新按钮', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
        onRefreshMembership: () => {}
      })} />
    )
    expect(html).toContain('account-status-line"')
    expect(html).toContain('work@example.com · 一致')
    expect(html).not.toContain('work@example.com · 一致 · Free')
    expect(html).toContain('account-membership-plan is-tier-free')
    expect(html).toContain('账号类型：<b>Free Plan</b>')
    expect(html).toContain('class="account-membership-refresh is-tier-free"')
    expect(html).toMatch(/account-membership-refresh[\s\S]*?<svg[^>]+viewBox="0 0 24 24"/)
    expect(html).not.toContain('↻')
    expect(html).toContain('title="刷新此账号会员等级"')

    const paid = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'pro', raw: 'pro', fetchedAt: 1 } }
      })} />
    )
    expect(paid).toContain('account-status-line"')  // 无警示 tone
    expect(paid).toContain('work@example.com · 一致')
    expect(paid).toContain('account-membership-plan is-tier-pro')
    expect(paid).toContain('账号类型：<b>Pro Plan</b>')
    expect(paid).not.toContain('is-tier-free')
  })

  it('当前账号档位采用独立标签与色系：Free 绿、Trial 琥珀、Pro 蓝、Pro+ 靛、Ultra 紫、Enterprise 橙', () => {
    for (const [tier, className, plan] of [
      ['free', 'is-tier-free', 'Free Plan'],
      ['free_trial', 'is-tier-trial', 'Free Trial'],
      ['pro', 'is-tier-pro', 'Pro Plan'],
      ['pro_plus', 'is-tier-proplus', 'Pro+ Plan'],
      ['ultra', 'is-tier-ultra', 'Ultra Plan'],
      ['enterprise', 'is-tier-enterprise', 'Enterprise Plan']
    ] as const) {
      const html = renderToStaticMarkup(
        <SettingsPage {...propsFor({
          membership: { state: 'ok', profile: { tier, raw: tier, fetchedAt: 1 } }
        })} />
      )
      expect(html).toContain(`account-membership-plan ${className}`)
      expect(html).toContain(`账号类型：<b>${plan}</b>`)
    }
  })

  it('账号行内呈现窗口绑定控件：已绑定显示窗口名，未绑定显示「默认窗口」', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor({
      accounts: [
        { ...accounts[0]!, fingerprintProfileId: 'win-1' },
        accounts[1]!
      ],
      bitProfiles: [
        { id: 'win-1', name: '代理窗口', seq: 4 },
        { id: 'win-2', name: '直连窗口', seq: 5 }
      ],
      onSetAccountFingerprintProfile: async () => {}
    })} />)
    // 两个绑定控件：已绑定行 is-bound 且显示窗口名，未绑定行显示「默认窗口」
    expect(html.match(/account-window-binding/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('account-window-binding is-bound')
    expect(html).toContain('#4 代理窗口')
    expect(html).toContain('默认窗口')
    expect(html).toContain('aria-label="work@example.com 的指纹窗口绑定"')
    expect(html).toContain('aria-label="spare@example.com 的指纹窗口绑定"')
  })

  it('绑定窗口不在窗口列表时如实显示原始 id（不吞掉绑定状态）', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor({
      accounts: [{ ...accounts[0]!, fingerprintProfileId: 'win-gone' }],
      bitProfiles: [{ id: 'win-1', name: '代理窗口', seq: 4 }],
      onSetAccountFingerprintProfile: async () => {}
    })} />)
    expect(html).toContain('win-gone')
    expect(html).toContain('account-window-binding is-bound')
  })

  it('自动化组显示「执行窗口跟随活跃账号」的实际解析结果', () => {
    const bound = renderToStaticMarkup(<SettingsPage {...propsFor({
      accounts: [{ ...accounts[0]!, fingerprintProfileId: 'win-1' }, accounts[1]!],
      bitProfiles: [{ id: 'win-1', name: '代理窗口', seq: 4 }],
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, bitProfileId: 'win-2' }
    })} />)
    expect(bound).toContain('执行浏览器：指纹浏览器（Roxy）· 跟随活跃账号 → #4 代理窗口')

    const unbound = renderToStaticMarkup(<SettingsPage {...propsFor({
      bitProfiles: [{ id: 'win-2', name: '直连窗口', seq: 5 }],
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, bitProfileId: 'win-2' }
    })} />)
    expect(unbound).toContain('执行浏览器：指纹浏览器（Roxy）· 未绑定，走默认窗口「#5 直连窗口」')
  })

  it('顶部状态行只保留登录一致性；账号类型不依赖当前选择并可在每张卡常驻', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
        accountMemberships: {
          'account:1': { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
          'account:2': { state: 'ok', profile: { tier: 'pro_plus', raw: 'pro_plus', fetchedAt: 1 } }
        }
      })} />
    )
    expect(html).toContain('<em class="lobby-account__current"><span class="account-status-line"')
    expect(html).toContain('account-status-line__text')
    expect(html).toContain('账号类型：<b>Free Plan</b>')
    expect(html).toContain('账号类型：<b>Pro+ Plan</b>')
    expect((html.match(/account-membership-plan/g) ?? [])).toHaveLength(2)

    // 无信号（未拉取/未登录）：头部回退「当前 xxx」粗体展示
    const fallback = renderToStaticMarkup(<SettingsPage {...propsFor({})} />)
    expect(fallback).toContain('<b>work@example.com</b>')
    expect(fallback).not.toContain('account-status-line')
  })

  it('只给非活跃账号显示无感切换，并保留冷切换与机器码待对齐提示', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor({
      accounts: [accounts[0]!, { ...accounts[1]!, pendingMachineAlign: true }],
      onSwitchLiveAccount: async () => {},
      switchPumpStatus: { kind: 'installed', managed: false, message: '兼容可用', config: { port: 51_824, key: 'key', revision: 2 } }
    })} />)
    expect(html.match(/>无感切换<\/button>/g)).toHaveLength(1)
    expect(html).toContain('>切换并重启</button>')
    expect(html).toContain('待重启对齐')
    expect(html).toContain('无感换号未更换机器码')
    expect(html).toContain('使用现有兼容切号补丁')
  })

  it('手动无感切换能力只由切号泵状态决定', () => {
    expect(liveSwitchAvailability(undefined)).toEqual({ enabled: false, title: '正在检测 Cursor 无感换号能力…' })
    expect(liveSwitchAvailability({ kind: 'not-installed', message: 'missing' })).toEqual({
      enabled: false, title: '请先到「Cursor 维护」安装切号补丁'
    })
    expect(liveSwitchAvailability({ kind: 'unsupported', message: '锚点漂移' })).toEqual({ enabled: false, title: '锚点漂移' })
    expect(liveSwitchAvailability({ kind: 'installed', managed: true, message: 'ok', config: { port: 1, key: 'k', revision: 1 } }).enabled).toBe(true)
    expect(liveSwitchAvailability({ kind: 'installed', managed: false, message: 'ok', config: { port: 1, key: 'k', revision: 2 } }).enabled).toBe(true)
  })

  it('自动化无感换号开关沿用真实设置字段，不随机推导', () => {
    const onSave = () => {}
    const enabled = renderToStaticMarkup(<SettingsPage {...propsFor({
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, seamlessHandoverEnabled: true },
      onSaveAutomationSettings: onSave
    })} />)
    const disabled = renderToStaticMarkup(<SettingsPage {...propsFor({
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, seamlessHandoverEnabled: false },
      onSaveAutomationSettings: onSave
    })} />)
    const label = '退款完成后无感切换'
    const toggleMarkup = (html: string): string => {
      const textAt = html.indexOf(`aria-label="${label}"`)
      return html.slice(html.lastIndexOf('<label', textAt), html.indexOf('</label>', textAt) + 8)
    }
    expect(toggleMarkup(enabled)).toContain('checked=""')
    expect(toggleMarkup(enabled)).toContain(label)
    expect(toggleMarkup(disabled)).not.toContain('checked=""')
    expect(enabled).toContain('不重启 Cursor，接续到下一可用账号')
    expect(enabled).toContain('自动 · spare@example.com')
  })

  it('接手账号选择规则由 UI 与执行链共用：指定优先，自动取最近更新的非当前账号', () => {
    const candidates = [
      ...accounts,
      { id: 'account:3', label: 'latest@example.com', maskedToken: '••••0003', active: false, createdAt: 3, updatedAt: 9 }
    ]
    expect(selectAccountHandoverTarget(candidates, 'account:1')?.id).toBe('account:3')
    expect(selectAccountHandoverTarget(candidates, 'account:1', 'account:2')?.id).toBe('account:2')
    expect(selectAccountHandoverTarget(candidates, 'account:1', 'account:1')?.id).toBe('account:3')
  })

  it('自动化横幅独立显示本轮冻结的接手账号和实时子状态', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor({
      automationRun: runFor({
        phase: 'processing',
        message: '奥仔处理中',
        startedAt: 1_000,
        handover: {
          accountId: 'account:2',
          label: 'spare@example.com',
          status: 'preparing',
          message: '票据已就绪，等待退款完成',
          startedAt: 1_100
        }
      })
    })} />)
    expect(html).toContain('settings-handover-status is-preparing')
    expect(html).toContain('spare@example.com')
    expect(html).toContain('票据已就绪，等待退款完成')
  })

  it('自动化设置行统一为左文案右控件，倒计时步进输入编组于主开关之下的展开区', () => {
    const html = renderToStaticMarkup(<SettingsPage {...propsFor()} />)
    // 主开关行：左侧标题 + 说明，右侧开关（aria-label 标注，无内联文本）
    expect(html).toMatch(/settings-row__label">会话创建后自动处理账号<\/span>[\s\S]*?aria-label="会话创建后自动处理账号"/)
    // 双倒计时在编组子组内：处理前 + 加固前各一个步进输入（role="spinbutton"）
    expect(html).toMatch(/settings-collapse is-open[\s\S]*?settings-subgroup[\s\S]*?处理前倒计时[\s\S]*?role="spinbutton"[\s\S]*?加固前倒计时[\s\S]*?role="spinbutton"/)
    // 无感切换为独立平级行，接手账号选择器与切换前等待编组于其下
    expect(html).toMatch(/settings-row--divided[\s\S]*?退款完成后无感切换[\s\S]*?settings-row--sub[\s\S]*?接手账号/)
    expect(html).toContain('切换前等待')
    expect(html).toContain('aria-label="无感切换前等待秒数"')
    // 复核开关：倒计时后会话复检的显式开关
    expect(html).toContain('倒计时后复核会话')
    expect(html).toContain('aria-label="倒计时后复核会话"')
  })

  it('自动化关闭时参数区折叠且不可见，开启时展开', () => {
    const off = renderToStaticMarkup(<SettingsPage {...propsFor({
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: false }
    })} />)
    const on = renderToStaticMarkup(<SettingsPage {...propsFor()} />)
    expect(off).toContain('<div class="settings-collapse">')
    expect(off).not.toContain('settings-collapse is-open')
    expect(on).toContain('settings-collapse is-open')
  })

  it('合并状态行：mismatch 红点精简文案，title 携带双账号明细', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        runtimeMatch: { status: 'mismatch', cursorLabel: 'other@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'pro', raw: 'pro', fetchedAt: 1 } }
      })} />
    )
    expect(html).toContain('account-status-line is-off')
    expect(html).toContain('登录账号不一致')
    expect(html).toContain('account-membership-plan is-tier-pro')
    expect(html).toContain('Cursor 当前登录 other@example.com，活跃账号 work@example.com')
  })

  it('合并状态行：仅一侧有信号照常渲染；全部无信号不渲染', () => {
    const runtimeOnly = renderToStaticMarkup(
      <SettingsPage {...propsFor({ runtimeMatch: { status: 'matched', cursorLabel: 'a@x.com', activeLabel: 'a@x.com' } })} />
    )
    expect(runtimeOnly).toContain('a@x.com · 一致')

    const membershipError = renderToStaticMarkup(
      <SettingsPage {...propsFor({ membership: { state: 'error', detail: 'HTTP 503' } })} />
    )
    expect(membershipError).toContain('account-status-line is-warn')
    expect(membershipError).toContain('档位获取失败')

    for (const props of [
      { runtimeMatch: { status: 'vault_empty' as const } },
      { runtimeMatch: { status: 'cursor_unavailable' as const } },
      { membership: { state: 'not_logged_in' as const } },
      {}
    ]) {
      const html = renderToStaticMarkup(<SettingsPage {...propsFor(props)} />)
      expect(html).not.toContain('account-status-line')
    }
  })

  it('本地身份一致但服务端 401 时明确区分“身份相同”与“会话有效”', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'a@x.com', activeLabel: 'a@x.com' },
        membership: { state: 'auth_expired', detail: '服务端已撤销当前会话（HTTP 401）' }
      })} />
    )
    expect(html).toContain('account-status-line is-off')
    expect(html).toContain('a@x.com · 一致 · 服务端会话已失效')
    expect(html).toContain('“一致”只表示本地 JWT 账号标识相同')
  })

  it('keeps every existing feature entry point', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, browserHost: 'external' },
        onImportFromFingerprint: async () => {}
      })} />
    )

    // 账号库存：选择 / 切换并重启 / 处理 / 删除
    expect(html).toContain('work@example.com')
    expect(html).toContain('>处理</button>')
    expect(html).toContain('>切换并重启</button>')
    expect(html).toContain('>删除</button>')
    // 获取路径并列（external 来源下从浏览器导入为工作流主路径）
    expect(html).toContain('从浏览器导入 Token')
    expect(html).toContain('自动获取本机 Token')
    expect(html).toContain('手动粘贴卡号 / Token')
    expect(html).not.toContain('其他获取方式')
    // 奥仔卡密：刷新余额 / 更换卡密
    expect(html).toContain('刷新余额')
    expect(html).toContain('更换卡密')
    // 奥仔手动处理：独立于自动化的任意 Token 直提入口
    expect(html).toContain('手动处理')
    expect(html).toContain('aria-label="手动处理的 Session Token"')
    expect(html).toContain('提交处理')
    // 自动化开关（自绘 ToggleSwitch，保留原生 checkbox 可达性）与倒计时步进输入
    expect(html).toContain('会话创建后自动处理账号')
    expect(html).toContain('toggle-switch')
    expect(html).toContain('role="spinbutton"')
    expect(html).toContain('aria-label="奥仔处理前倒计时秒数"')
    expect(html).toContain('aria-label="奥仔完成后账号加固前倒计时秒数"')
    // Cursor 本机维护
    expect(html).toContain('关闭 Cursor 自动更新')
    expect(html).toContain('受限模型数据政策')
    expect(html).toContain('自动确认受限模型数据政策')
  })

  it('shows the countdown scene with remaining seconds and a cancel button', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationRun: runFor({
          phase: 'countdown',
          message: '将在 6.5s 后自动处理当前账号（可取消）',
          remainingSec: 6.5,
          startedAt: 1_000
        })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 2：倒计时，进行"')
    expect(html).toContain('aria-label="自动化倒计时"')
    expect(html).toContain('6.5')
    expect(html).toContain('将在 6.5s 后自动处理当前账号（可取消）')
    expect(html).toContain('flow-step__cancel')
    expect(html).toContain('>取消</button>')
  })

  it('streams the live message on the processing step', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationRun: runFor({ phase: 'processing', message: '奥仔：正在提交 Session Token 处理…', startedAt: 1_000 })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 3：奥仔处理，进行"')
    expect(html).toContain('aria-label="步骤 2：倒计时，完成"')
    expect(html).toContain('aria-live="polite">奥仔：正在提交 Session Token 处理…')
  })

  it('summarizes a done run with duration on the finish step', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationRun: runFor({
          phase: 'done',
          message: '自动化完成：已处理、账号已加固、本地记录已移除',
          startedAt: 10_000,
          finishedAt: 22_500
        })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 5：收尾，完成"')
    expect(html).toContain('耗时 12.5 秒')
    expect(html).toContain('自动化完成：已处理、账号已加固、本地记录已移除')
  })

  it('shows the full error message when the run failed', () => {
    const message = '奥仔处理失败：卡密余额不足，请先充值或更换卡密（本地账号已保留）'
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationRun: runFor({ phase: 'failed', message, startedAt: 10_000, finishedAt: 20_000 })
      })}
      />
    )

    // 无活跃轨迹时按消息文案归属到奥仔处理步骤
    expect(html).toContain('aria-label="步骤 3：奥仔处理，失败"')
    expect(html).toContain('aria-label="步骤 5：收尾，失败"')
    expect(html).toContain('role="alert"')
    expect(html).toContain(`流程未完成：${message}`)
  })

  it('hints the failed step from persisted run messages', () => {
    expect(automationFailedStepHint('奥仔处理失败：卡密余额不足')).toBe('processing')
    expect(automationFailedStepHint('新 Token 获取失败：网络超时（本地账号已保留）')).toBe('deleting')
    expect(automationFailedStepHint('官网持续要求先退出团队（已等待 60s 重试 3 次）')).toBe('deleting')
    expect(automationFailedStepHint('尚未选择 Cursor 账号，自动化中止')).toBe('countdown')
    // preflight 类失败含「会话」但发生在倒计时阶段，不能误标到删除步骤
    expect(automationFailedStepHint('浏览器会话读取失败，请先登录')).toBe('countdown')
    // 加固前倒计时取消的消息归属到删除步骤
    expect(automationFailedStepHint('奥仔处理已完成；已取消后续账号加固，本地账号保留')).toBe('deleting')
  })

  it('marks a cancelled run without pretending progress', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationRun: runFor({ phase: 'cancelled', message: '已取消本次自动化', startedAt: 10_000, finishedAt: 14_000 })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 2：倒计时，已取消"')
    expect(html).toContain('aria-label="步骤 5：收尾，已取消"')
    expect(html).toContain('已取消本次自动化')
  })

  it('labels the countdown step as off when automation is disabled', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({ automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: false, delaySec: 10 } })} />
    )

    expect(html).not.toContain('aria-label="账号自动化流程"')
    expect(html).toContain('会话创建后自动处理账号')
  })

  it('renders the browser source segment with fingerprint default in step 1', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        bitProfiles: [
          { id: 'bit-proxy', name: '代理', seq: 1 },
          { id: 'bit-direct', name: '直连', seq: 2 }
        ],
        onRefreshBitProfiles: () => {},
        onImportFromFingerprint: async () => {}
      })} />
    )

    // 分段控件在第一步「获取 Token」，默认选中指纹
    expect(html).toContain('aria-label="浏览器来源切换"')
    expect(html).toContain('会话浏览器')
    expect(html).toContain('贯穿全流程')
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?<strong>指纹浏览器<\/strong>/)
    expect(html).toMatch(/aria-selected="false"[^>]*>[\s\S]*?<strong>系统浏览器<\/strong>/)
    // 紧凑配置行：自绘下拉关闭态只显示占位符（选项列表展开时才渲染）
    expect(html).not.toContain('<option value="roxybrowser">Roxy</option>')
    expect(html).toContain('menu-select__button')
    expect(html).toContain('选择窗口…')
    expect(html).not.toContain('#1 代理')
    // 主导入按钮
    expect(html).toContain('从指纹浏览器导入（推荐）')
  })

  it('已选指纹窗口时下拉按钮直接显示窗口名（自绘 MenuSelect 选中态）', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        bitProfiles: [
          { id: 'bit-proxy', name: '代理', seq: 1 },
          { id: 'bit-direct', name: '直连', seq: 2 }
        ],
        onImportFromFingerprint: async () => {}
      })} />
    )

    expect(html).toContain('#1 代理')
    expect(html).not.toContain('选择窗口…')
    // 选中窗口后主导入按钮解除禁用
    expect(html).not.toContain('请先在上方选择指纹浏览器窗口')
  })

  it('external source shows edge hint and browser import as quick action', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, browserHost: 'external' },
        bitProfiles: [{ id: 'bit-proxy', name: '代理', seq: 1 }],
        onImportFromFingerprint: async () => {}
      })} />
    )

    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?<strong>系统浏览器<\/strong>/)
    expect(html).toContain('需在 Edge / Chrome 登录 cursor.com')
    expect(html).toContain('从浏览器导入 Token')
    expect(html).not.toContain('从指纹浏览器导入（推荐）')
    expect(html).not.toContain('选择窗口…')
  })

  it('fingerprint import button disabled until a window is picked', () => {
    const noWindow = renderToStaticMarkup(
      <SettingsPage {...propsFor({ onImportFromFingerprint: async () => {} })} />
    )
    expect(noWindow).toContain('请先在上方选择指纹浏览器窗口')
    // 未选窗口时按钮渲染为 disabled
    expect(noWindow).toMatch(/disabled=""[^>]*>导入中…|从指纹浏览器导入（推荐）</)
    const picked = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        onImportFromFingerprint: async () => {}
      })} />
    )
    expect(picked).toContain('打开选定的指纹浏览器窗口读取登录态 Token')
  })

  it('renders the open-login-page quick action beside the fingerprint import (fingerprint host)', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        onImportFromFingerprint: async () => {},
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(html).toContain('>打开网页登录</button>')
    expect(html).toContain('未登录可先登录')

    // 未选窗口 → 渲染但 disabled（与指纹导入按钮同语义，title 引导选择窗口）
    const noWindow = renderToStaticMarkup(
      <SettingsPage {...propsFor({ onOpenFingerprintLogin: async () => {} })} />
    )
    expect(noWindow).toMatch(/disabled=""[^>]*title="请先在上方选择指纹浏览器窗口"[^>]*>打开网页登录</)

    // 自动化活跃阶段禁用：此时导航的正是自动化链在用的 tab（破坏就绪探测/轮换基准）
    const active = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        automationRun: runFor({ phase: 'processing', message: '奥仔自助处理中…', startedAt: 1 }),
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(active).toMatch(/disabled=""[^>]*>打开网页登录</)
  })

  it('hides the open-login-page action for the external browser host', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, browserHost: 'external' },
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(html).not.toContain('>打开网页登录</button>')
  })

  it('shows the roxy api key input in step 1 when key missing (all platforms)', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        roxyApiKeyStatus: { saved: false },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    expect(html).toContain('placeholder="Roxy API Key"')
  })

  it('shows saved roxy key mask instead of the input', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        roxyApiKeyStatus: { saved: true, maskedKey: '6192****eada' },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    expect(html).toContain('6192****eada')
    expect(html).not.toContain('placeholder="Roxy API Key"')
  })

  it('shows the fingerprint browser fetch failure message inside the source card', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        bitProfilesMessage: 'RoxyBrowser Local API 不可达——请确认 RoxyBrowser 客户端已运行且 API 状态为 Enabled'
      })} />
    )

    expect(html).toContain('RoxyBrowser Local API 不可达')
    expect(html).toContain('role="alert"')
  })

  it('countdown step has no browser controls, only the follow note', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' }
      })} />
    )

    // 跟随文案按「活跃账号绑定 ?? 默认窗口」实时解析（fixture 账号未绑定 → 走默认窗口）
    expect(html).toContain('执行浏览器：指纹浏览器（Roxy）· 未绑定，走默认窗口「bit-proxy」')
    // 倒计时步骤不再有浏览器路径/provider 选择
    expect(html).not.toContain('浏览器路径')
  })

  it('macos: external browser host remains selectable (fingerprint provider is Roxy on both platforms)', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        platform: 'darwin',
        roxyApiKeyStatus: { saved: true, maskedKey: '6192****eada' },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    // mac 上系统浏览器宿主（Keychain + Apple Events）仍可选；Roxy Key 掩码双平台展示
    expect(html).toMatch(/aria-selected="false"[^>]*>[\s\S]*?<strong>系统浏览器<\/strong>/)
    expect(html).toContain('6192****eada')
  })

  it('席位自动轮换区块：有设置才渲染；开关状态决定阈值滑杆是否展开；阈值以气泡数读出', () => {
    const absent = renderToStaticMarkup(<SettingsPage {...propsFor()} />)
    expect(absent).not.toContain('席位自动轮换')

    const enabled = renderToStaticMarkup(
      <SettingsPage {...propsFor({ seatRotationSettings: { enabled: true, bubbleThreshold: 450 }, onSaveSeatRotationSettings: () => {} })} />
    )
    const toggleInput = (html: string): string => html.match(/<input[^>]*aria-label="到阈值自动换新会话"[^>]*>/)?.[0] ?? ''
    expect(enabled).toContain('席位自动轮换')
    expect(enabled).toContain('到阈值自动换新会话')
    expect(toggleInput(enabled)).toContain('checked=""')
    expect(enabled).toContain('触发阈值')
    expect(enabled).toContain('450')
    expect(enabled).toContain('气泡')
    // 账号自动化那一段仍在，且不受奥仔卡密门禁影响
    expect(enabled).toContain('会话创建后自动处理账号')

    const disabled = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        aozaiStatus: { saved: false },
        seatRotationSettings: { enabled: false, bubbleThreshold: 400 },
        onSaveSeatRotationSettings: () => {}
      })} />
    )
    expect(disabled).toContain('席位自动轮换')
    expect(toggleInput(disabled)).not.toContain('checked=""')
    // 关闭时参数区折叠（settings-collapse 不带 is-open）
    const section = disabled.slice(disabled.indexOf('席位自动轮换'))
    expect(section).toContain('class="settings-collapse"')
    expect(section).not.toContain('settings-collapse is-open')
  })

  it('奥仔手动处理区：有卡密且有回调才渲染；无卡密或无回调时隐藏', () => {
    const withCard = renderToStaticMarkup(<SettingsPage {...propsFor()} />)
    expect(withCard).toContain('手动处理')
    expect(withCard).toContain('aria-label="手动处理的 Session Token"')

    const noCard = renderToStaticMarkup(<SettingsPage {...propsFor({ aozaiStatus: { saved: false } })} />)
    expect(noCard).not.toContain('手动处理')

    const noHandler = renderToStaticMarkup(<SettingsPage {...propsFor({ onProcessAozaiToken: undefined })} />)
    expect(noHandler).not.toContain('手动处理')
  })

  it('hides the external browser segment on windows', () => {
    const html = renderToStaticMarkup(
      <SettingsPage {...propsFor({
        platform: 'win32',
        automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' }
      })} />
    )
    // 系统浏览器宿主是 macOS 专属（Keychain + Apple Events），Windows 不提供
    expect(html).not.toContain('>系统浏览器</button>')
    expect(html).not.toContain('需在 Edge / Chrome 登录 cursor.com')
    expect(html).toContain('指纹浏览器（Roxy）')
  })
})
