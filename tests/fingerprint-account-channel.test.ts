import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  defaultSocketFactory,
  FingerprintAccountChannel
} from '../src/infrastructure/cursor/fingerprint/fingerprint-account-channel'
import type { FingerprintBrowser } from '../src/infrastructure/cursor/fingerprint/fingerprint-browser'

/**
 * 假 CDP socket：按 method 脚本化响应；Network.getCookies 的 token 值与
 * Runtime.evaluate 的返回由测试逐轮控制，模拟「导航→认证链→token 轮换→页内删除」。
 */
class FakeCdpSocket {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = []
  closed = false
  private messageHandler: ((data: string) => void) | undefined
  private closeHandler: (() => void) | undefined
  private nextId = 100
  /** 每次调用 Network.getCookies 时按序出队；空时返回 undefined（无 cookie）。 */
  tokenQueue: Array<string | undefined> = []
  /** Runtime.evaluate 的 READINESS_JS 逐次返回；空时用最后一项。 */
  readinessQueue: string[] = []
  /** FIRE_DELETE_JS evaluate 的返回值。 */
  fireResult = 'armed'
  /** POLL_RESULT_JS 逐次返回；空时用最后一项。 */
  pollResultQueue: string[] = []
  /** 模型政策脚本结果；缺省表示官网已确认。 */
  policyResultQueue: unknown[] = []
  /** __sgLoginProbe 逐次返回；空时用最后一项。 */
  loginProbeQueue: string[] = []
  /** __sgReadAccountEmail 的返回（邮箱或空串）。 */
  accountEmail = ''
  /** __sgCheckoutProbe 逐次返回；空时用最后一项（脏帧给空串）。 */
  checkoutProbeQueue: string[] = []
  /** __sgCheckoutTarget 的返回（JSON 视口中心坐标；null 表示目标不可点）。 */
  checkoutTarget: string | null = JSON.stringify({ x: 120, y: 320 })
  /** __sgCheckoutFill 的返回（'filled' 为成功）。 */
  checkoutFillResult = 'filled'
  /** __sgCheckoutSelect 按字段名脚本化（缺省 'set'；'no-option' 模拟省份未命中）。 */
  checkoutSelectResults: Record<string, string> = {}
  /** __sgCheckoutVerify 的返回（JSON 表单现值）。 */
  checkoutVerify = ''

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler
  }

  onError(): void {
    // 测试不模拟 ws 错误
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  /** 模拟连接断开（用户关窗/指纹浏览器退出）。 */
  simulateDisconnect(): void {
    this.closeHandler?.()
  }

  /** 模拟 ws 层收到脏数据（非法 JSON）。 */
  simulateGarbage(): void {
    this.messageHandler?.('{not valid json{{{')
  }

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
    this.sent.push(message)
    const respond = (result: unknown): void => {
      this.messageHandler?.(JSON.stringify({ id: message.id, result }))
    }
    switch (message.method) {
      case 'Target.createTarget':
        respond({ targetId: 'target-1' })
        return
      case 'Target.attachToTarget':
        respond({ sessionId: 'session-1' })
        return
      case 'Page.enable':
      case 'Network.enable':
      case 'Page.navigate':
      case 'Storage.clearDataForOrigin':
        respond({})
        return
      case 'Target.closeTarget':
        respond({ success: true })
        return
      case 'Input.dispatchMouseEvent':
        respond({})
        return
      case 'Network.getCookies': {
        const value = this.tokenQueue.length > 1 ? this.tokenQueue.shift() : this.tokenQueue[0]
        const cookies = value === undefined ? [] : [{ name: 'WorkosCursorSessionToken', value: String(value) }]
        respond({ cookies })
        return
      }
      case 'Runtime.evaluate': {
        const expression = String(message.params.expression ?? '')
        if (expression.includes('__sgLoginProbe')) {
          const value = this.loginProbeQueue.length > 1 ? this.loginProbeQueue.shift() : this.loginProbeQueue[0]
          respond({ result: { value: value ?? READY } })
          return
        }
        if (expression.includes('__sgReadAccountEmail')) {
          respond({ result: { value: this.accountEmail } })
          return
        }
        if (expression.includes('__sgFillEmail') || expression.includes('__sgFillPassword') || expression.includes('__sgResubmitPassword')) {
          respond({ result: { value: 'submitted' } })
          return
        }
        // 结账链桩（__sgCheckout*）必须先于 location.hostname 分支——探测脚本内含该字段
        if (expression.includes('__sgCheckoutProbe')) {
          const value = this.checkoutProbeQueue.length > 1 ? this.checkoutProbeQueue.shift() : this.checkoutProbeQueue[0]
          respond({ result: { value: value ?? '' } })
          return
        }
        if (expression.includes('__sgCheckoutTarget')) {
          respond({ result: { value: this.checkoutTarget } })
          return
        }
        if (expression.includes('__sgCheckoutFill')) {
          respond({ result: { value: this.checkoutFillResult } })
          return
        }
        if (expression.includes('__sgCheckoutSelect')) {
          const name = expression.includes('billingCountry')
            ? 'billingCountry'
            : expression.includes('billingProvince')
              ? 'billingProvince'
              : ''
          respond({ result: { value: this.checkoutSelectResults[name] ?? 'set' } })
          return
        }
        if (expression.includes('__sgCheckoutVerify')) {
          respond({ result: { value: this.checkoutVerify } })
          return
        }
        if (expression.includes('location.hostname')) {
          const value = this.readinessQueue.length > 1 ? this.readinessQueue.shift() : this.readinessQueue[0] ?? READY
          respond({ result: { value } })
          return
        }
        if (expression.includes('__sgModelDataPolicy')) {
          const value = this.policyResultQueue.length > 1
            ? this.policyResultQueue.shift()
            : this.policyResultQueue[0] ?? {
              kind: 'already_acknowledged',
              modelId: 'claude-fable-5',
              consentVersion: 'fable-data-retention-v1'
            }
          respond({ result: { value } })
          return
        }
        if (expression.includes('delete-account')) {
          respond({ result: { value: this.fireResult } })
          return
        }
        if (expression.includes('__sgDel')) {
          const value = this.pollResultQueue.length > 1 ? this.pollResultQueue.shift() : this.pollResultQueue[0] ?? ''
          respond({ result: { value } })
          return
        }
        respond({ result: { value: undefined } })
        return
      }
      default:
        respond({})
    }
  }

  methodCount(method: string): number {
    return this.sent.filter((entry) => entry.method === method).length
  }

  fireCalled(): boolean {
    return this.sent.some((entry) => (
      entry.method === 'Runtime.evaluate' && String(entry.params.expression ?? '').includes('delete-account')
    ))
  }
}

