/**
 * Cursor bundle usage hook 补丁（3.6.31 / 3.21.12 兼容；可选，正常本地会话由 CDP 写后 hook 读取）。
 *
 * 背景：turnEnded 流事件携带真实计费 token（inputTokens/outputTokens/
 * cacheReadTokens/cacheWriteTokens，BigInt），但渲染进程两条消费路径都把值丢弃
 * （cloud 路径只写 status；local 路径只存 turnTokenUsage 且不随持久化落盘）。
 * CDP 注入无法触达这些闭包，唯一出路是 bundle 内定点注入——本 Cursor 构建
 * 同一 bundle 已有其他定制补丁先例，版本固定后此法稳定。
 *
 * 双锚点（59MB 全文各唯一，已验证）：
 * 1. local（拾光会话主路径，chatService.submitChatMaybeAbortCurrent 管线）：
 *    AgentResponseAdapter 的 turnEnded case——注入点能拿到 this.composerDataHandle
 *    与事件值 d（4 项 token）。
 * 2. cloud（后台 agent，bcId 路径）：
 *    CloudAgentRepository._startInteractionUpdateConsumer 的 turnEnded 分支——
 *    注入点能拿到 e（composerDataHandle）与 V.message.value。
 *
 * 注入：调用 globalThis.__sgTeamUsage(JSON)（CDP binding，由拾光
 * CursorStreamObserver 注册接收），payload = {c,i,o,r,w,t}。
 *
 * 幂等：已含 __SG_TEAM_USAGE_PATCH__ 标记则跳过；锚点数≠1 立即中止。
 * 安全：先备份 .sg-usage-backup；写 /Applications 需 macOS「App 管理」权限，
 * 写 Program Files 需 Windows 管理员权限。
 *
 * 用法：npx tsx scripts/patch-cursor-usage-hook.ts [--restore] [--bundle <path>]
 * 缺省按平台在本机 Cursor 安装位置里查找 bundle；装在别处可用 --bundle 覆盖。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { cursorWorkbenchBundleCandidates, locateCursorWorkbenchBundle } from '../src/infrastructure/cursor/cursor-install-paths'
import { readCursorCompatibility } from '../src/infrastructure/cursor/cursor-compatibility'
import { assertJavaScriptSyntax, appRootOfBundle, syncProductChecksum } from '../src/infrastructure/cursor/cursor-switch-pump-installer'
import { writeStoreFileSync } from '../src/infrastructure/fs/store-file'

const MARKER = '__SG_TEAM_USAGE_PATCH_V3__'

/** 本地路径锚点：AgentResponseAdapter turnEnded（拾光会话走这条）。 */
const LOCAL_ANCHOR = /\(([A-Za-z_$][\w$]*)\.inputTokens!==void 0\|\|\1\.outputTokens!==void 0\|\|\1\.cacheReadTokens!==void 0\|\|\1\.cacheWriteTokens!==void 0\)&&[A-Za-z_$][\w$]*\.updateComposerDataSetStore\(this\.composerDataHandle/g
/** 云端路径锚点：CloudAgentRepository turnEnded 分支（后台 agent 走这条）。 */
const CLOUD_ANCHORS = [
  /if\(([A-Za-z_$][\w$]*)\.message\.case==="turnEnded"\)\{await [A-Za-z_$][\w$]*\(\),[A-Za-z_$][\w$]*\(\),([A-Za-z_$][\w$]*)\.setData\("status","completed"\)/g,
  /if\(([A-Za-z_$][\w$]*)\.message\.case==="turnEnded"\)\{await [A-Za-z_$][\w$]*\(\1\.message\.case,\(\)=>\{[A-Za-z_$][\w$]*\(\);const [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.data\.status==="generating"/g
]

/** 本地注入：composerId 取自 handle.data；d.* 为 BigInt，Number() 收敛。 */
const LOCAL_INJECT = [
  '/* __SG_TEAM_USAGE_PATCH_V3__ */',
  'try{const __sg=globalThis.__sgTeamUsage;',
  '__sg&&__sg(JSON.stringify({c:String((this.composerDataHandle&&this.composerDataHandle.data&&this.composerDataHandle.data.composerId)||""),',
  'g:String(this.generationUUID||this.composerDataHandle?.data?.chatGenerationUUID||this.composerDataHandle?.data?.latestChatGenerationUUID||""),',
  'm:this.composerDataHandle?.data?.modelConfig?.modelName,',
  'i:Number(d.inputTokens||0),o:Number(d.outputTokens||0),',
  'r:Number(d.cacheReadTokens||0),w:Number(d.cacheWriteTokens||0),t:Date.now()}))}catch(__q){}'
].join('')

/** 云端注入：e 为 composerDataHandle。 */
const CLOUD_INJECT = [
  '/* __SG_TEAM_USAGE_PATCH_V3__ */',
  'try{const __sg=globalThis.__sgTeamUsage;',
  '__sg&&e&&e.data&&__sg(JSON.stringify({c:String(e.data.composerId||""),',
  'g:String(e.data.chatGenerationUUID||e.data.latestChatGenerationUUID||""),m:e.data.modelConfig?.modelName,',
  'i:Number(V.message.value.inputTokens||0),',
  'o:Number(V.message.value.outputTokens||0),',
  'r:Number(V.message.value.cacheReadTokens||0),',
  'w:Number(V.message.value.cacheWriteTokens||0),',
  't:Date.now()}))}catch(__q){}'
].join('')

export function patchUsageSource(source: string): string {
  if (source.includes(MARKER)) {
    if (source.split(`/* ${MARKER} */`).length !== 3 || !source.includes('g:String(this.generationUUID')
      || !source.includes('globalThis.__sgTeamUsage;__sg&&')) throw new Error('usage V3 patch incomplete')
    return source
  }
  if (source.includes('__SG_TEAM_USAGE_PATCH__')) {
    const old = /\/\* __SG_TEAM_USAGE_PATCH__ \*\/try\{const __sg=globalThis\.__sgTeamUsage;[\s\S]*?\}catch\(__q\)\{\}/g
    const matches = source.match(old)
    if (matches?.length !== 2) throw new Error('legacy usage patch mismatch')
    source = source.replace(old, '')
  }
  const locals = [...source.matchAll(LOCAL_ANCHOR)]
  const clouds = CLOUD_ANCHORS.flatMap((anchor) => [...source.matchAll(anchor)])
  const local = locals[0], cloud = clouds[0]
  if (locals.length !== 1 || !local?.[1] || clouds.length !== 1 || !cloud?.[1] || !cloud[2]) {
    throw new Error(`usage anchors mismatch (local ${locals.length}, cloud ${clouds.length})`)
  }
  // Preserve native variable names from the audited behavior, never substitute a whole native branch.
  const localInject = LOCAL_INJECT.replace(/\bd\./g, `${local[1]}.`)
  const cloudInject = CLOUD_INJECT.replace(/\bV\./g, `${cloud[1]}.`).replace(/\be\b/g, cloud[2])
  return source.replace(local[0], localInject + local[0]).replace(cloud[0], cloudInject + cloud[0])
}

function main(): void {
  const args = process.argv.slice(2)
  const restore = args.includes('--restore')
  const bundleArgIdx = args.indexOf('--bundle')
  const bundleArg = bundleArgIdx >= 0 ? args[bundleArgIdx + 1] : undefined
  const bundlePath = bundleArg ?? locateCursorWorkbenchBundle()
  if (!bundlePath || !existsSync(bundlePath)) {
    console.error(`[patch] 未找到 bundle：${bundlePath ?? cursorWorkbenchBundleCandidates().join(' | ')}（可用 --bundle 指定）`)
    process.exit(1)
  }
  const compatibility = readCursorCompatibility(bundlePath)
  if (compatibility.state !== 'supported') throw new Error(compatibility.detail)
  const backupPath = `${bundlePath}.sg-usage-backup-${compatibility.version}`

  if (restore) {
    if (!existsSync(backupPath)) {
      console.error(`[patch] 无备份可还原：${backupPath}`)
      process.exit(1)
    }
    const original = readFileSync(backupPath, 'utf8')
    assertJavaScriptSyntax(original)
    writeStoreFileSync(bundlePath, original)
    syncProductChecksum(appRootOfBundle(bundlePath), original)
    console.log(`[patch] 已还原原始 bundle（${statSync(bundlePath).size}B）`)
    return
  }

  let source = readFileSync(bundlePath, 'utf8')

  source = patchUsageSource(source)
  assertJavaScriptSyntax(source)
  // 保留首次原始备份；升级补丁不覆盖它。
  if (!existsSync(backupPath)) copyFileSync(bundlePath, backupPath)
  writeStoreFileSync(bundlePath, source)
  syncProductChecksum(appRootOfBundle(bundlePath), source)
  console.log(`[patch] 完成：local+cloud 双锚点注入；备份 → ${backupPath}（--restore 可还原）`)
  console.log('[patch] 请完全退出并重启 Cursor 生效')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
