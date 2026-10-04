import type { CursorAccountVault } from './cursor-account-vault'
import type {
  CursorAccountSwitcher,
  CursorAccountSwitchResult
} from '../infrastructure/cursor/cursor-account-switcher'
import { generateCursorMachineIdentity, type CursorMachineIdentity } from '../infrastructure/cursor/cursor-machine-identity'

/** 账号备注常带「（网页登录）」等来源后缀；cachedEmail 只取纯邮箱部分。 */
export function emailFromLabel(label: string | undefined): string | undefined {
  const candidate = label?.replace(/（.*?）\s*$/, '').trim()
  return candidate && /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined
}

export interface CursorAccountSwitchDeps {
  vault: Pick<CursorAccountVault, 'credential' | 'list' | 'machineIdentity' | 'attachMachineIdentity' | 'activateAfterColdSwitch'>
  switcher: Pick<CursorAccountSwitcher, 'switchAccount'>
  /** 机器码生成注入点（测试替身）。 */
  generateIdentity?: () => CursorMachineIdentity
  /** 切换开始前抑制 CDP auto-heal 看门（启动窗口内端口未就绪是预期状态）。 */
  suppressCdpAutoHeal?: () => void
}

/**
 * 一键切换编排（vault 与 switcher 的时序契约）：
 *
 * 1. 取凭据（失败立即抛出，零副作用）；
 * 2. 机器码身份账号绑定（首次生成并持久化；切换失败身份未被应用也无害——
 *    下次尝试回放同一套，语义不变）；
 * 3. 抑制 auto-heal 看门后执行切换（杀 Cursor → 写登录态/机器码 → 带端口拉起）；
 * 4. 原生回执与落库读回确认后，仍在切换器的互斥/恢复窗口内提交活跃账号。
 *    回执失败、凭据变更或金库保存失败均由切换器恢复本轮原状态；不能确认恢复时
 *    明确报错，不用离线写入的目标 Token 冒充运行态成功。
 */
export async function switchCursorAccountWithVault(
  deps: CursorAccountSwitchDeps,
  accountId: string
): Promise<CursorAccountSwitchResult> {
  const { vault, switcher } = deps
  const id = accountId.trim()
  if (!id) throw new Error('Cursor 账号 ID 无效')

  const token = vault.credential(id)
  const account = vault.list().find((item) => item.id === id)
  const identity = vault.machineIdentity(id) ?? (() => {
    const generated = deps.generateIdentity?.() ?? generateCursorMachineIdentity()
    vault.attachMachineIdentity(id, generated)
    return generated
  })()
  deps.suppressCdpAutoHeal?.()

  let committed = false
  const result = await switcher.switchAccount({
    token,
    email: emailFromLabel(account?.label),
    identity
  }, (confirmed) => {
    if (!confirmed.switched || !confirmed.runtimeVerified || confirmed.relaunchMode === 'failed') {
      throw new Error('Cursor 账号切换尚未确认，未更改拾光活跃账号')
    }
    if (vault.credential(id) !== token) throw new Error('目标账号凭据在切换期间已改变，未提交活跃账号')
    // A failed Vault save must still be able to stop Cursor and restore this switch's snapshot.
    vault.activateAfterColdSwitch(id)
    committed = true
  })
  if (!committed) throw new Error('Cursor 切换未提交活跃账号，未报告成功')
  return result
}
