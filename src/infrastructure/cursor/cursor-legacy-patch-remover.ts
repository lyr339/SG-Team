import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { writeStoreFileSync } from '../fs/store-file'
import {
  appRootOfBundle,
  assertJavaScriptSyntax,
  describeBundleWriteFailure,
  resignMacApp,
  syncProductChecksum
} from './cursor-switch-pump-installer'
import { cursorWorkbenchBundleCandidates, locateCursorWorkbenchBundle } from './cursor-install-paths'

/**
 * 晴天补丁真摘（一次性维护动作）。
 *
 * 摘除对象是 2026-09-12 可行性核对（docs/SELF-GATEWAY-CDP-LOCATOR-RESEARCH.md）
 * 确认的晴天 4 段插入——与 `.qingtian.backup` 原始 bundle 的逐字节重同步差异中
 * 归属晴天的全部内容；拾光自有 4 段（用量钩子 ×2 / profile 刷新 / 热切泵）原样保留：
 *
 * 1. ComposerService 构造函数内联捕获（75 字符，序列表达式元素）；
 * 2. `createComposer` 内联兜底（106 字符，独立语句）；
 * 3. `_showNotification` 校验和提示静默 `return;`（34 字符）——摘除后配合
 *    product.json 校验和同步，`_isPure` 为真，通知逻辑恢复也不会弹窗；
 * 4. `//# debugId` 行之后的整个尾段运行时（约 240K 字符至文件末尾：36530 端口
 *    轮询、DOM 扫描、trace 包装 installer 等全部后台任务）。
 *
 * 前置条件（运行时缴械已另行处理内存态）：拾光 v33 自带网关后源码对
 * `__qtComposerService` / `__qtComposerBridge` 引用清零；但 15:33 打包的旧桌面端
 * 仍依赖这两个全局——摘除只改磁盘，Cursor 重启前旧包不受影响，重启后旧包的
 * 建会话 / inspect 失效（长会话 MCP 不受影响）。回滚锚点：`.sg-unpatch-backup`。
 */

/** 段 1：ComposerService 构造函数内联捕获（序列表达式元素，删除后前后逗号仍连贯）。 */
export const QT_SPAN_CONSTRUCTOR = '/* __QINGTIAN_COMPOSER_SERVICE_HOOK_V2__ */window.__qtComposerService=this,'
/** 段 2：createComposer 内联兜底（独立语句）。 */
export const QT_SPAN_CREATE_FALLBACK = '/* __QINGTIAN_COMPOSER_SERVICE_HOOK_V2__ */if(!window.__qtComposerService)window.__qtComposerService=this;'
/** 段 3：校验和提示静默（`_showNotification(){` 之后的提前返回）。 */
export const QT_SPAN_NOTIFICATION_SILENCER = '/* __QINGTIAN_SEAMLESS__ */return;'
/** 段 4 头部特征：debugId 行之后的尾段运行时必须以此开头才允许截断。 */
export const QT_TAIL_HEAD = '\n/* __QINGTIAN_SEAMLESS__ */\n'
/** debugId 行（含行尾换行）：clean bundle 以它收尾，尾段紧随其后。 */
const DEBUG_ID_LINE = /\n\/\/# debugId=[a-f0-9-]+\n/g

/** 晴天标记（摘净判定）与拾光标记（保留判定）。 */
const QT_MARKERS = ['__QINGTIAN_', '__qtComposerService'] as const
const SG_MARKERS = ['__SG_TEAM_USAGE_PATCH__', 'SG_PROFILE_REFRESH_V1', 'ZMO_SWITCH_V1_START'] as const

function countOf(source: string, needle: string): number {
  return source.split(needle).length - 1
}

export interface LegacyPatchAnalysis {
  /** 三个内联段与尾段各自是否在位。 */
  spans: { constructor: number; createFallback: number; notificationSilencer: number; tail: boolean }
  /** 拾光自有标记计数（摘除前后必须一致）。 */
  sgMarkers: Record<string, number>
  /** 晴天标记总计数（摘净后应为 0）。 */
  qtMarkerCount: number
}

