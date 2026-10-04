import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cursorCompatibilityForVersion, type CursorCompatibility } from '../../domain/cursor-compatibility'
import { appRootOfBundle } from './cursor-install-paths'

/** Read metadata beside the exact bundle being patched, not another default Cursor installation. */
export function readCursorCompatibility(bundlePath: string): CursorCompatibility {
  const root = appRootOfBundle(bundlePath)
  try {
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    const compatibility = cursorCompatibilityForVersion(metadata?.version)
    // Cursor writes the release version in both files. Disagreement can mean an update is in progress.
    const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8')) as { version?: unknown }
    if (product?.version !== undefined && product.version !== metadata?.version) {
      return { state: 'unavailable', detail: 'Cursor 安装版本信息不一致；请等更新完成后重新检测' }
    }
    return compatibility
  } catch {
    return { state: 'unavailable', detail: '读不到 Cursor 安装版本；请检查所用安装是否完整' }
  }
}

/** Upgrading Cursor must not reuse an original-bundle backup belonging to the other release. */
export function cursorRuntimeBackupPath(bundlePath: string): string {
  const compatibility = readCursorCompatibility(bundlePath)
  const suffix = compatibility.state === 'supported' ? `-${compatibility.version}` : ''
  return `${bundlePath}.sg-runtime-switch-backup${suffix}`
}
