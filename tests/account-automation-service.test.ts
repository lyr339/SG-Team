import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountAutomationService } from '../src/application/account-automation-service'
import { AccountAutomationSettingsStore } from '../src/application/account-automation-store'
import type { AccountAutomationRun } from '../src/domain/account-automation'
import { DEFAULT_CURSOR_CHECKOUT_PROFILE } from '../src/domain/cursor-checkout-profile'

interface FakeAccount {
  id: string
  label: string
  active: boolean
  token: string
  /** 账号绑定的指纹窗口（映射进 metadata，驱动 preflight 的绑定态文案）。 */
  fingerprintProfileId?: string
  removed?: boolean
}

interface DeleteResultSpec {
  ok: boolean
  message: string
  authExpired?: boolean
  needLeaveTeam?: boolean
  status?: number
  retryAfterSec?: number
  rateLimited?: boolean
}

interface FastChannelSpec {
  kind: 'deleted' | 'retry_legacy' | 'not_logged_in'
  message?: string
}

interface HarnessOptions {
  enabled?: boolean
  delaySec?: number
  /** 加固前第二段倒计时（缺省回落 delaySec，与旧设置迁移语义一致）。 */
  postProcessDelaySec?: number
  cardSaved?: boolean
  accounts?: FakeAccount[]
  processResult?: { ok: boolean; message: string; remaining?: number }
  browserToken?: string
  browserTokenError?: string
  readBrowserToken?: string
  /** 按调用次序返回的浏览器 token 队列（早查/复检分叉场景）；队列空后回退 readBrowserToken。 */
  readBrowserTokenQueue?: string[]
  readBrowserTokenError?: string
  /** 倒计时后复检开关（仅 false 时注入落盘；缺省 = 开启）。 */
  preflightRecheckEnabled?: boolean
  deleteResult?: DeleteResultSpec
  /** 逐次返回的删除结果队列（优先于 deleteResult）。 */
  deleteResults?: DeleteResultSpec[]
  /** 秒级通道行为（提供时注入 inBrowserDeleter）。 */
  inBrowser?: FastChannelSpec
  /** finalizeDeletedAccount 的注入行为（默认成功 noop；hang = 永不返回，用于看门狗）。 */
  finalize?: { error?: string; hang?: boolean }
  /** Cursor 运行态一致性核对（提供时注入 verifyCursorRuntime）。 */
  verifyCursorRuntime?: { ok: boolean; reason?: string }
  seamlessHandoverEnabled?: boolean
  /** 切换前等待秒数（注入设置；缺省不落字段 = 立即热切）。 */
  handoverDelaySec?: number
  nextAccountId?: string
  liveSwitch?: (accountId: string) => Promise<{ switched: boolean; reason?: string; warning?: string; retryable?: boolean }>
  prepareLiveSwitch?: (accountId: string) => Promise<{ commit(): Promise<{ switched: boolean; reason?: string; warning?: string; retryable?: boolean }> }>
}