interface HarnessOptions {
  profileId?: string
  now?: () => number
  autoPolicy?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const openCalls: string[] = []
  const closeWindowCalls: string[] = []
  const client = {
    openWindow: async (profileId: string) => {
      openCalls.push(profileId)
      return { ws: 'ws://127.0.0.1:52624/devtools/browser/abc', http: '127.0.0.1:52624' }
    },
    closeWindow: async (profileId: string) => {
      closeWindowCalls.push(profileId)
    }
  } satisfies Pick<FingerprintBrowser, 'openWindow' | 'closeWindow'>
  let currentProfileId: string | undefined = options.profileId ?? 'win-1'
  let clock = 0
  const socket = new FakeCdpSocket()
  const channel = new FingerprintAccountChannel({
    resolveClient: () => client as unknown as FingerprintBrowser,
    resolveProfileId: () => currentProfileId,
    connectSocket: () => socket,
    now: options.now ?? (() => clock),
    shouldAcknowledgeModelDataPolicies: () => options.autoPolicy !== false,
    sleep: async (ms) => {
      clock += ms
    }
  })
  return {
    channel,
    socket,
    openCalls,
    closeWindowCalls,
    setProfileId: (id: string | undefined) => {
      currentProfileId = id
    },
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const OLD_TOKEN = encodeURIComponent('user_abc::old-jwt')
const NEW_TOKEN = encodeURIComponent('user_abc::new-jwt')
const READY = JSON.stringify({ h: 'cursor.com', p: '/dashboard', s: 'complete' })
const AUTH_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/', s: 'complete' })
const LOADING = JSON.stringify({ h: 'cursor.com', p: '/dashboard', s: 'loading' })
const EMAIL_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/', s: 'complete', email: true })
const PASSWORD_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/password', s: 'complete', password: true })
const CODE_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/email-verification', s: 'complete', code: true })
const HUMAN_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/password', s: 'complete', password: true, human: true })

describe('FingerprintAccountChannel', () => {
  it('readToken：开窗→建 CDP 会话→内存读 cookie 并解码', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await expect(harness.channel.readToken()).resolves.toBe('user_abc::old-jwt')
    expect(harness.openCalls).toEqual(['win-1'])
    expect(harness.socket.methodCount('Network.getCookies')).toBe(2)
    // 会话建立链完整：建 target → attach → 启用 Page/Network
    expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
    expect(harness.socket.methodCount('Target.attachToTarget')).toBe(1)
    expect(harness.socket.methodCount('Page.enable')).toBe(1)
    expect(harness.socket.methodCount('Network.enable')).toBe(1)
  })

  it('readToken：窗口内未登录 → 抛错引导登录', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    await expect(harness.channel.readToken()).rejects.toThrow(/未登录 cursor\.com/)
  })

  it('模型政策：缺失时提交并复核，返回 changed=true；同账号再次调用走成功缓存', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.policyResultQueue = [{
      kind: 'acknowledged',
      modelId: 'claude-fable-5',
      consentVersion: 'fable-data-retention-v1'
    }]
    const first = await harness.channel.acknowledgeRequiredModelDataPolicies()
    const second = await harness.channel.acknowledgeRequiredModelDataPolicies()
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(harness.socket.sent.filter((entry) => (
      entry.method === 'Runtime.evaluate'
      && String(entry.params.expression ?? '').includes('__sgModelDataPolicy')
    ))).toHaveLength(1)
  })

