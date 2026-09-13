/**
 * 晴天补丁真摘（一次性维护脚本）。
 *
 *   npx tsx scripts/unpatch-cursor.ts --dry-run   # 只读：报告将摘除的段与校验结论
 *   npx tsx scripts/unpatch-cursor.ts             # 落盘：备份 → 摘除 → 校验和 → 重签
 *
 * 摘除只改磁盘；运行中的 Cursor 在重启前仍跑内存里的旧 bundle。
 * 回滚：cp workbench.desktop.main.js.sg-unpatch-backup workbench.desktop.main.js
 * （之后同样需要同步 product.json 校验和；备份由本脚本首次写盘时留档。）
 */
import { readFileSync } from 'node:fs'
import {
  CursorLegacyPatchRemover,
  analyzeLegacyPatch,
  removeLegacyPatchFromSource
} from '../src/infrastructure/cursor/cursor-legacy-patch-remover'
import { locateCursorWorkbenchBundle } from '../src/infrastructure/cursor/cursor-install-paths'

const dryRun = process.argv.includes('--dry-run')

const bundlePath = locateCursorWorkbenchBundle()
if (!bundlePath) {
  console.error('未找到 Cursor workbench bundle')
  process.exit(1)
}
console.log(`bundle: ${bundlePath}`)

const source = readFileSync(bundlePath, 'utf8')
const before = analyzeLegacyPatch(source)
console.log(`晴天标记总数: ${before.qtMarkerCount}`)
console.log(`内联段: constructor=${before.spans.constructor} createFallback=${before.spans.createFallback} notificationSilencer=${before.spans.notificationSilencer} tail=${before.spans.tail}`)
console.log(`拾光标记: ${JSON.stringify(before.sgMarkers)}`)

if (dryRun) {
  const preview = removeLegacyPatchFromSource(source)
  console.log(`\n[dry-run] ok=${preview.ok} changed=${preview.changed}`)
  console.log(`[dry-run] ${preview.message}`)
  for (const span of preview.removed) console.log(`  - ${span.name}: ${span.length} 字符`)
  if (preview.changed) {
    console.log(`[dry-run] 摘除后长度 ${preview.source.length}（现 ${source.length}）`)
    const after = analyzeLegacyPatch(preview.source)
    console.log(`[dry-run] 摘除后晴天标记=${after.qtMarkerCount} 拾光标记=${JSON.stringify(after.sgMarkers)}`)
  }
  process.exit(preview.ok ? 0 : 1)
}

const remover = new CursorLegacyPatchRemover({ bundlePath })
const outcome = await remover.remove()
console.log(`\nok=${outcome.ok} changed=${outcome.changed}`)
console.log(outcome.message)
for (const span of outcome.removed ?? []) console.log(`  - ${span.name}: ${span.length} 字符`)
if (outcome.warning) console.warn(`警告: ${outcome.warning}`)
process.exit(outcome.ok ? 0 : 1)
