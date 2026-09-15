/**
 * 一次性诊断：用通道自身的 connectSocket 注入点包一层日志 socket，
 * 完整打印 startProUpgradeCheckout 过程中每条 CDP 请求/响应（表达式只看标记与返回值截断）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { RoxyBrowserClient } from '../src/infrastructure/cursor/fingerprint/roxybrowser-client'
import {
  defaultSocketFactory,
  type FingerprintCdpSocket
} from '../src/infrastructure/cursor/fingerprint/fingerprint-account-channel'
import { FingerprintAccountChannel } from '../src/infrastructure/cursor/fingerprint/fingerprint-account-channel'
import { DEFAULT_CURSOR_CHECKOUT_PROFILE } from '../src/domain/cursor-checkout-profile'

const USER_DATA = join(homedir(), 'Library', 'Application Support', 'sg-team')

/** 包装真实 socket：打印 method 与 Runtime.evaluate 的标记/返回截断。 */
function loggingSocket(inner: FingerprintCdpSocket): FingerprintCdpSocket {
  return {
    onMessage: (handler) => inner.onMessage((data) => {
      try {
        const message = JSON.parse(data) as {
          id?: number
          result?: { result?: { value?: unknown; type?: string; subtype?: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
          error?: { message?: string }
        }
        if (message.id !== undefined && message.id >= 6) {
          if (message.error) {
            console.log(`    ← #${message.id} CDP错误：${message.error.message ?? ''}`)
          } else if (message.result?.exceptionDetails) {
            const detail = message.result.exceptionDetails
            console.log(`    ← #${message.id} 页内异常：${detail.text ?? ''} ${detail.exception?.description ?? ''}`.slice(0, 320))
          } else {
            const value = message.result?.result
            if (value !== undefined) {
              const text = value.value !== undefined
                ? (typeof value.value === 'string' ? value.value : JSON.stringify(value.value))
                : `${value.type ?? '?'}${value.subtype ? `/${value.subtype}` : ''} ${String(value.description ?? '').slice(0, 160)}`
              console.log(`    ← #${message.id} ${text.slice(0, 260)}`)
            }
          }
        }
      } catch { /* 脏数据忽略 */ }
      handler(data)
    }),
    onError: (handler) => inner.onError(handler),
    onClose: (handler) => inner.onClose(handler),
    close: () => inner.close(),
    send: (data) => {
      const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
      if (message.method === 'Runtime.evaluate') {
        const expression = String(message.params?.expression ?? '')
        const marker = expression.match(/\/\* (__sg[A-Za-z]+) \*\//)?.[1]
          ?? (expression.includes('location.hostname') ? 'READINESS' : expression.slice(0, 60))
        console.log(`  → #${message.id} evaluate ${marker}`)
      } else {
        console.log(`  → #${message.id} ${message.method}${message.method === 'Page.navigate' ? ` ${String(message.params?.url ?? '').slice(0, 90)}` : ''}`)
      }
      inner.send(data)
    }
  }
}

async function main(): Promise<void> {
  const apiKey = readFileSync(join(USER_DATA, 'roxy-api-key.txt'), 'utf8').trim()
  const client = new RoxyBrowserClient({ apiKey })
  const target = (await client.listWindows()).find((win) => win.name.toLowerCase().includes('chatgpt'))
  if (!target) throw new Error('未找到 chatgpt 窗口')
  console.log('窗口：', target.name, target.id)

  const channel = new FingerprintAccountChannel({
    resolveClient: () => client,
    resolveProfileId: () => target.id,
    connectSocket: (wsUrl) => loggingSocket(defaultSocketFactory(wsUrl)),
    shouldAcknowledgeModelDataPolicies: () => false
  })

  const token = await channel.readToken(target.id)
  const owner = token.split('::', 1)[0]?.trim()
  if (!owner) throw new Error('无法从 Token 解析账号归属（user_xxx 前缀缺失）')
  console.log('登录态归属：', owner)

  const result = await channel.startProUpgradeCheckout(
    { expectedAccountId: owner, profile: DEFAULT_CURSOR_CHECKOUT_PROFILE, allowSubmit: false },
    target.id
  )
  console.log('结果：', result.outcome, '—', result.detail)
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('\n失败：', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