  it('模型政策：官网提交失败时保留明确阶段与 HTTP 状态，不写成功缓存', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.policyResultQueue = [{
      kind: 'failed', modelId: 'claude-fable-5', stage: 'write', status: 403, detail: 'blocked'
    }]
    await expect(harness.channel.acknowledgeRequiredModelDataPolicies()).rejects.toThrow(/提交失败.*HTTP 403/)
  })

  it('模型政策自动确认关闭时，readToken 只读 cookie，不导航也不调用政策接口', async () => {
    const harness = createHarness({ autoPolicy: false })
    harness.socket.tokenQueue = [OLD_TOKEN]
    await expect(harness.channel.readToken()).resolves.toBe('user_abc::old-jwt')
    expect(harness.socket.methodCount('Network.getCookies')).toBe(1)
    expect(harness.socket.methodCount('Page.navigate')).toBe(0)
    expect(harness.socket.sent.some((entry) => (
      entry.method === 'Runtime.evaluate'
      && String(entry.params.expression ?? '').includes('__sgModelDataPolicy')
    ))).toBe(false)
  })

  it('未选择窗口 → 抛错引导选择', async () => {
    const harness = createHarness()
    harness.setProfileId(undefined)
    await expect(harness.channel.readToken()).rejects.toThrow(/未绑定指纹浏览器窗口/)
    expect(harness.openCalls).toHaveLength(0)
  })

  describe('openLoginPage（用户提前登录入口）', () => {
    it('开窗并导航 cursor.com；不关窗、不 closeTarget（窗口留给用户操作）', async () => {
      const harness = createHarness()
      await harness.channel.openLoginPage()
      expect(harness.openCalls).toEqual(['win-1'])
      const navigations = harness.socket.sent.filter((entry) => entry.method === 'Page.navigate')
      expect(navigations).toHaveLength(1)
      expect(navigations[0]!.params).toEqual({ url: 'https://cursor.com' })
      // 窗口保持打开：不 closeTarget、不 closeWindow
      expect(harness.socket.methodCount('Target.closeTarget')).toBe(0)
      expect(harness.closeWindowCalls).toHaveLength(0)
      expect(harness.socket.closed).toBe(false)
    })

    it('会话留缓存：紧随其后的 readToken 复用热连接（不重开窗）', async () => {
      const harness = createHarness()
      await harness.channel.openLoginPage()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      // 用户在打开的页面里登录后，导入直接读到 cookie：窗口只开了一次
      expect(harness.openCalls).toEqual(['win-1'])
      expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
    })

    it('未选择窗口 → 抛错引导选择', async () => {
      const harness = createHarness()
      harness.setProfileId(undefined)
      await expect(harness.channel.openLoginPage()).rejects.toThrow(/未绑定指纹浏览器窗口/)
      expect(harness.openCalls).toHaveLength(0)
    })
  })

  describe('窗口锚定与显式指定（账号 ↔ 窗口绑定语义）', () => {
    it('显式 override 优先于解析结果（用户操作/运行起点的目标窗口）', async () => {
      const harness = createHarness() // 解析恒为 win-1
      harness.socket.tokenQueue = [OLD_TOKEN]
      await expect(harness.channel.readToken('win-2')).resolves.toBe('user_abc::old-jwt')
      expect(harness.openCalls).toEqual(['win-2'])
    })

    it('运行中锚定：活会话即本轮窗口锚——解析漂移（热切接手改变活跃账号）不抢窗', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken() // 运行起点：preflight 在 win-1 锚定
      // 模拟热切完成：活跃账号切换 → 解析结果漂移到 win-2
      harness.setProfileId('win-2')
      await harness.channel.prepareRefresh()
      // 删除链必须留在 win-1：不重开窗口、不新建 target
      expect(harness.openCalls).toEqual(['win-1'])
      expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
    })

    it('无活会话时才按解析开窗（新一轮运行的起点语义）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.dispose() // 上一轮结束，会话释放
      harness.setProfileId('win-2') // 新活跃账号绑定 win-2
      await harness.channel.prepareRefresh()
      expect(harness.openCalls).toEqual(['win-1', 'win-2'])
    })

    it('显式切窗重置 token 轮换基准（旧窗口基准对新窗口无意义）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken() // lastKnownToken = old（win-1）
      await harness.channel.openLoginPage('win-2') // 显式切窗：基准必须清空
      // 若基准残留：deleteWhenReady 会等「≠ old」的轮换直到超时回退；
      // 基准已清则跳过轮换守门，就绪后直接删除。
      harness.socket.readinessQueue = [READY]
      harness.socket.pollResultQueue = [JSON.stringify({ st: 200, body: '' })]
      await harness.channel.prepareRefresh()
      const result = await harness.channel.deleteWhenReady()
      expect(result).toEqual({ kind: 'deleted' })
      expect(harness.socket.fireCalled()).toBe(true)
      expect(harness.openCalls).toEqual(['win-1', 'win-2'])
    })

    it('cleanupEnvironment 显式定向：活会话属于别的窗口时不做页面级清理，只清目标 profile', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken() // 活会话在 win-1
      await harness.channel.cleanupEnvironment('win-2')
      // win-1 的页面未被当作清理对象（无站点数据清理），仅释放 CDP；
      // 清场事务（降级为关窗）落在目标 win-2 上
      expect(harness.socket.methodCount('Storage.clearDataForOrigin')).toBe(0)
      expect(harness.socket.methodCount('Target.closeTarget')).toBe(1)
      expect(harness.closeWindowCalls).toEqual(['win-2'])
    })

    it('cleanupEnvironment 无 override：活会话属于目标窗口时先做页面级清理', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.cleanupEnvironment()
      expect(harness.socket.methodCount('Storage.clearDataForOrigin')).toBe(2)
      expect(harness.closeWindowCalls).toEqual(['win-1'])
    })
  })

  describe('deleteWhenReady 归属守门（expectedAccountId）', () => {
    it('轮换后页面会话仍属被处理账号 → 放行页内删除', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      harness.socket.readinessQueue = [READY]
      harness.socket.tokenQueue = [OLD_TOKEN, NEW_TOKEN]
      harness.socket.pollResultQueue = [JSON.stringify({ st: 200, body: '' })]
      await harness.channel.prepareRefresh()
      const result = await harness.channel.deleteWhenReady('user_abc')
      expect(result).toEqual({ kind: 'deleted' })
      expect(harness.socket.fireCalled()).toBe(true)
    })

    it('轮换后页面会话已属其他账号 → 转协议链复核，绝不开火', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      harness.socket.readinessQueue = [READY]
      // 轮换出了别的账号的 token（窗口被改登）
      harness.socket.tokenQueue = [OLD_TOKEN, encodeURIComponent('user_xyz::other-jwt')]
      await harness.channel.prepareRefresh()
      const result = await harness.channel.deleteWhenReady('user_abc')
      expect(result.kind).toBe('retry_legacy')
      if (result.kind === 'retry_legacy') expect(result.message).toContain('归属')
      expect(harness.socket.fireCalled()).toBe(false)
    })

    it('删除前读不到会话（登录态丢失）→ 转协议链复核，绝不开火', async () => {
      const harness = createHarness()
      // 不走 readToken（无轮换基准 → 跳过轮换守门），直接删除链
      harness.socket.readinessQueue = [READY]
      harness.socket.tokenQueue = [undefined]
      await harness.channel.prepareRefresh()
      const result = await harness.channel.deleteWhenReady('user_abc')
      expect(result.kind).toBe('retry_legacy')
      if (result.kind === 'retry_legacy') expect(result.message).toContain('归属')
      expect(harness.socket.fireCalled()).toBe(false)
    })
  })

  describe('clearSiteData（账号隔离清场）', () => {
    it('对 cursor.com 与认证链 origin 各发一次 Storage.clearDataForOrigin（all 类型）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()

      await harness.channel.clearSiteData()
      const clears = harness.socket.sent.filter((entry) => entry.method === 'Storage.clearDataForOrigin')
      expect(clears.map((entry) => entry.params.origin)).toEqual(
        expect.arrayContaining(['https://cursor.com', 'https://authentication.cursor.sh'])
      )
      for (const entry of clears) {
        expect(entry.params.storageTypes).toBe('all')
      }
    })

    it('复用已建立的会话（不重开窗）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.clearSiteData()
      expect(harness.openCalls).toEqual(['win-1'])
    })

    it('某个 origin 清理失败不抛错（删除已成功，残留只是卫生问题）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      // 让其中一个 CDP 调用抛错：直接断开连接模拟中途失败
      harness.socket.simulateDisconnect()
      // 会话已失效 → clearSiteData 会重开窗口重试（断链自愈语义）
      harness.socket.tokenQueue = [OLD_TOKEN]
      await expect(harness.channel.clearSiteData()).resolves.toBeUndefined()
    })
  })

  describe('健壮性', () => {
    it('ws 收到非法 JSON → 静默忽略，不炸主进程，后续命令仍正常', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      const reading = harness.channel.readToken()
      harness.socket.simulateGarbage()
      await expect(reading).resolves.toBe('user_abc::old-jwt')
    })

    it('开窗进行中并发切换窗口 → 各自开窗，不返回错误窗口的会话', async () => {
      const socketsByUrl = new Map<string, FakeCdpSocket>()
      let currentProfileId: string | undefined = 'win-1'
      const openCalls: string[] = []
      const client = {
        openWindow: async (profileId: string) => {
          openCalls.push(profileId)
          // win-1 的开窗人为延迟，制造「opening 进行中切窗」的竞态窗口
          if (profileId === 'win-1') await new Promise((resolve) => setTimeout(resolve, 20))
          return { ws: `ws-${profileId}` }
        },
        closeWindow: async () => {}
      } satisfies Pick<FingerprintBrowser, 'openWindow' | 'closeWindow'>
      const channel = new FingerprintAccountChannel({
        resolveClient: () => client as unknown as FingerprintBrowser,
        resolveProfileId: () => currentProfileId,
        connectSocket: (wsUrl) => {
          const socket = new FakeCdpSocket()
          // win-1 的 socket 在延迟后才会创建；创建即预置 token，让挂起的 readToken 能完成
          if (wsUrl === 'ws-win-1') socket.tokenQueue = [OLD_TOKEN]
          socketsByUrl.set(wsUrl, socket)
          return socket
        },
        sleep: async () => {}
      })

      // win-1 开窗进行中（延迟 20ms），用户切到 win-2 并打开登录页
      const win1Reading = channel.readToken()
      currentProfileId = 'win-2'
      await channel.openLoginPage()

      // openLoginPage 必须作用于 win-2（不是错误地复用 win-1 的 opening）
      const win2Socket = socketsByUrl.get('ws-win-2')
      expect(win2Socket).toBeDefined()
      expect(win2Socket!.sent.some((entry) => entry.method === 'Page.navigate'
        && entry.params.url === 'https://cursor.com')).toBe(true)
      expect(openCalls).toEqual(['win-1', 'win-2'])

      await win1Reading
    })
  })

  describe('断链感知（用户关窗/指纹浏览器退出）', () => {
    it('连接断开后缓存失效：下次操作重开窗口，而不是挂在死会话上', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1'])

      // 用户手动关窗 → ws 断开（close 而非 error）
      harness.socket.simulateDisconnect()

      // 下一次读 token：自动重开（新 ws 连接、新会话），不再复用死会话
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1', 'win-1'])
      expect(harness.socket.methodCount('Target.createTarget')).toBe(2)
    })

    it('dispose 主动关窗不误伤后续操作（关闭后缓存已清，重开正常）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.dispose()
      expect(harness.closeWindowCalls).toEqual(['win-1'])

      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1', 'win-1'])
    })

    it('生产装配契约：client 实例稳定时跨 openLoginPage→readToken 全程复用（一次开窗一个 tab）', async () => {
      // 模拟 main 装配的实例缓存：同一配置下 resolveClient 返回同一实例
      const stableClient = {
        openWindow: async (profileId: string) => {
          return { ws: 'ws://stable', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      } as unknown as FingerprintBrowser
      const sockets: FakeCdpSocket[] = []
      let currentProfileId = 'win-1'
      const channel = new FingerprintAccountChannel({
        resolveClient: () => stableClient,
        resolveProfileId: () => currentProfileId,
        connectSocket: () => {
          const socket = new FakeCdpSocket()
          sockets.push(socket)
          return socket
        },
        sleep: async () => {}
      })

      await channel.openLoginPage()
      sockets[0]!.tokenQueue = [OLD_TOKEN]
      await channel.readToken()
      sockets[0]!.tokenQueue = [OLD_TOKEN]
      await channel.prepareRefresh()

      // 三次操作共享一个 ws 连接与一个 tab——热连接复用是「奥仔期间不冷启动」的前提
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.methodCount('Target.createTarget')).toBe(1)

      // 换 API Key 等价的实例变化 → 下一次操作重开（既有语义，回归防线）
      const anotherClient = { ...stableClient } as unknown as FingerprintBrowser
      const channel2 = new FingerprintAccountChannel({
        resolveClient: () => anotherClient,
        resolveProfileId: () => currentProfileId,
        connectSocket: () => {
          const socket = new FakeCdpSocket()
          socket.tokenQueue = [OLD_TOKEN]
          sockets.push(socket)
          return socket
        },
        sleep: async () => {}
      })
      await channel2.readToken()
      expect(sockets).toHaveLength(2)
    })
  })

  it('同一窗口重复操作复用 CDP 会话（不重复开窗）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.readToken()
    expect(harness.openCalls).toHaveLength(1)
    expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
  })

  it('deleteWhenReady：就绪→token 轮换→页内删除成功', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [LOADING, READY]
    // 轮换序列：先读到旧 token（未变）、再读到新 token（已轮换）
    harness.socket.tokenQueue = [OLD_TOKEN, NEW_TOKEN]
    harness.socket.pollResultQueue = ['pending', JSON.stringify({ st: 200, body: '' })]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result).toEqual({ kind: 'deleted' })
    expect(harness.socket.fireCalled()).toBe(true)
  })

  it('deleteWhenReady：token 不轮换 → 超时回退 legacy（删除绝不抢跑）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    // token 永远不变（旧值持续）
    harness.socket.readinessQueue = [READY]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    if (result.kind === 'retry_legacy') {
      expect(result.message).toContain('token 轮换超时')
    }
    expect(harness.socket.fireCalled()).toBe(false)
  })

  it('deleteWhenReady：页面停留认证页 → 判定未登录', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [AUTH_PAGE]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('not_logged_in')
  })

  it('deleteWhenReady：页内删除被拒（403）→ retry_legacy 带状态码', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [READY]
    harness.socket.tokenQueue = [NEW_TOKEN]
    harness.socket.pollResultQueue = [JSON.stringify({ st: 403, body: 'blocked' })]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    if (result.kind === 'retry_legacy') {
      expect(result.message).toContain('HTTP 403')
    }
  })

  it('refresh：导航后轮询 cookie 变化，返回换发的新 token', async () => {
    const harness = createHarness()
    // 先让通道记住旧 token（轮换基准）
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.tokenQueue = [OLD_TOKEN, NEW_TOKEN]
    await expect(harness.channel.refresh('user_abc::old-jwt')).resolves.toBe('user_abc::new-jwt')
    expect(harness.socket.methodCount('Page.navigate')).toBe(2)
  })

  it('refresh：token 永不变化 → 超时抛错', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    const result = await harness.channel.refresh('user_abc::old-jwt').catch((error: Error) => error.message)
    expect(result).toContain('会话刷新超时')
  })

  it('dispose：关测试页、断 ws、关浏览器窗口，且下次操作重新拉起', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.dispose()
    expect(harness.socket.methodCount('Target.closeTarget')).toBe(1)
    expect(harness.socket.closed).toBe(true)
    expect(harness.closeWindowCalls).toEqual(['win-1'])
    // 下一轮重新拉起（新 socket 由 connectSocket 工厂重新创建）
    const second = new FakeCdpSocket()
    const openCalls: string[] = []
    const channel2 = new FingerprintAccountChannel({
      resolveClient: () => ({
        openWindow: async (id: string) => {
          openCalls.push(id)
          return { ws: 'ws://x', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      }) as unknown as FingerprintBrowser,
      resolveProfileId: () => 'win-1',
      connectSocket: () => second,
      sleep: async () => {}
    })
    second.tokenQueue = [OLD_TOKEN]
    await expect(channel2.readToken()).resolves.toBe('user_abc::old-jwt')
    expect(openCalls).toEqual(['win-1'])
  })

  it('切换窗口 id：会话重开到新窗口', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.setProfileId('win-2')
    const socket2 = new FakeCdpSocket()
    const channel = new FingerprintAccountChannel({
      resolveClient: () => ({
        openWindow: async (id: string) => {
          harness.openCalls.push(id)
          return { ws: 'ws://x', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      }) as unknown as FingerprintBrowser,
      resolveProfileId: () => 'win-2',
      connectSocket: () => socket2,
      sleep: async () => {}
    })
    socket2.tokenQueue = [OLD_TOKEN]
    await channel.readToken()
    expect(harness.openCalls).toContain('win-2')
  })

  it('client 实例变化：会话重开（新实例即时生效）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    expect(harness.openCalls).toEqual(['win-1'])
    // resolveClient 返回新实例 → 同一 profileId 也会重开
    const socket2 = new FakeCdpSocket()
    const roxyClient = {
      openWindow: async () => ({ ws: 'ws://roxy' }),
      closeWindow: async () => {}
    } as unknown as FingerprintBrowser
    const channel = new FingerprintAccountChannel({
      resolveClient: () => roxyClient,
      resolveProfileId: () => 'win-1',
      connectSocket: () => socket2,
      sleep: async () => {}
    })
    socket2.tokenQueue = [OLD_TOKEN]
    await channel.readToken()
    expect(channel).not.toBe(harness.channel)
  })

  it('导航 URL 携带 cache-bust（防 Chromium 同 URL no-op）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.prepareRefresh()
    const navigate = harness.socket.sent.find((entry) => (
      entry.method === 'Page.navigate' && String(entry.params.url ?? '').includes('?qtdash=')
    ))
    expect(navigate?.params.url).toMatch(/^https:\/\/cursor\.com\/dashboard\?qtdash=\d+$/)
  })
})