export function analyzeLegacyPatch(source: string): LegacyPatchAnalysis {
  const tailStart = tailStartOf(source)
  return {
    spans: {
      constructor: countOf(source, QT_SPAN_CONSTRUCTOR),
      createFallback: countOf(source, QT_SPAN_CREATE_FALLBACK),
      notificationSilencer: countOf(source, QT_SPAN_NOTIFICATION_SILENCER),
      tail: tailStart !== undefined && source.slice(tailStart).startsWith(QT_TAIL_HEAD)
    },
    sgMarkers: Object.fromEntries(SG_MARKERS.map((marker) => [marker, countOf(source, marker)])),
    qtMarkerCount: QT_MARKERS.reduce((sum, marker) => sum + countOf(source, marker), 0)
  }
}

/** 最后一个 debugId 行结束后的下标（尾段起点候选）；找不到 debugId 行返回 undefined。 */
function tailStartOf(source: string): number | undefined {
  let last: RegExpExecArray | undefined
  DEBUG_ID_LINE.lastIndex = 0
  for (let match = DEBUG_ID_LINE.exec(source); match; match = DEBUG_ID_LINE.exec(source)) last = match
  if (!last) return undefined
  return last.index + last[0].length
}

export interface LegacyPatchRemovalResult {
  ok: boolean
  changed: boolean
  source: string
  /** 实际删除的段（名字 + 字符数），供落盘器与脚本汇报。 */
  removed: { name: string; length: number }[]
  message: string
}

/**
 * 纯函数摘除：按 4 个精确锚点删除晴天段。每段唯一才删、缺位跳过（幂等）、
 * 多处命中或尾段形态不符一律整体拒绝；删完做摘净与保留双向校验。
 */
export function removeLegacyPatchFromSource(source: string): LegacyPatchRemovalResult {
  const before = analyzeLegacyPatch(source)
  const removed: { name: string; length: number }[] = []

  const inlineSpans: { name: string; text: string; count: number }[] = [
    { name: 'constructor-capture', text: QT_SPAN_CONSTRUCTOR, count: before.spans.constructor },
    { name: 'create-composer-fallback', text: QT_SPAN_CREATE_FALLBACK, count: before.spans.createFallback },
    { name: 'notification-silencer', text: QT_SPAN_NOTIFICATION_SILENCER, count: before.spans.notificationSilencer }
  ]
  for (const span of inlineSpans) {
    if (span.count > 1) {
      return { ok: false, changed: false, source, removed: [], message: `锚点「${span.name}」出现 ${span.count} 次（应恰好 1 次），拒绝摘除` }
    }
  }

  let next = source
  for (const span of inlineSpans) {
    if (span.count !== 1) continue
    next = next.replace(span.text, '')
    removed.push({ name: span.name, length: span.text.length })
  }

  // 尾段：debugId 行后仍有内容时，必须完全是晴天尾段（以既知头部开始）才截断。
  const tailStart = tailStartOf(next)
  if (tailStart !== undefined && tailStart < next.length) {
    const tail = next.slice(tailStart)
    if (!tail.startsWith(QT_TAIL_HEAD) || !tail.includes('__QINGTIAN_')) {
      return { ok: false, changed: false, source, removed: [], message: 'debugId 行之后存在未知内容（不是既知的晴天尾段形态），拒绝截断' }
    }
    next = next.slice(0, tailStart)
    removed.push({ name: 'tail-runtime', length: tail.length })
  }

  if (removed.length === 0) {
    return { ok: true, changed: false, source, removed, message: '没有发现晴天补丁段，bundle 已是干净状态' }
  }

  const after = analyzeLegacyPatch(next)
  if (after.qtMarkerCount !== 0) {
    return { ok: false, changed: false, source, removed: [], message: `按锚点删除后仍残留 ${after.qtMarkerCount} 处晴天标记（存在未知形态的注入），拒绝落盘` }
  }
  for (const marker of SG_MARKERS) {
    if (after.sgMarkers[marker] !== before.sgMarkers[marker]) {
      return { ok: false, changed: false, source, removed: [], message: `拾光自有补丁标记「${marker}」计数变化（${before.sgMarkers[marker]} → ${after.sgMarkers[marker]}），拒绝落盘` }
    }
  }
  const totalRemoved = removed.reduce((sum, span) => sum + span.length, 0)
  if (source.length - next.length !== totalRemoved) {
    return { ok: false, changed: false, source, removed: [], message: '删除字节数与段长总和不一致，拒绝落盘' }
  }
  return { ok: true, changed: true, source: next, removed, message: `已摘除晴天补丁 ${removed.length} 段（共 ${totalRemoved} 字符）` }
}

