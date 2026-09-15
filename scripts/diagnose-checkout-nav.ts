/**
 * 一次性诊断：把「chatgpt」窗口的新标签页导航到结账深链，逐 2 秒打印位置/加载态/关键锚点，
 * 看深链实际落到哪里（Stripe 收银台 / 登录链 / 官网其他页 / 错误页）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { RoxyBrowserClient } from '../src/infrastructure/cursor/fingerprint/roxybrowser-client'

const USER_DATA = join(homedir(), 'Library', 'Application Support', 'sg-team')
const DEEP_LINK = 'https://cursor.com/api/auth/checkoutDeepControl?yearly=false'

const PROBE_JS = `JSON.stringify((() => ({
  h: location.hostname,
  p: location.pathname,
  q: location.search.slice(0, 80),
  s: document.readyState,
  t: (document.title || '').slice(0, 60),
  form: !!document.querySelector('select[name=billingCountry]'),
  email: !!document.querySelector('input[name=email]'),
  password: !!document.querySelector('input[name=password]'),
  body: (document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : '')
}))())`

async function main(): Promise<void> {
  const apiKey = readFileSync(join(USER_DATA, 'roxy-api-key.txt'), 'utf8').trim()
  const client = new RoxyBrowserClient({ apiKey })
  const windows = await client.listWindows()
  const target = windows.find((win) => win.name.toLowerCase().includes('chatgpt'))
  if (!target) throw new Error('未找到 chatgpt 窗口')
  console.log('窗口：', target.name, target.id)

  const opened = await client.openWindow(target.id)
  const socket = new WebSocket(opened.ws, { perMessageDeflate: false })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  })
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
    const id = nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      socket.send(JSON.stringify(payload))
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`超时：${method}`)) }, 20_000)
    }) as Promise<Record<string, unknown>>
  }

  const created = await send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true }) as { sessionId: string }
  const sessionId = attached.sessionId
  await send('Page.enable', {}, sessionId)
  console.log('导航深链：', DEEP_LINK)
  await send('Page.navigate', { url: DEEP_LINK }, sessionId)

  const deadline = Date.now() + 90_000
  let last = ''
  while (Date.now() < deadline) {
    const evaluated = await send('Runtime.evaluate', { expression: PROBE_JS, returnByValue: true }, sessionId).catch(() => undefined)
    const value = (evaluated as { result?: { value?: unknown } } | undefined)?.result?.value
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text !== last) {
      last = text
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, text)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  socket.close()
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('诊断失败：', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