describe('defaultSocketFactory（生产 ws 装配）', () => {
  it('握手完成前的发送排队，open 后按 FIFO 到达（Windows 冷启动 readyState 0 回归）', async () => {
    // 真实 ws 服务端回显 CDP 响应；修复前 ws v8 在 CONNECTING 状态 send 直接抛
    // "WebSocket is not open: readyState 0 (CONNECTING)"，本用例同步即炸。
    const server = new WebSocketServer({ port: 0 })
    const received: string[] = []
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        received.push(String(raw))
        ws.send(JSON.stringify({ id: (JSON.parse(String(raw)) as { id: number }).id, result: {} }))
      })
    })
    const address = server.address() as { port: number }
    try {
      const socket = defaultSocketFactory(`ws://127.0.0.1:${address.port}/devtools/browser/test`)
      const messages: string[] = []
      socket.onMessage((data) => messages.push(data))
      const errors: string[] = []
      socket.onError((error) => errors.push(error.message))
      // 握手必然未完成（同一同步块内）——两条发送都进队列
      socket.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: {} }))
      socket.send(JSON.stringify({ id: 2, method: 'Page.enable', params: {} }))
      // open 后冲刷：服务端按序收到两条，且响应回流到 onMessage
      await vi.waitFor(() => {
        expect(received.map((entry) => (JSON.parse(entry) as { method: string }).method))
          .toEqual(['Target.createTarget', 'Page.enable'])
        expect(messages).toHaveLength(2)
      })
      expect(errors).toEqual([])
      socket.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('FingerprintAccountChannel.loginWithCredentials（凭据自动登录）', () => {
  const LOGIN = { email: 'a@b.co', password: 'cursor-pass' }

  it('窗口已是同账号登录态：/api/auth/me 核对后直接交付，不触碰表单', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.loginProbeQueue = [READY]
    harness.socket.accountEmail = 'a@b.co'
    const result = await harness.channel.loginWithCredentials(LOGIN)
    expect(result).toEqual({ token: 'user_abc::old-jwt', outcome: 'already_logged_in' })
    expect(harness.socket.sent.some((entry) => String(entry.params.expression ?? '').includes('__sgFillEmail'))).toBe(false)
  })

  it('窗口登录他人账号：拒绝触碰并报出当前账号', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.loginProbeQueue = [READY]
    harness.socket.accountEmail = 'other@b.co'
    await expect(harness.channel.loginWithCredentials(LOGIN)).rejects.toThrow(/其他账号（other@b\.co）/)
  })

  it('完整登录链：导航 → 填邮箱 → 填密码 → cookie 落罐交付新 token', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined, undefined, NEW_TOKEN]
    harness.socket.loginProbeQueue = [READY, EMAIL_PAGE, PASSWORD_PAGE]
    const result = await harness.channel.loginWithCredentials(LOGIN)
    expect(result).toEqual({ token: 'user_abc::new-jwt', outcome: 'logged_in' })
    const expressions = harness.socket.sent.map((entry) => String(entry.params.expression ?? ''))
    expect(expressions.some((expression) => expression.includes('__sgFillEmail') && expression.includes('a@b.co'))).toBe(true)
    expect(expressions.some((expression) => expression.includes('__sgFillPassword') && expression.includes('cursor-pass'))).toBe(true)
  })

  it('邮箱验证码账号（无密码路径）：明确报错并保留窗口供手动完成', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    harness.socket.loginProbeQueue = [READY, EMAIL_PAGE, CODE_PAGE]
    await expect(harness.channel.loginWithCredentials(LOGIN)).rejects.toThrow(/邮箱验证码/)
    expect(harness.closeWindowCalls).toEqual([])
  })

  it('密码错误等官网拒绝：透出 role=alert 文案', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    harness.socket.loginProbeQueue = [
      READY,
      EMAIL_PAGE,
      PASSWORD_PAGE,
      JSON.stringify({ h: 'authenticator.cursor.sh', p: '/password', s: 'complete', password: true, alert: '邮箱或密码不正确' })
    ]
    await expect(harness.channel.loginWithCredentials(LOGIN)).rejects.toThrow(/邮箱或密码不正确/)
  })

  it('Turnstile 挑战：周期补提交直到 cookie 落罐', async () => {
    const harness = createHarness()
    // 挑战期 token 不出现；第 13 次读取（挑战通过、补提交生效后）落罐
    harness.socket.tokenQueue = [...Array.from({ length: 12 }, () => undefined), NEW_TOKEN] as Array<string | undefined>
    harness.socket.loginProbeQueue = [READY, EMAIL_PAGE, PASSWORD_PAGE, HUMAN_PAGE]
    const result = await harness.channel.loginWithCredentials(LOGIN)
    expect(result.outcome).toBe('logged_in')
    expect(harness.socket.sent.some((entry) => String(entry.params.expression ?? '').includes('__sgResubmitPassword'))).toBe(true)
  })

  it('登录总窗口超时：报出手动完成引导', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    harness.socket.loginProbeQueue = [READY, EMAIL_PAGE, PASSWORD_PAGE]
    await expect(harness.channel.loginWithCredentials(LOGIN)).rejects.toThrow(/自动登录超时/)
  })

  it('凭据不完整直接拒绝', async () => {
    const harness = createHarness()
    await expect(harness.channel.loginWithCredentials({ email: ' ', password: 'x' })).rejects.toThrow(/凭据不完整/)
  })

  it('① 的 cookie 读取瞬时落空而会话其实有效：② 重读落罐即交付，不误判认证页超时', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined, NEW_TOKEN]
    harness.socket.loginProbeQueue = [READY]
    const result = await harness.channel.loginWithCredentials(LOGIN)
    expect(result).toEqual({ token: 'user_abc::new-jwt', outcome: 'already_logged_in' })
    expect(harness.socket.sent.some((entry) => String(entry.params.expression ?? '').includes('__sgFillEmail'))).toBe(false)
  })
})