function createHarness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'account-automation-test-'))
  const store = new AccountAutomationSettingsStore(join(dir, 'settings.json'))
  store.save({
    enabled: options.enabled ?? true,
    delaySec: options.delaySec ?? 7,
    seamlessHandoverEnabled: options.seamlessHandoverEnabled ?? true,
    ...(options.postProcessDelaySec !== undefined ? { postProcessDelaySec: options.postProcessDelaySec } : {}),
    ...(options.handoverDelaySec !== undefined ? { handoverDelaySec: options.handoverDelaySec } : {}),
    ...(options.preflightRecheckEnabled === false ? { preflightRecheckEnabled: false } : {})
  })

  const accounts = (options.accounts ?? [{ id: 'acc-1', label: 'A', active: true, token: 'old-token' }])
    .map((account) => ({ ...account }))
  let clock = 0
  const processCalls: string[] = []
  const processOptions: Array<{ refreshRemaining?: boolean } | undefined> = []
  const warmupCalls: number[] = []
  const replacedTokens: Array<{ id: string; token: string }> = []
  const deleteCalls: string[] = []
  const deleteCallClocks: number[] = []
  const refreshCalls: string[] = []
  const prepareCalls: number[] = []
  const fastDeleteCalls: number[] = []
  const fastDeleteAccountIds: Array<string | undefined> = []
  const disposeCalls: number[] = []
  const clearSiteDataCalls: number[] = []
  const finalizeCalls: number[] = []
  const runMessages: string[] = []
  const liveSwitchCalls: string[] = []
  const liveSwitchOrder: string[] = []

  const service = new AccountAutomationService({
    settings: store,
    aozai: {
      processToken: async (token, _onProgress, processOptionsArg) => {
        liveSwitchOrder.push('process')
        processCalls.push(token)
        processOptions.push(processOptionsArg)
        return options.processResult ?? { ok: true, message: '处理完成', remaining: 45 }
      },
      warmup: async () => {
        warmupCalls.push(1)
      }
    },
    cardVault: {
      maskedCode: () => (options.cardSaved ?? true) ? 'C***1234' : undefined
    },
    accounts: {
      list: () => accounts.filter((a) => !a.removed).map((a) => ({
        id: a.id, label: a.label, maskedToken: '••••', active: a.active, createdAt: 0, updatedAt: 0,
        ...(a.fingerprintProfileId ? { fingerprintProfileId: a.fingerprintProfileId } : {})
      })),
      credential: (id?: string) => {
        const account = accounts.find((a) => (id ? a.id === id : a.active))
        if (!account) throw new Error('尚未选择 Cursor 账号')
        return account.token
      },
      replaceToken: (id, token) => {
        const account = accounts.find((a) => a.id === id)
        if (!account) throw new Error('Cursor 账号不存在')
        account.token = token
        replacedTokens.push({ id, token })
        return []
      },
      remove: (id) => {
        const account = accounts.find((a) => a.id === id)
        if (!account) throw new Error('Cursor 账号不存在')
        account.removed = true
        return []
      }
    },
    refreshBrowserToken: async (previousToken: string) => {
      refreshCalls.push(previousToken)
      if (options.browserTokenError) throw new Error(options.browserTokenError)
      // previousToken 必须是当前活跃账号的凭据（不再硬编码 'old-token'，以覆盖 user::jwt 形态）
      const activeToken = accounts.find((a) => a.active)?.token
      if (previousToken !== activeToken) throw new Error('previousToken 未正确传递')
      return options.browserToken ?? 'new-token-from-browser'
    },
    ...(options.readBrowserToken !== undefined || options.readBrowserTokenError !== undefined || options.readBrowserTokenQueue !== undefined
      ? {
          readBrowserToken: async () => {
            if (options.readBrowserTokenError) throw new Error(options.readBrowserTokenError)
            const queued = options.readBrowserTokenQueue?.shift()
            return queued ?? options.readBrowserToken ?? ''
          }
        }
      : {}),
    deleter: {
      deleteAccount: async (token) => {
        deleteCalls.push(token)
        deleteCallClocks.push(clock)
        if (options.deleteResults?.length) return options.deleteResults.shift()!
        return options.deleteResult ?? { ok: true, message: 'Cursor 官网账号已删除' }
      }
    },
    ...((options.liveSwitch || options.prepareLiveSwitch) ? {
      ...(options.liveSwitch ? {
        liveSwitch: async (accountId: string) => {
          liveSwitchCalls.push(accountId)
          return options.liveSwitch!(accountId)
        }
      } : {}),
      ...(options.prepareLiveSwitch ? {
        prepareLiveSwitch: async (accountId: string) => {
          liveSwitchOrder.push(`prepare:${accountId}`)
          const prepared = await options.prepareLiveSwitch!(accountId)
          return {
            commit: async () => {
              liveSwitchOrder.push(`commit:${accountId}`)
              return prepared.commit()
            }
          }
        }
      } : {}),
      pickNextAccount: () => options.nextAccountId
    } : {}),
    ...(options.inBrowser
      ? {
          inBrowserDeleter: {
            prepareRefresh: async () => {
              prepareCalls.push(1)
            },
            deleteWhenReady: async (expectedAccountId?: string) => {
              fastDeleteCalls.push(1)
              fastDeleteAccountIds.push(expectedAccountId)
              const spec = options.inBrowser!
              if (spec.kind === 'deleted') return { kind: 'deleted' as const }
              if (spec.kind === 'not_logged_in') {
                return { kind: 'not_logged_in' as const, message: spec.message ?? '浏览器会话已退出登录（页面停留在认证/登录页）' }
              }
              return { kind: 'retry_legacy' as const, message: spec.message ?? '页面加载超时' }
            },
            dispose: async () => {
              disposeCalls.push(1)
            },
            clearSiteData: async () => {
              clearSiteDataCalls.push(1)
            },
            finalizeDeletedAccount: async () => {
              finalizeCalls.push(1)
              if (options.finalize?.hang) return new Promise<void>(() => {})
              if (options.finalize?.error) throw new Error(options.finalize.error)
            }
          }
        }
      : {}),
    ...(options.verifyCursorRuntime
      ? {
          verifyCursorRuntime: () => options.verifyCursorRuntime!
        }
      : {}),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  })
  service.subscribe((run) => {
    runMessages.push(run.message)
  })
  return {
    service,
    store,
    dir,
    accounts,
    processCalls,
    processOptions,
    warmupCalls,
    replacedTokens,
    deleteCalls,
    deleteCallClocks,
    refreshCalls,
    prepareCalls,
    fastDeleteCalls,
    fastDeleteAccountIds,
    disposeCalls,
    clearSiteDataCalls,
    finalizeCalls,
    runMessages,
    liveSwitchCalls,
    liveSwitchOrder,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** maxPolls：看门狗场景要按 0.5s 步进走完几分钟的虚拟时钟，微任务轮次远多于常规链。 */
async function waitForTerminal(service: AccountAutomationService, maxPolls = 1_000): Promise<AccountAutomationRun> {
  for (let i = 0; i < maxPolls; i += 1) {
    const run = service.getRun()
    if (['done', 'failed', 'cancelled'].includes(run.phase)) return run
    await Promise.resolve()
  }
  throw new Error('run did not reach terminal phase')
}

describe('AccountAutomationService', () => {
  let cleanup = (): void => {}
  afterEach(() => cleanup())

  it('删除成功后走 finalize 收尾事务；清场异常降级为收尾提示不阻断 done', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'deleted' },
      finalize: { error: 'Roxy profile 清场未完成：本地缓存清理失败' }
    })
    try {
      await harness.service.onAllSessionsTriggered('plan-1')
      const run = await waitForTerminal(harness.service)
      // 加固已成功：终态 done（不因清场失败置 failed——旧版曾把收尾异常误报成流程失败）。
      expect(run.phase).toBe('done')
      expect(run.message).toContain('浏览器会话内秒级执行')
      expect(run.message).toContain('收尾异常（不影响加固结果）：浏览器清场未完成：Roxy profile 清场未完成：本地缓存清理失败')
      expect(harness.finalizeCalls).toHaveLength(1)
      // 本地记录仍被移除（两项分别执行）。
      expect(harness.accounts.some((account) => account.removed)).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('finalize 成功时完整收尾：清场调用一次、消息含环境已清场、不再叠加 legacy clear', async () => {
    const harness = createHarness({ inBrowser: { kind: 'deleted' } })
    try {
      await harness.service.onAllSessionsTriggered('plan-1')
      const run = await waitForTerminal(harness.service)
      expect(run.phase).toBe('done')
      expect(run.message).toBe('自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、浏览器环境已清场')
      expect(harness.finalizeCalls).toHaveLength(1)
      // finalize 在场时不走 legacy clearSiteData。
      expect(harness.clearSiteDataCalls).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it('完整链（会话仍有效）：倒计时→奥仔→当前会话直接删官网→移除本地，全程不碰浏览器', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.deleteCalls).toEqual(['old-token'])
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('完整链（会话已失效）：奥仔→删除遇 307→浏览器换新 token 入库→新会话删除→移除本地', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.refreshCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toEqual([{ id: 'acc-1', token: 'new-token-from-browser' }])
    expect(harness.deleteCalls).toEqual(['old-token', 'new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('归属复核：轮换出的新会话属于其他账号 → 中止防误删（不入库、不删除、保留本地）', async () => {
    const harness = createHarness({
      accounts: [{ id: 'acc-1', label: 'A', active: true, token: 'user_aaa::old-jwt' }],
      deleteResults: [{ ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' }],
      browserToken: 'user_bbb::new-jwt' // 窗口已被改登成别的账号
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('新会话已属于其他账号')
    // 错账号凭据绝不入库、绝不用于删除；本地记录保留
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.deleteCalls).toEqual(['user_aaa::old-jwt'])
    expect(harness.accounts[0]?.removed).not.toBe(true)
  })

  it('归属复核：同账号轮换（user_aaa::old → user_aaa::new）→ 守卫放行并走通轮换链', async () => {
    const harness = createHarness({
      accounts: [{ id: 'acc-1', label: 'A', active: true, token: 'user_aaa::old-jwt' }],
      deleteResults: [
        { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ],
      browserToken: 'user_aaa::new-jwt'
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.replacedTokens).toEqual([{ id: 'acc-1', token: 'user_aaa::new-jwt' }])
    expect(harness.deleteCalls).toEqual(['user_aaa::old-jwt', 'user_aaa::new-jwt'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('秒级通道收到被处理账号的归属前缀（userId），供页内删除前守门', async () => {
    const harness = createHarness({
      accounts: [{ id: 'acc-1', label: 'A', active: true, token: 'user_aaa::old-jwt' }],
      inBrowser: { kind: 'deleted' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.fastDeleteAccountIds).toEqual(['user_aaa'])
  })

  it('秒级通道归属前缀：token 非 user::jwt 形态时传 undefined（守卫退化为不拦）', async () => {
    const harness = createHarness({ inBrowser: { kind: 'deleted' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.fastDeleteAccountIds).toEqual([undefined])
  })

  it('删除被拒（非会话失效，如仍有有效订阅）→ 不轮换、直接失败并保留本地记录', async () => {
    const harness = createHarness({
      deleteResults: [{ ok: false, message: 'workspace has active subscription' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('active subscription')
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).not.toBe(true)
  })

  it('提速策略：倒计时末预热登录，且链内跳过余额刷新', async () => {
    const harness = createHarness({ delaySec: 7 })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.warmupCalls).toHaveLength(1)
    expect(harness.processOptions[0]).toEqual({ refreshRemaining: false })
  })

  it('运行态硬闸：Cursor 登录 ≠ 活跃账号 → 倒计时前即中止（卡密未扣、账号保留）', async () => {
    const harness = createHarness({
      verifyCursorRuntime: { ok: false, reason: 'Cursor 当前登录 b@x.com，与拾光活跃账号 a@x.com 不一致，请先执行「切换并重启」' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('不一致')
    expect(harness.processCalls).toHaveLength(0)
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('运行态硬闸：核对通过 → 链路照常执行', async () => {
    const harness = createHarness({
      verifyCursorRuntime: { ok: true }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('开关关闭时不触发', async () => {
    const harness = createHarness({ enabled: false })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    await Promise.resolve()
    expect(harness.service.getRun().phase).toBe('idle')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('浏览器会话与凭据一致 → 校验通过并走完整链', async () => {
    const harness = createHarness({ readBrowserToken: 'old-token' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
  })

  it('浏览器会话与拾光凭据不一致 → 消耗卡密前中止', async () => {
    const harness = createHarness({ readBrowserToken: 'some-other-token' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('凭据不一致')
    expect(harness.processCalls).toHaveLength(0)
    expect(harness.deleteCalls).toHaveLength(0)
  })

  it('preflight 文案按绑定态精准归因：未绑定账号指向默认窗口', async () => {
    const harness = createHarness({ readBrowserToken: 'some-other-token' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('默认指纹窗口登录态与拾光凭据不一致')
    expect(run.message).toContain('请重新从浏览器导入 Token')
  })

  it('preflight 文案按绑定态精准归因：已绑定账号点出绑定窗口与修法', async () => {
    const harness = createHarness({
      readBrowserToken: 'some-other-token',
      accounts: [{ id: 'acc-1', label: '工作号', active: true, token: 'old-token', fingerprintProfileId: 'win-1' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('账号「工作号」绑定的指纹窗口登录态与拾光凭据不一致')
    expect(run.message).toContain('改绑窗口')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('preflight 未登录：已绑定账号的文案指到绑定窗口', async () => {
    const harness = createHarness({
      readBrowserToken: '',
      accounts: [{ id: 'acc-1', label: '工作号', active: true, token: 'old-token', fingerprintProfileId: 'win-1' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('账号「工作号」绑定的指纹窗口未登录 cursor.com')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('浏览器会话读取失败 → 消耗卡密前中止', async () => {
    const harness = createHarness({ readBrowserTokenError: '钥匙串读取失败' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('默认指纹窗口读取失败')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('同一 plan 只执行一次（重复事件去重）', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toHaveLength(1)
  })

  it('倒计时阶段可取消，不消耗卡密', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.cancel()
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('cancelled')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('加固前倒计时可取消：奥仔已完成（卡密已扣）、不执行删除、本地账号保留', async () => {
    const harness = createHarness({ postProcessDelaySec: 7 })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    for (let i = 0; i < 1_000 && harness.service.getRun().phase !== 'hardening-countdown'; i += 1) {
      await Promise.resolve()
    }
    expect(harness.service.getRun().phase).toBe('hardening-countdown')
    harness.service.cancel()
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('cancelled')
    expect(run.message).toContain('已取消后续账号加固')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).not.toBe(true)
  })

  it('加固前倒计时独立计时：第二段走完后照常执行删除', async () => {
    const harness = createHarness({ delaySec: 7, postProcessDelaySec: 3 })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.runMessages.some((message) => message.includes('3s 后加固当前账号'))).toBe(true)
    expect(harness.deleteCalls).toEqual(['old-token'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('未配置卡密 → 倒计时后明确失败，不动账号', async () => {
    const harness = createHarness({ cardSaved: false })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('奥仔卡密')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('未选择账号 → 明确失败', async () => {
    const harness = createHarness({ accounts: [{ id: 'acc-1', label: 'A', active: false, token: 't' }] })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('尚未选择')
  })

  it('奥仔处理失败 → 中止并保留本地账号', async () => {
    const harness = createHarness({ processResult: { ok: false, message: '卡密次数用尽' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('卡密次数用尽')
    expect(run.message).toContain('已保留')
    expect(harness.accounts[0]?.removed).toBeFalsy()
    expect(harness.deleteCalls).toHaveLength(0)
  })

  it('浏览器会话刷新失败（会话已失效路径）→ 中止并保留本地账号', async () => {
    const harness = createHarness({
      browserTokenError: '浏览器会话刷新超时',
      deleteResults: [{ ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('浏览器会话刷新超时')
    expect(run.message).toContain('已保留')
    expect(harness.accounts[0]?.removed).toBeFalsy()
    expect(harness.deleteCalls).toEqual(['old-token'])
  })

  it('官网删除失败（新会话路径）→ 新 token 已入库但本地记录保留', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' },
        { ok: false, message: '官网拒绝了删除请求' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('官网拒绝了删除请求')
    expect(harness.replacedTokens).toHaveLength(1)
    expect(harness.deleteCalls).toEqual(['old-token', 'new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('秒级通道：会话已失效 → 浏览器会话内直接删除（不轮换、不入库）', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'deleted' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(run.message).toContain('秒级')
    expect(harness.prepareCalls).toHaveLength(1)
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
    // 一轮结束即清理浏览器通道（关窗断连；cookie 保留在 profile）
    expect(harness.disposeCalls).toHaveLength(1)
    // 账号隔离：删除成功后关窗前清空站点数据（防下一账号被风控关联）
    expect(harness.finalizeCalls).toHaveLength(1)
  })

  it('账号隔离：删除成功（fallback 轮换链）→ 同样清空站点数据', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'retry_legacy', message: '页面加载超时' },
      deleteResults: [{ ok: true, message: 'Cursor 官网账号已删除' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.finalizeCalls).toHaveLength(1)
  })

  it('账号隔离：未删除（not_logged_in 硬失败）→ 不清站点数据（会话本已失效，清场无意义且掩盖现场）', async () => {
    const harness = createHarness({ inBrowser: { kind: 'not_logged_in' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    await waitForTerminal(harness.service)
    expect(harness.clearSiteDataCalls).toHaveLength(0)
  })

  it('秒级通道不可用 → 回退 cookie 轮换链完成删除', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'retry_legacy', message: '页面加载超时' },
      deleteResults: [{ ok: true, message: 'Cursor 官网账号已删除' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.refreshCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toEqual([{ id: 'acc-1', token: 'new-token-from-browser' }])
    expect(harness.deleteCalls).toEqual(['new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('轮换超时兜底：奥仔副作用延迟旧会话仍有效 → 用旧 token 直删完成（不轮换、不入库）', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'retry_legacy', message: 'token 轮换超时（认证链未换发新会话，回退协议链）' },
      browserTokenError: '指纹浏览器会话刷新超时：token 未轮换',
      deleteResults: [{ ok: true, message: 'Cursor 官网账号已删除' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(run.message).toContain('当前会话直接执行')
    expect(harness.refreshCalls).toEqual(['old-token'])
    expect(harness.deleteCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
    // 删除成功即账号隔离清场（与秒级/轮换两条完成路径同契约）
    expect(harness.finalizeCalls).toHaveLength(1)
  })

  it('轮换超时兜底：旧会话直删亦失效 → 双证据并入失败消息并保留本地记录', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'retry_legacy', message: 'token 轮换超时（认证链未换发新会话，回退协议链）' },
      browserTokenError: '指纹浏览器会话刷新超时：token 未轮换',
      deleteResults: [{ ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('新 Token 获取失败')
    expect(run.message).toContain('旧会话加固未成功')
    expect(harness.deleteCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBeFalsy()
    expect(harness.clearSiteDataCalls).toHaveLength(0)
  })

  it('秒级通道检测未登录 → 硬失败并保留记录（不再轮换）', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'not_logged_in' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('退出登录')
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('秒级通道作为主路径：不先打旧 token 删除，避免旧会话错误拖慢', async () => {
    const harness = createHarness({ inBrowser: { kind: 'deleted' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.prepareCalls).toHaveLength(1)
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.refreshCalls).toHaveLength(0)
  })

  it('官网要求先退团 → 自动等待重试直至成功（副作用落地延迟，不识败）', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team before deleting your account.' },
        { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team before deleting your account.' },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.deleteCalls).toEqual(['old-token', 'old-token', 'old-token'])
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('持续要求退团超过 60s 重试窗 → 明确失败并保留记录', async () => {
    const harness = createHarness({
      deleteResult: { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('持续要求先退出团队')
    expect(harness.deleteCalls.length).toBeGreaterThan(10)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('倒计时中新一轮触发取代旧轮，只执行一次完整链', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.onAllSessionsTriggered('plan-2')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(run.planId).toBe('plan-2')
    expect(harness.processCalls).toHaveLength(1)
  })

  it('设置持久化：非法值被钳制（0.5–60 秒），支持半秒步进', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    const saved = harness.store.save({ enabled: true, delaySec: 99999 })
    expect(saved.delaySec).toBe(60)
    expect(harness.store.load()).toEqual({
      enabled: true,
      delaySec: 60,
      // 旧设置迁移：postProcessDelaySec 缺省沿用 delaySec（同步钳制）
      postProcessDelaySec: 60,
      browserHost: 'fingerprint',
      bitProfileId: undefined,
      autoAcknowledgeModelDataPolicies: true,
      seamlessHandoverEnabled: true,
      // 账单资料恒归一为完整结构（缺省给整套默认；编辑中途空串原样保留）
      checkoutProfile: DEFAULT_CURSOR_CHECKOUT_PROFILE
    })
    const low = harness.store.save({ enabled: true, delaySec: 0 })
    expect(low.delaySec).toBe(0.5)
    // 半秒步进：保留 0.5 精度，非 0.5 倍数对齐到最近半秒
    expect(harness.store.save({ enabled: true, delaySec: 2.5 }).delaySec).toBe(2.5)
    expect(harness.store.save({ enabled: true, delaySec: 2.3 }).delaySec).toBe(2.5)
    expect(harness.store.save({ enabled: true, delaySec: 2.2 }).delaySec).toBe(2)
  })

  it('复检开关关闭时：倒计时后不再复读浏览器会话（会话改动不拦截，流程走完）', async () => {
    const harness = createHarness({
      // 早查一致、复检时已变为他人会话：开关关闭时不再拦截
      readBrowserTokenQueue: ['old-token', 'some-other-token'],
      preflightRecheckEnabled: false
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('recheck-off')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
  })

  it('复检开关默认开启：倒计时后会话变为不一致 → 消耗卡密前中止', async () => {
    const harness = createHarness({
      readBrowserTokenQueue: ['old-token', 'some-other-token']
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('recheck-on')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('凭据不一致')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('复检开关关闭不影响早查：倒计时前会话不一致仍中止', async () => {
    const harness = createHarness({
      readBrowserToken: 'some-other-token',
      preflightRecheckEnabled: false
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('recheck-off-early')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('凭据不一致')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('preflightRecheckEnabled 归一化：缺省开启不落盘，显式关闭才落 false', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({ enabled: true, delaySec: 5 }).preflightRecheckEnabled).toBeUndefined()
    expect(harness.store.save({ enabled: true, delaySec: 5, preflightRecheckEnabled: true }).preflightRecheckEnabled).toBeUndefined()
    expect(harness.store.save({ enabled: true, delaySec: 5, preflightRecheckEnabled: false }).preflightRecheckEnabled).toBe(false)
  })

  it('切换前等待：handoverDelaySec > 0 时退款后先倒计时再提交热切', async () => {    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      handoverDelaySec: 3,
      prepareLiveSwitch: async () => ({ commit: async () => ({ switched: true }) })
    })
    cleanup = harness.cleanup
    // handover 倒计时消息在子状态上（setRun 只更新 handover，主 message 不变），单独订阅收集
    const handoverMessages: string[] = []
    harness.service.subscribe((run) => { if (run.handover) handoverMessages.push(run.handover.message) })
    harness.service.onAllSessionsTriggered('live-delayed')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    // 顺序不变（预热 → 奥仔 → commit），但 commit 前出现了切换前倒计时消息
    expect(harness.liveSwitchOrder).toEqual(['prepare:acc-2', 'process', 'commit:acc-2'])
    expect(handoverMessages.some((message) => /票据已就绪，3s 后切换/.test(message))).toBe(true)
    expect(run.message).toContain('无感换号已完成')
  })

  it('切换前等待期间取消自动化：热切不再提交，收口如实呈现', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      handoverDelaySec: 60,
      postProcessDelaySec: 60,
      liveSwitch: async () => ({ switched: true })
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-delay-cancel')
    // 等热切进入等待（加固倒计时并行进行中，cancel 对该相位生效）
    for (let i = 0; i < 1_000 && harness.service.getRun().phase !== 'hardening-countdown'; i += 1) {
      await Promise.resolve()
    }
    expect(harness.service.getRun().phase).toBe('hardening-countdown')
    harness.service.cancel()
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('cancelled')
    // commit 从未发出；收口消息如实说明热切未发生
    expect(harness.liveSwitchCalls).toHaveLength(0)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(harness.service.getRun().message).toContain('无感换号已随自动化取消')
  })

  it('切换前等待设置为 0 / 缺省时保持立即热切（旧行为回归）', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      handoverDelaySec: 0,
      liveSwitch: async () => ({ switched: true })
    })
    cleanup = harness.cleanup
    const handoverMessages: string[] = []
    harness.service.subscribe((run) => { if (run.handover) handoverMessages.push(run.handover.message) })
    harness.service.onAllSessionsTriggered('live-immediate')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.liveSwitchCalls).toEqual(['acc-2'])
    // 0 秒 = 立即热切：handover 不出现切换前倒计时文案
    expect(handoverMessages.some((message) => /后切换/.test(message))).toBe(false)
  })

  it('切换前等待长于加固倒计时：删除先完成，done 等热切落地后收口', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      handoverDelaySec: 4,
      postProcessDelaySec: 1,
      liveSwitch: async () => ({ switched: true })
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-long-delay')
    const run = await waitForTerminal(harness.service)
    // 语义自洽：删除确实先于热切（delete 调用已发生），但 run.done 等热切 settle 后才定型
    expect(harness.deleteCalls.length).toBeGreaterThan(0)
    expect(harness.liveSwitchCalls).toEqual(['acc-2'])
    expect(run.phase).toBe('done')
    expect(run.message).toContain('无感换号已完成')
    // 热切耗时含等待期（startedAt 从票据预热起算）
    expect(run.handover?.status).toBe('done')
    expect((run.handover?.finishedAt ?? 0) - (run.handover?.startedAt ?? 0)).toBeGreaterThanOrEqual(4000)
  })

  it('handoverDelaySec 归一化：缺省/非法为 0 不落盘，0.5 步进，钳制 0–60', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({ enabled: true, delaySec: 5 }).handoverDelaySec).toBeUndefined()
    expect(harness.store.save({ enabled: true, delaySec: 5, handoverDelaySec: 2.3 }).handoverDelaySec).toBe(2.5)
    expect(harness.store.save({ enabled: true, delaySec: 5, handoverDelaySec: 90 }).handoverDelaySec).toBe(60)
    expect(harness.store.save({ enabled: true, delaySec: 5, handoverDelaySec: -4 }).handoverDelaySec).toBeUndefined()
    expect(harness.store.save({ enabled: true, delaySec: 5, handoverDelaySec: 0 }).handoverDelaySec).toBeUndefined()
  })

  it('退款后热切到接手账号，并把成功结果收进完成消息', async () => {    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      liveSwitch: async () => ({ switched: true })
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-success')
    const run = await waitForTerminal(harness.service)
    expect(harness.liveSwitchCalls).toEqual(['acc-2'])
    expect(run.message).toContain('无感换号已完成（Cursor 未重启）')
  })

  it('在奥仔处理前启动接手票据预热，退款成功后才提交运行态切换', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      prepareLiveSwitch: async () => ({ commit: async () => ({ switched: true }) })
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-prewarm')
    const run = await waitForTerminal(harness.service)
    expect(harness.liveSwitchOrder).toEqual(['prepare:acc-2', 'process', 'commit:acc-2'])
    expect(run.handover).toMatchObject({ accountId: 'acc-2', label: 'B', status: 'done' })
  })

  it('开关关闭或缺少接手账号时不触发热切', async () => {
    const disabled = createHarness({
      seamlessHandoverEnabled: false,
      nextAccountId: 'acc-2',
      liveSwitch: async () => ({ switched: true })
    })
    disabled.service.onAllSessionsTriggered('live-disabled')
    await waitForTerminal(disabled.service)
    expect(disabled.liveSwitchCalls).toHaveLength(0)
    disabled.cleanup()

    const noTarget = createHarness({ liveSwitch: async () => ({ switched: true }) })
    noTarget.service.onAllSessionsTriggered('live-no-target')
    await waitForTerminal(noTarget.service)
    expect(noTarget.liveSwitchCalls).toHaveLength(0)
    noTarget.cleanup()
    cleanup = () => {}
  })

  it('热切失败时只对同一接手账号补切一次，不切回已处理账号', async () => {
    let attempt = 0
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      liveSwitch: async () => ++attempt === 1
        ? { switched: false, reason: 'first timeout', retryable: true }
        : { switched: true }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-retry')
    const run = await waitForTerminal(harness.service)
    expect(harness.liveSwitchCalls).toEqual(['acc-2', 'acc-2'])
    expect(run.message).toContain('无感换号已完成（补切')
  })

  it('删除失败也统一结算已启动的热切结果', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      liveSwitch: async () => ({ switched: true, warning: '本地标记待修复' }),
      deleteResult: { ok: false, message: 'delete failed' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('live-failed-delete')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    // finally 可能在 waitForTerminal 观察到 failed 后继续补充消息，等待微任务收口。
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(harness.service.getRun().message).toContain('无感换号已完成，但需处理')
  })

  /*
   * 收尾看门狗：收尾相位不可取消、运行态只在内存里，任何一条支线「再也不返回」都曾让运行卡
   * 永远停在「收尾 · 进行中」（2026-09-17 实机：热切回环服务器关不掉）。下面三条分别钉住
   * 清场支线、热切支线与 finally 结算三处等待都有上限，且超时只降级、不改写加固结果。
   */
  it('收尾看门狗：清场永不返回 → 等满 300s 后按收尾异常定型 done，加固结果与本地移除不受影响', async () => {
    const harness = createHarness({ inBrowser: { kind: 'deleted' }, finalize: { hang: true } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-hang-cleanup')
    const run = await waitForTerminal(harness.service, 20_000)
    expect(run.phase).toBe('done')
    expect(run.message).toContain('浏览器会话内秒级执行')
    expect(run.message).toContain('收尾异常（不影响加固结果）：浏览器清场未完成：超过 300s 未返回（后台继续）')
    expect(harness.accounts[0]?.removed).toBe(true)
    // 只兜「不返回」：确实等满了 300s（加两段 7s 倒计时）才放行，没有提前截掉正常的慢。
    expect(run.finishedAt! - run.startedAt).toBeGreaterThanOrEqual(314_000)
  })

  it('收尾看门狗：热切回执永不到达 → 清场收完后如实显示在等换号，120s 后定型 done 并指向接手状态', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      inBrowser: { kind: 'deleted' },
      liveSwitch: () => new Promise(() => {})
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-hang-switch')
    const run = await waitForTerminal(harness.service, 20_000)
    expect(run.phase).toBe('done')
    expect(run.message).toBe(
      '自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、浏览器环境已清场；无感换号 120s 内未回执，以接手状态为准（可在账号列表手动切换）'
    )
    // 清场收完后不再挂着「正在清理」，而是说明在等换号；具体在等什么由 handover 子状态呈现。
    expect(harness.runMessages).toContain('账号已加固、浏览器环境已清场，等待无感换号完成…')
    // 接手子状态保持真实（仍在等 Cursor 确认），主链超时不替它定型。
    expect(run.handover?.status).toBe('switching')
    expect(harness.finalizeCalls).toHaveLength(1)
  })

  it('收尾看门狗：删除失败后 finally 结算热切同样有上限——放行后 running 复位、通道清理执行、下一轮可以启动', async () => {
    const harness = createHarness({
      accounts: [
        { id: 'acc-1', label: 'A', active: true, token: 'old-token' },
        { id: 'acc-2', label: 'B', active: false, token: 'next-token' }
      ],
      nextAccountId: 'acc-2',
      inBrowser: { kind: 'retry_legacy' },
      liveSwitch: () => new Promise(() => {}),
      deleteResult: { ok: false, message: 'delete failed' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service, 20_000)
    expect(run.phase).toBe('failed')
    for (let i = 0; i < 20_000 && harness.disposeCalls.length === 0; i += 1) await Promise.resolve()
    expect(harness.disposeCalls).toHaveLength(1)
    expect(harness.service.getRun().message).toContain('无感换号 120s 内未回执，以接手状态为准')
    // running 已复位：新一轮触发不再被静默拒绝。
    harness.service.onAllSessionsTriggered('plan-2')
    expect(harness.service.getRun()).toMatchObject({ phase: 'countdown', planId: 'plan-2' })
  })

  it('设置持久化：指纹浏览器窗口 id（非空字符串保留、空串/非法值剔除）', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({ enabled: true, delaySec: 5, bitProfileId: 'win-1' }).bitProfileId).toBe('win-1')
    expect(harness.store.load().bitProfileId).toBe('win-1')
    expect(harness.store.save({ enabled: true, delaySec: 5, bitProfileId: '  ' }).bitProfileId).toBeUndefined()
    expect(harness.store.save({ enabled: true, delaySec: 5, bitProfileId: 123 }).bitProfileId).toBeUndefined()
    // 切换窗口：覆盖旧值（用户按当次网络换「代理/直连」窗口）
    expect(harness.store.save({ enabled: true, delaySec: 5, bitProfileId: 'win-2' }).bitProfileId).toBe('win-2')
  })

  it('设置持久化：模型政策自动确认默认开启，可明确关闭并回读', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({ enabled: false, delaySec: 5 }).autoAcknowledgeModelDataPolicies).toBe(true)
    harness.store.save({ enabled: false, delaySec: 5, autoAcknowledgeModelDataPolicies: false })
    expect(harness.store.load().autoAcknowledgeModelDataPolicies).toBe(false)
  })

  it('设置持久化：接手账号保留有效 ID，空值回到自动选择', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({
      enabled: true,
      delaySec: 5,
      seamlessHandoverAccountId: '  acc-2  '
    }).seamlessHandoverAccountId).toBe('acc-2')
    expect(harness.store.save({
      enabled: true,
      delaySec: 5,
      seamlessHandoverAccountId: ' '
    }).seamlessHandoverAccountId).toBeUndefined()
  })

  it('设置持久化：指纹浏览器提供方字段已废弃（统一 Roxy，读取即丢弃）', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    // 旧设置文件里的 fingerprintProvider 残值不再被保留（提供方恒 Roxy，不落设置）
    const saved = harness.store.save({ enabled: true, delaySec: 5, fingerprintProvider: 'roxybrowser' } as Parameters<typeof harness.store.save>[0])
    expect(saved).not.toHaveProperty('fingerprintProvider')
    expect(harness.store.load()).not.toHaveProperty('fingerprintProvider')
  })

  it('设置持久化：浏览器宿主（external/fingerprint 白名单，缺省回落 fingerprint）', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    expect(harness.store.save({ enabled: true, delaySec: 5, browserHost: 'external' }).browserHost).toBe('external')
    expect(harness.store.load().browserHost).toBe('external')
    // 缺省与非法值回落 'fingerprint'——旧设置（已配指纹窗口）无需迁移
    expect(harness.store.save({ enabled: true, delaySec: 5 }).browserHost).toBe('fingerprint')
    expect(harness.store.save({ enabled: true, delaySec: 5, browserHost: 'whatever' as unknown as 'external' }).browserHost).toBe('fingerprint')
    // 切回指纹：覆盖旧值
    expect(harness.store.save({ enabled: true, delaySec: 5, browserHost: 'fingerprint' }).browserHost).toBe('fingerprint')
  })

  it('官网限流 → 指数退避重试直至成功，honor Retry-After，重试状态对用户可见', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, message: '官网删除账号失败：HTTP 429（Retry-After 20s）：Try again later', status: 429, retryAfterSec: 20, rateLimited: true },
        { ok: false, message: '官网删除账号失败：HTTP 429：Try again later', status: 429, rateLimited: true },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    // 同一 token 原地重试（限流时会话仍有效，不轮换）
    expect(harness.deleteCalls).toEqual(['old-token', 'old-token', 'old-token'])
    expect(harness.refreshCalls).toHaveLength(0)
    // 处理前倒计时 7s + 加固前倒计时 7s（缺省沿用 delaySec）后首次删除；第一次等
    // Retry-After 20s；此后每次限流退避翻倍（5s→10s），即第二次等 10s
    //（hint 只覆盖当次等待，不退化客户端退避进度）
    expect(harness.deleteCallClocks).toEqual([14_000, 34_000, 44_000])
    expect(harness.runMessages).toContain('官网限流，20s 后重试（第 1 次）')
    expect(harness.runMessages).toContain('官网限流，10s 后重试（第 2 次）')
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('持续限流超过 5min 窗口 → 明确失败并保留记录（退避序列 5/10/20/40/80/120s）', async () => {
    const harness = createHarness({
      deleteResult: { ok: false, message: '官网删除账号失败：HTTP 429：Try again later', status: 429, rateLimited: true }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('持续限流')
    // 首次限流在 7s（倒计时后），窗口至 307s；等待 5+10+20+40+80+120=275s 后到 282s，
    // 下一次需再等 120s 将越窗（402s > 307s）→ 识败，共 7 次尝试
    expect(harness.deleteCalls).toHaveLength(7)
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('退团等待与限流退避可叠加：先等退团落地，再扛过限流后删除成功', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team before deleting your account.' },
        { ok: false, message: '官网删除账号失败：HTTP 429：Try again later', status: 429, rateLimited: true },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.deleteCalls).toEqual(['old-token', 'old-token', 'old-token'])
    // 双倒计时各 7s 后首次删除 → 退团等待 2s → 限流退避 5s
    expect(harness.deleteCallClocks).toEqual([14_000, 16_000, 21_000])
    expect(harness.accounts[0]?.removed).toBe(true)
  })
})