export interface LegacyPatchRemoveOutcome {
  ok: boolean
  changed: boolean
  message: string
  removed?: { name: string; length: number }[]
  warning?: string
}

export interface LegacyPatchRemoverOptions {
  bundlePath?: string
  execFn?: (file: string, args: string[]) => Promise<void>
  platform?: NodeJS.Platform
}

/** 摘除前把带补丁的现盘留档：Cursor 重启后若旧拾光包失能，一行 cp 即可回滚。 */
export const UNPATCH_BACKUP_SUFFIX = '.sg-unpatch-backup'

export class CursorLegacyPatchRemover {
  constructor(private readonly options: LegacyPatchRemoverOptions = {}) {}

  private get bundlePath(): string {
    const located = this.options.bundlePath ?? locateCursorWorkbenchBundle()
    if (!located) {
      throw new Error(`未找到 Cursor 主程序 bundle（已查找：${cursorWorkbenchBundleCandidates().join('；') || '当前平台无默认安装位置'}）`)
    }
    return located
  }

  /** 只读检测：晴天段在位情况与拾光标记计数。 */
  status(): { bundlePath: string; analysis: LegacyPatchAnalysis } {
    const bundlePath = this.bundlePath
    return { bundlePath, analysis: analyzeLegacyPatch(readFileSync(bundlePath, 'utf8')) }
  }

  /**
   * 真摘落盘：备份（首份不覆盖）→ 内存摘除 → 语法自检 → 原子写 → 回读校验
   * （零晴天标记 + 拾光标记计数一致）→ 失败回滚 → 校验和同步 + macOS 重签。
   * 只改磁盘：运行中的 Cursor 在重启前仍跑内存里的旧 bundle。
   */
  async remove(): Promise<LegacyPatchRemoveOutcome> {
    const bundlePath = this.bundlePath
    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch (error) {
      return { ok: false, changed: false, message: `读不到 Workbench：${error instanceof Error ? error.message : String(error)}` }
    }
    const removal = removeLegacyPatchFromSource(source)
    if (!removal.ok || !removal.changed) {
      return { ok: removal.ok, changed: false, message: removal.message, removed: removal.removed }
    }
    try {
      assertJavaScriptSyntax(removal.source)
    } catch (error) {
      return { ok: false, changed: false, message: error instanceof Error ? error.message : String(error) }
    }
    const expectedSg = analyzeLegacyPatch(source).sgMarkers
    const backup = `${bundlePath}${UNPATCH_BACKUP_SUFFIX}`
    try {
      if (!existsSync(backup)) copyFileSync(bundlePath, backup)
      writeStoreFileSync(bundlePath, removal.source, { temporaryPath: `${bundlePath}.sg-unpatch.tmp` })
    } catch (error) {
      return { ok: false, changed: false, message: describeBundleWriteFailure(error, bundlePath, this.options.platform) }
    }
    try {
      const readback = readFileSync(bundlePath, 'utf8')
      const verify = analyzeLegacyPatch(readback)
      if (verify.qtMarkerCount !== 0) throw new Error(`回读仍见 ${verify.qtMarkerCount} 处晴天标记`)
      for (const [marker, count] of Object.entries(expectedSg)) {
        if (verify.sgMarkers[marker] !== count) throw new Error(`回读时拾光标记「${marker}」计数不符`)
      }
      if (readback.length !== removal.source.length) throw new Error('回读长度与写入内容不一致')
      const checksumSynced = syncProductChecksum(appRootOfBundle(bundlePath), readback)
      const warning = await resignMacApp(appRootOfBundle(bundlePath), this.options.execFn)
      const notes = [
        warning,
        checksumSynced ? undefined : 'product.json 校验和未能同步：Cursor 可能提示「安装似乎已损坏」（补丁的静默逻辑已随摘除恢复原状）'
      ].filter((note): note is string => Boolean(note))
      return {
        ok: true,
        changed: true,
        message: `${removal.message}；重启 Cursor 后生效`,
        removed: removal.removed,
        ...(notes.length > 0 ? { warning: notes.join('；') } : {})
      }
    } catch (error) {
      try {
        writeStoreFileSync(bundlePath, source, { temporaryPath: `${bundlePath}.sg-unpatch.rollback.tmp` })
      } catch { /* 返回值明确失败，备份仍在盘上供人工恢复。 */ }
      return { ok: false, changed: false, message: `写后自检失败，已回滚：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
