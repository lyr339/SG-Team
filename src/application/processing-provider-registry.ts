import {
  PROCESSING_PROVIDER_IDS,
  type CursorProcessingProvider,
  type ProcessingCredentialStatus,
  type ProcessingProviderId
} from '../domain/processing-provider'
import type { ProcessingCredentialVault } from './processing-credential-vault'

export interface ProcessingProviderEntry {
  service: CursorProcessingProvider
  vault: ProcessingCredentialVault
}

/** 服务商与各自凭据的一处注册表；自动化、IPC 和设置页共享，不在调用点堆分支。 */
export class ProcessingProviderRegistry {
  private readonly entries: Map<ProcessingProviderId, ProcessingProviderEntry>

  constructor(entries: readonly ProcessingProviderEntry[]) {
    this.entries = new Map(entries.map((entry) => [entry.service.id, entry]))
    for (const id of PROCESSING_PROVIDER_IDS) {
      if (!this.entries.has(id)) throw new Error(`处理服务未装配：${id}`)
    }
  }

  require(id: ProcessingProviderId): ProcessingProviderEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`处理服务未装配：${id}`)
    return entry
  }

  hasCredential(id: ProcessingProviderId): boolean {
    return Boolean(this.require(id).vault.maskedCode())
  }

  async status(id: ProcessingProviderId, refresh = false): Promise<ProcessingCredentialStatus> {
    const { service, vault } = this.require(id)
    const maskedCode = vault.maskedCode()
    if (!maskedCode) return { providerId: id, label: service.label, unit: service.unit, saved: false }
    if (!refresh) return { providerId: id, label: service.label, unit: service.unit, saved: true, maskedCode }
    return { providerId: id, label: service.label, saved: true, maskedCode, ...await service.refreshBalance() }
  }

  statuses(): Promise<ProcessingCredentialStatus[]> {
    return Promise.all(PROCESSING_PROVIDER_IDS.map((id) => this.status(id)))
  }

  async saveCredential(id: ProcessingProviderId, code: string): Promise<ProcessingCredentialStatus> {
    const { service, vault } = this.require(id)
    service.resetAuthorization()
    const balance = await service.verifyCredential(code)
    try {
      return { providerId: id, label: service.label, saved: true, maskedCode: vault.save(code), ...balance }
    } catch (error) {
      service.resetAuthorization()
      throw error
    }
  }

  clearCredential(id: ProcessingProviderId): ProcessingCredentialStatus {
    const { service, vault } = this.require(id)
    service.resetAuthorization()
    vault.clear()
    return { providerId: id, label: service.label, unit: service.unit, saved: false }
  }
}
