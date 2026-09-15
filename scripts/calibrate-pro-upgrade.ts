/**
 * 升级 Pro 结账链实机校准脚本（安全闸门：恒 allowSubmit=false，绝不提交、绝不生成付款二维码）。
 *
 * 用途：在真实指纹浏览器窗口里跑通「登录态门 → 直达 Stripe 月付结账 → USD → 中国 →
 * 支付宝 → 填写账单资料 → 提交前复核」全链，停在提交按钮之前。用于校准选择器与验证
 * 真实页面结构；校准通过后，应用内「升级 Pro」按钮（生产语义，会提交）才可信赖。
 *
 * 用法：
 *   npx tsx scripts/calibrate-pro-upgrade.ts [窗口名关键词]     # 默认 chatgpt
 *
 * 数据来源：Roxy API Key 与默认窗口读取应用 userData 配置（与应用同路径），不写入任何配置。
 * 运行后结账标签页保留在窗口内供人工核对（可手动关闭该标签页）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RoxyBrowserClient } from '../src/infrastructure/cursor/fingerprint/roxybrowser-client'
import { FingerprintAccountChannel } from '../src/infrastructure/cursor/fingerprint/fingerprint-account-channel'
import { DEFAULT_CURSOR_CHECKOUT_PROFILE } from '../src/domain/cursor-checkout-profile'

const USER_DATA = join(homedir(), 'Library', 'Application Support', 'sg-team')
const keyword = (process.argv[2] ?? 'chatgpt').toLowerCase()

const log = (step: string, detail = ''): void => {
  process.stdout.write(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${step}${detail ? `：${detail}` : ''}\n`)
}

async function main(): Promise<void> {
  log('读取 Roxy API Key', USER_DATA)
  const apiKey = readFileSync(join(USER_DATA, 'roxy-api-key.txt'), 'utf8').trim()
  const client = new RoxyBrowserClient({ apiKey })

  log('健康检查 + 拉取窗口列表')
  await client.health()
  const windows = await client.listWindows()
  log('窗口列表', windows.map((win) => `${win.name}(${win.id})`).join('、') || '（空）')
  const target = windows.find((win) => win.name.toLowerCase().includes(keyword))
  if (!target) throw new Error(`未找到名称含「${keyword}」的窗口`)
  log('目标窗口', `${target.name} (${target.id})`)

  const channel = new FingerprintAccountChannel({
    resolveClient: () => client,
    resolveProfileId: () => target.id,
    // 校准只读登录态，不触碰政策确认链
    shouldAcknowledgeModelDataPolicies: () => false
  })

  log('① 读取登录态（cookie 级，不导航）')
  const token = await channel.readToken(target.id)
  const owner = token.split('::', 1)[0]?.trim()
  if (!owner) throw new Error('窗口内未登录 cursor.com（未读到 WorkosCursorSessionToken）')
  log('登录态归属', owner)

  log('②~⑧ 直达结账并填单复核（安全闸门 allowSubmit=false：绝不提交、不生成二维码）')
  const result = await channel.startProUpgradeCheckout(
    { expectedAccountId: owner, profile: DEFAULT_CURSOR_CHECKOUT_PROFILE, allowSubmit: false },
    target.id
  )
  log('结果', `${result.outcome} — ${result.detail}`)
  if (result.outcome !== 'verified') {
    throw new Error(`校准闸门被穿透：预期 verified，实际 ${result.outcome}`)
  }
  log('校准通过：选择器与复核链路与真实页面一致；结账标签页已保留在窗口内供人工核对')
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`\n校准失败：${detail}\n`)
  process.exitCode = 1
})
