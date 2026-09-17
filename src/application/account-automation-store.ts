import {
  DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
  normalizeAccountAutomationSettings,
  type AccountAutomationSettings
} from '../domain/account-automation'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'

interface AccountAutomationFile {
  version: 1
  settings: AccountAutomationSettings
}

/** 账号自动化设置的本地持久化（userData/account-automation.json，原子写）。 */
export class AccountAutomationSettingsStore {
  constructor(readonly path: string) {}

  load(): AccountAutomationSettings {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS }
    const parsed = file.value as Partial<AccountAutomationFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      quarantineStoreFileSync(this.path, '账号自动化设置版本或结构不符')
      return { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS }
    }
    return normalizeAccountAutomationSettings(parsed.settings)
  }

  save(settings: unknown): AccountAutomationSettings {
    const normalized = normalizeAccountAutomationSettings(settings)
    const file: AccountAutomationFile = { version: 1, settings: normalized }
    writeStoreFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    return normalized
  }
}
