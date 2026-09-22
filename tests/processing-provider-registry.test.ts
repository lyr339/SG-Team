import { describe, expect, it, vi } from 'vitest'
import { ProcessingProviderRegistry } from '../src/application/processing-provider-registry'
import type { CursorProcessingProvider, ProcessingProviderId } from '../src/domain/processing-provider'

function entry(id: ProcessingProviderId, saved = true) {
  let masked = saved ? '••••card' : undefined
  const vault = {
    maskedCode: () => masked,
    save: vi.fn(() => { masked = '••••next'; return masked }),
    clear: vi.fn(() => { masked = undefined })
  }
  const service: CursorProcessingProvider = {
    id, label: id === 'aozai' ? '奥仔' : '痕心', unit: id === 'aozai' ? 'points' : 'uses',
    verifyCredential: vi.fn(async () => ({ unit: id === 'aozai' ? 'points' as const : 'uses' as const, remaining: 5 })),
    warmup: vi.fn(async () => {}), refreshBalance: vi.fn(async () => ({ unit: id === 'aozai' ? 'points' as const : 'uses' as const, remaining: 4 })),
    processToken: vi.fn(async () => ({ providerId: id, ok: true, message: 'ok' })), resetAuthorization: vi.fn()
  }
  return { service, vault: vault as never, rawVault: vault }
}

describe('ProcessingProviderRegistry', () => {
  it('每个服务使用自己的凭据与余额，不交叉清理', async () => {
    const aozai = entry('aozai')
    const henxin = entry('henxin')
    const registry = new ProcessingProviderRegistry([aozai, henxin])
    await expect(registry.status('aozai', true)).resolves.toMatchObject({ providerId: 'aozai', remaining: 4, unit: 'points' })
    await expect(registry.saveCredential('henxin', 'CTI-next')).resolves.toMatchObject({ providerId: 'henxin', maskedCode: '••••next', unit: 'uses' })
    registry.clearCredential('henxin')
    expect(henxin.service.resetAuthorization).toHaveBeenCalledTimes(2)
    expect(henxin.rawVault.clear).toHaveBeenCalledOnce()
    expect(aozai.rawVault.clear).not.toHaveBeenCalled()
    expect(registry.hasCredential('aozai')).toBe(true)
    expect(registry.hasCredential('henxin')).toBe(false)
  })
})
