import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CursorLegacyPatchRemover,
  QT_SPAN_CONSTRUCTOR,
  QT_SPAN_CREATE_FALLBACK,
  QT_SPAN_NOTIFICATION_SILENCER,
  QT_TAIL_HEAD,
  UNPATCH_BACKUP_SUFFIX,
  analyzeLegacyPatch,
  removeLegacyPatchFromSource
} from '../src/infrastructure/cursor/cursor-legacy-patch-remover'

/** 按 2026-09-12 可行性核对的实测形态搭的迷你 bundle：晴天 4 段 + 拾光 3 处标记。 */
const SG_USAGE = '/* __SG_TEAM_USAGE_PATCH__ */try{const __sg=globalThis.__sgTeamUsage}catch{};'
const SG_PROFILE = '/*SG_PROFILE_REFRESH_V1*/e.displayEmail();'
const SG_PUMP = '/*ZMO_SWITCH_V1_START*/(()=>{})()/*ZMO_SWITCH_V1_END*/;'
const TAIL = `${QT_TAIL_HEAD}/* __QINGTIAN_START_PROMPT_AUTOMATION_V7__ */\n;(function(){var PORT=36530;})();\n`

function patchedBundle(): string {
  return 'var head=1;class Base{};'
    + SG_USAGE
    + `class Composer extends Base{constructor(){super(),${QT_SPAN_CONSTRUCTOR}this.storage=1}`
    + `async createComposer(n){${QT_SPAN_CREATE_FALLBACK}const e=1;return e}`
    + `_showNotification(){${QT_SPAN_NOTIFICATION_SILENCER}const n=this.url}}`
    + SG_PROFILE
    + SG_PUMP
    // 实盘形态：debugId 行自带行尾 \n，尾段另以 "\n/* __QINGTIAN_SEAMLESS__ */\n" 开头
    + '\n//# sourceMappingURL=x.js.map\n\n//# debugId=d345fa05-10ee-5931-8a27-1c7b570e4161\n'
    + TAIL
}

function cleanBundle(): string {
  return 'var head=1;class Base{};'
    + SG_USAGE
    + 'class Composer extends Base{constructor(){super(),this.storage=1}'
    + 'async createComposer(n){const e=1;return e}'
    + '_showNotification(){const n=this.url}}'
    + SG_PROFILE
    + SG_PUMP
    + '\n//# sourceMappingURL=x.js.map\n\n//# debugId=d345fa05-10ee-5931-8a27-1c7b570e4161\n'
}

describe('removeLegacyPatchFromSource（晴天补丁真摘，纯函数）', () => {
  it('removes exactly the four qingtian spans and keeps every sg marker', () => {
    const result = removeLegacyPatchFromSource(patchedBundle())
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.removed.map((span) => span.name)).toEqual([
      'constructor-capture', 'create-composer-fallback', 'notification-silencer', 'tail-runtime'
    ])
    expect(result.source).toBe(cleanBundle())
    const after = analyzeLegacyPatch(result.source)
    expect(after.qtMarkerCount).toBe(0)
    expect(after.sgMarkers['__SG_TEAM_USAGE_PATCH__']).toBe(1)
    expect(after.sgMarkers['SG_PROFILE_REFRESH_V1']).toBe(1)
    expect(after.sgMarkers['ZMO_SWITCH_V1_START']).toBe(1)
  })

  it('is a no-op on an already-clean bundle', () => {
    const result = removeLegacyPatchFromSource(cleanBundle())
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.removed).toHaveLength(0)
  })

  it('removes remaining spans idempotently when some are already gone', () => {
    const partial = patchedBundle().replace(QT_SPAN_CONSTRUCTOR, '')
    const result = removeLegacyPatchFromSource(partial)
    expect(result.ok).toBe(true)
    expect(result.removed.map((span) => span.name)).toEqual([
      'create-composer-fallback', 'notification-silencer', 'tail-runtime'
    ])
    expect(result.source).toBe(cleanBundle())
  })

  it('rejects when an inline anchor is ambiguous (appears twice)', () => {
    const doubled = patchedBundle() + QT_SPAN_NOTIFICATION_SILENCER
    const result = removeLegacyPatchFromSource(doubled)
    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.message).toContain('notification-silencer')
  })

  it('refuses to truncate when content after debugId is not the known qingtian tail', () => {
    const unknownTail = cleanBundle() + '\n/* someone-elses-runtime */\n'
    const result = removeLegacyPatchFromSource(unknownTail)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('debugId')
  })

  it('rejects when unknown qingtian markers would survive the removal', () => {
    const extraMarker = patchedBundle().replace('var head=1;', 'var head=1;/* __QINGTIAN_UNKNOWN_V9__ */')
    const result = removeLegacyPatchFromSource(extraMarker)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('残留')
  })
})

describe('CursorLegacyPatchRemover（落盘器）', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function bundleOnDisk(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'sg-unpatch-'))
    dirs.push(dir)
    const path = join(dir, 'workbench.desktop.main.js')
    writeFileSync(path, content, 'utf8')
    return path
  }

  it('removes spans on disk, keeps a first-write backup and reports removed spans', async () => {
    const path = bundleOnDisk(patchedBundle())
    const remover = new CursorLegacyPatchRemover({ bundlePath: path, execFn: async () => {} })
    const outcome = await remover.remove()
    expect(outcome.ok).toBe(true)
    expect(outcome.changed).toBe(true)
    expect(outcome.removed?.map((span) => span.name)).toContain('tail-runtime')
    expect(readFileSync(path, 'utf8')).toBe(cleanBundle())
    const backup = `${path}${UNPATCH_BACKUP_SUFFIX}`
    expect(existsSync(backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe(patchedBundle())
    // 第二次执行：无段可摘、不再改盘、备份保持第一份
    const again = await remover.remove()
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    expect(readFileSync(backup, 'utf8')).toBe(patchedBundle())
  })

  it('refuses to touch the disk when the source has an ambiguous anchor', async () => {
    const bad = patchedBundle() + QT_SPAN_CREATE_FALLBACK
    const path = bundleOnDisk(bad)
    const remover = new CursorLegacyPatchRemover({ bundlePath: path, execFn: async () => {} })
    const outcome = await remover.remove()
    expect(outcome.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(bad)
    expect(existsSync(`${path}${UNPATCH_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('status() reports span presence read-only', () => {
    const path = bundleOnDisk(patchedBundle())
    const remover = new CursorLegacyPatchRemover({ bundlePath: path })
    const { analysis } = remover.status()
    expect(analysis.spans.constructor).toBe(1)
    expect(analysis.spans.tail).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(patchedBundle())
  })
})