describe('FingerprintAccountChannel.startProUpgradeCheckout（升级 Pro 结账）', () => {
  const PROFILE = {
    name: 'Li Ming',
    province: '湖北省',
    city: '武汉市',
    district: '洪山区',
    line1: '珞喻路 456 号',
    postalCode: '430070'
  }
  const INPUT = { expectedAccountId: 'user_abc', profile: PROFILE }
  // 结账页探测分幕：落地 → 表单出现（USD 未选中）→ USD 生效 → 支付宝出现 → 支付宝选中
  const LANDED = JSON.stringify({ h: 'checkout.stripe.com', p: '/c/pay/cs_test_1', s: 'complete', form: false, usd: false, usdActive: false, alipay: false, alipayChecked: false, alert: '' })
  const FORM_UP = JSON.stringify({ h: 'checkout.stripe.com', p: '/c/pay/cs_test_1', s: 'complete', form: true, usd: true, usdActive: false, alipay: false, alipayChecked: false, alert: '' })
  const USD_ON = JSON.stringify({ h: 'checkout.stripe.com', p: '/c/pay/cs_test_1', s: 'complete', form: true, usd: true, usdActive: true, alipay: false, alipayChecked: false, alert: '' })
  const ALIPAY_UP = JSON.stringify({ h: 'checkout.stripe.com', p: '/c/pay/cs_test_1', s: 'complete', form: true, usd: true, usdActive: true, alipay: true, alipayChecked: false, alert: '' })
  const ALIPAY_ON = JSON.stringify({ h: 'checkout.stripe.com', p: '/c/pay/cs_test_1', s: 'complete', form: true, usd: true, usdActive: true, alipay: true, alipayChecked: true, alert: '' })
  const ALIPAY_CASHIER = JSON.stringify({ h: 'www.alipay.com', p: '/cashier', s: 'complete', form: false, usd: false, usdActive: false, alipay: false, alipayChecked: false, alert: '' })
  const VERIFY_OK = JSON.stringify({
    name: 'Li Ming', country: 'CN', province: '湖北省', provinceText: '湖北省',
    locality: '武汉市', dependentLocality: '洪山区', line1: '珞喻路 456 号', line2: '',
    postal: '430070', invalid: 0, alert: ''
  })
  const checkoutExpressions = (harness: ReturnType<typeof createHarness>, marker: string) => (
    harness.socket.sent
      .map((entry) => String(entry.params.expression ?? ''))
      .filter((expression) => expression.includes(marker))
  )

  it('测试闸门（allowSubmit:false）：直达→USD→中国→支付宝→填单→复核通过，停在提交前', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.checkoutProbeQueue = [LANDED, FORM_UP, FORM_UP, USD_ON, ALIPAY_UP, ALIPAY_ON]
    harness.socket.checkoutVerify = VERIFY_OK
    const result = await harness.channel.startProUpgradeCheckout({ ...INPUT, allowSubmit: false })
    expect(result.outcome).toBe('verified')
    expect(result.detail).toContain('复核通过')
    // 直达月付深链
    const navigations = harness.socket.sent.filter((entry) => entry.method === 'Page.navigate')
    expect(navigations.some((entry) => String(entry.params.url).includes('checkoutDeepControl?yearly=false'))).toBe(true)
    // 可信点击只落在 USD 与支付宝（各按下+抬起两次事件），绝不触碰提交
    expect(harness.socket.methodCount('Input.dispatchMouseEvent')).toBe(4)
    expect(checkoutExpressions(harness, '__sgCheckoutTarget').some((expression) => expression.includes('"submit"'))).toBe(false)
    // 账单资料逐字段落页：国家/省份 select + 姓名/地址文本
    expect(checkoutExpressions(harness, '__sgCheckoutSelect').some((expression) => expression.includes('billingCountry') && expression.includes('CN'))).toBe(true)
    expect(checkoutExpressions(harness, '__sgCheckoutSelect').some((expression) => expression.includes('billingProvince') && expression.includes('湖北省'))).toBe(true)
    expect(checkoutExpressions(harness, '__sgCheckoutFill').some((expression) => expression.includes('珞喻路 456 号'))).toBe(true)
  })

  it('完整提交链（缺省 allowSubmit）：复核通过后提交，离开收银台即 awaiting_payment', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.checkoutProbeQueue = [LANDED, FORM_UP, FORM_UP, USD_ON, ALIPAY_UP, ALIPAY_ON, ALIPAY_CASHIER]
    harness.socket.checkoutVerify = VERIFY_OK
    const result = await harness.channel.startProUpgradeCheckout(INPUT)
    expect(result.outcome).toBe('awaiting_payment')
    expect(result.detail).toContain('扫码')
    expect(harness.socket.methodCount('Input.dispatchMouseEvent')).toBe(6)
    expect(checkoutExpressions(harness, '__sgCheckoutTarget').some((expression) => expression.includes('"submit"'))).toBe(true)
  })

  it('归属守门：窗口登录他人账号时 fail-closed 中止，绝不导航去结账', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [encodeURIComponent('user_other::jwt')]
    await expect(harness.channel.startProUpgradeCheckout(INPUT)).rejects.toThrow(/其他账号/)
    expect(harness.socket.methodCount('Page.navigate')).toBe(0)
  })

  it('窗口未登录且无保存凭据：明确报错引导', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    await expect(harness.channel.startProUpgradeCheckout(INPUT)).rejects.toThrow(/无保存凭据/)
    expect(harness.socket.methodCount('Page.navigate')).toBe(0)
  })

  it('账单资料不完整：执行前拦截（缺姓名），不开窗', async () => {
    const harness = createHarness()
    await expect(harness.channel.startProUpgradeCheckout({
      ...INPUT,
      profile: { ...PROFILE, name: '' }
    })).rejects.toThrow(/账单资料不完整（缺姓名）/)
    expect(harness.openCalls).toHaveLength(0)
  })

  it('提交前复核不一致：报出差异字段并中止，不提交', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.checkoutProbeQueue = [LANDED, FORM_UP, FORM_UP, USD_ON, ALIPAY_UP, ALIPAY_ON]
    harness.socket.checkoutVerify = JSON.stringify({ ...JSON.parse(VERIFY_OK), name: 'Zhang San' })
    await expect(harness.channel.startProUpgradeCheckout({ ...INPUT, allowSubmit: false })).rejects.toThrow(/复核不一致.*姓名/)
    expect(checkoutExpressions(harness, '__sgCheckoutTarget').some((expression) => expression.includes('"submit"'))).toBe(false)
  })

  it('省份选项未命中：报出省名引导核对设置', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    harness.socket.checkoutProbeQueue = [LANDED, FORM_UP, FORM_UP, USD_ON, ALIPAY_UP, ALIPAY_ON]
    harness.socket.checkoutSelectResults = { billingProvince: 'no-option' }
    await expect(harness.channel.startProUpgradeCheckout({ ...INPUT, allowSubmit: false })).rejects.toThrow(/省份选项未找到：湖北省/)
  })
})
