import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import type { CursorSwitchPumpOutcome, CursorSwitchPumpStatus } from '../../domain/cursor-switch-pump'
import { writeStoreFileSync } from '../fs/store-file'
import { appRootOfBundle, cursorWorkbenchBundleCandidates, locateCursorWorkbenchBundle } from './cursor-install-paths'
import { cursorRuntimeBackupPath, readCursorCompatibility } from './cursor-compatibility'
import { WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS, resolveWindowsCursorWorkbench } from './cursor-windows-launch'
import type { CursorCompatibilityObserver } from '../../domain/cursor-compatibility-notification'

const execFileAsync = promisify(execFile)

/** IPC 契约类型与 domain 单一出处对齐（结构一致，本地别名保住既有可读性）。 */
export type SwitchPumpStatus = CursorSwitchPumpStatus
export type SwitchPumpInstallOutcome = CursorSwitchPumpOutcome
export { appRootOfBundle } from './cursor-install-paths'

/**
 * 切号泵补丁（ZMO_SWITCH_V1）安装器。
 *
 * 补丁注入 Cursor workbench 主 bundle 的鉴权服务构造器：轮询 127.0.0.1 回环
 * 服务器取票 → 调 Cursor 自身 authenticationService 写票 → 广播登录变更 →
 * flush → 回执。与运行时换号桥（cursor-runtime-account-bridge）是同一套
 * /v1/switch 协议的两端；界标与配置注释格式必须保持兼容——
 * cursor-runtime-companion-config 的 CONFIG_PATTERN / RUNTIME_PATTERN 依赖它。
 */

export const SWITCH_PUMP_START = '/*ZMO_SWITCH_V1_START*/'
export const SWITCH_PUMP_END = '/*ZMO_SWITCH_V1_END*/'
export const SWITCH_PUMP_REVISION = 1
export const SWITCH_PUMP_OWNER = '/*SG_SWITCH_PUMP_MANAGED_V1*/'
/** Both audited builds' account card watches signedIn; email changes trigger an asynchronous profile refresh. */
export const PROFILE_REFRESH_HOOK = '/*SG_PROFILE_REFRESH_V1*/'

const CONFIG_PREFIX = '/*ZMO_SWITCH_CONFIG:'
/** 与 cursor-runtime-companion-config.ts 的 CONFIG_PATTERN 保持一致。 */
const CONFIG_PATTERN = /\/\*ZMO_SWITCH_CONFIG:([A-Za-z0-9+/=]+)\*\//

/** 鉴权构造器锚点：赋值语句各唯一且 store 在 override 之后才算认得这个构造器。 */
const OVERRIDE_ANCHOR = /this\.overrideAccessToken\s*=/g
const STORE_ANCHOR = /this\.storeAccessRefreshToken\s*=/g
/** 锚点附近必须出现的鉴权服务行为标记（防误认其他构造器）。 */
const NEARBY_MARKERS = ['storageService', 'notifyLoginChangedListeners', 'storeEmailAndSignUpType']
const NEARBY_WINDOW = 16_000
// Match the effect's behavior, retaining every minified identifier from the selected build.
const PROFILE_REFRESH_ANCHOR = /[A-Za-z_$][\w$]*\(\(\)=>\{if\(!([A-Za-z_$][\w$]*)\.signedIn\(\)\)\{[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\(!1\);return\}/g
const PROFILE_REFRESH_INSTALLED = /[A-Za-z_$][\w$]*\(\(\)=>\{\/\*SG_PROFILE_REFRESH_V1\*\/([A-Za-z_$][\w$]*)\.displayEmail\(\);if\(!\1\.signedIn\(\)\)\{[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\(!1\);return\}/

function hasProfileRefreshHook(source: string): boolean {
  return source.split(PROFILE_REFRESH_HOOK).length === 2 && PROFILE_REFRESH_INSTALLED.test(source)
}

/** 写新票前清掉的鉴权缓存键（顺序与小辰一致，协议侧无顺序依赖）。 */
const CLEAR_KEYS = [
  'cursorAuth/authId',
  'cursorAuth/isAuthenticated',
  'cursorAuth/isAuthorized',
  'cursorAuth/isLoggedIn',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/stripeSubscriptionStatus',
  'cursorAuth/onboardingDate',
  'cursor.accessToken',
  'cursor.email'
]

export interface SwitchPumpConfig {
  port: number
  key: string
  revision?: number
}

export interface SwitchPumpAnalysis {
  /** 界标是否在位（含配置可解析）。 */
  installed: boolean
  /** 锚点是否支持安装（界标剥离后的纯净代码上判定）。 */
  supported: boolean
  /** 已安装补丁的配置（port/key/revision），未安装时缺省。 */
  config?: { port: number; key: string; revision: number }
  /** 带拾光所有权界标；外部兼容泵只复用，不覆盖或卸载。 */
  managed: boolean
  /** 注入点（storeAccessRefreshToken 赋值处）在纯净代码中的下标，不支持时为 -1。 */
  injectionIndex: number
  /** 不支持时的原因（人话）。 */
  reason?: string
}

function runtimeMatchesConfig(source: string, config: { port: number; key: string }): boolean {
  const runtime = `const zP=${config.port},zK=${JSON.stringify(config.key)}`
  return source.includes(runtime)
    && source.includes('/v1/switch')
    && source.includes('/v1/switch-done')
    && source.includes('storeAccessRefreshToken')
    && source.includes('notifyLoginChangedListeners')
    && source.includes('storageService.flush')
    && source.includes('readback-mismatch')
}

export interface SwitchPumpEditResult {
  ok: boolean
  changed: boolean
  source: string
  message: string
}

/**
 * 给已审查的 Cursor 资料卡补一条响应式依赖；标识符来自当前 bundle 而非硬编码混淆名。cachedEmail 在换号时变化，
 * effect 因而异步重跑 getMe；不等待资料请求，也不改变核心换号回执时序。
 */
export function installProfileRefreshHook(source: string): SwitchPumpEditResult {
  if (source.includes(PROFILE_REFRESH_HOOK)) {
    return hasProfileRefreshHook(source)
      ? { ok: true, changed: false, source, message: '账号资料异步刷新已启用' }
      : { ok: false, changed: false, source, message: '账号资料刷新界标损坏，拒绝覆盖未知代码' }
  }
  const matches = [...source.matchAll(PROFILE_REFRESH_ANCHOR)]
  const match = matches[0]
  if (matches.length !== 1 || match?.index === undefined || !match[1]) {
    return { ok: false, changed: false, source, message: `账号资料卡锚点数量异常（${matches.length}）` }
  }
  const first = match.index
  const replacement = match[0].replace('()=>{', `()=>{${PROFILE_REFRESH_HOOK}${match[1]}.displayEmail();`)
  return {
    ok: true,
    changed: true,
    source: source.slice(0, first) + replacement + source.slice(first + match[0].length),
    message: '账号资料异步刷新已启用'
  }
}

/** 剥掉界标之间的既有补丁（不成对则原样返回——分析阶段永远不丢代码）。 */
function stripMarked(source: string): string {
  const start = source.indexOf(SWITCH_PUMP_START)
  if (start < 0) return source
  const end = source.indexOf(SWITCH_PUMP_END, start)
  if (end < 0) return source
  return source.slice(0, start) + source.slice(end + SWITCH_PUMP_END.length)
}

function readEmbeddedConfig(source: string): { port: number; key: string; revision: number } | undefined {
  const match = CONFIG_PATTERN.exec(source)
  if (!match?.[1]) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Record<string, unknown>
    const port = Number(parsed.port)
    const key = typeof parsed.key === 'string' ? parsed.key : ''
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !key) return undefined
    return { port, key, revision: Number(parsed.revision) || 0 }
  } catch {
    return undefined
  }
}

/**
 * 分析 workbench bundle：界标是否在位、鉴权构造器锚点是否支持注入。
 * 锚点统计恒在剥离补丁后的纯净代码上进行——补丁自身引用 overrideAccessToken
 * （typeof 判断），不剥离会虚增锚点计数导致误拒（小辰同款处理）。
 */
export function analyzeSwitchPump(source: string): SwitchPumpAnalysis {
  const stripped = stripMarked(source)
  const overrideHits = [...stripped.matchAll(OVERRIDE_ANCHOR)].map((hit) => hit.index ?? -1)
  const storeHits = [...stripped.matchAll(STORE_ANCHOR)].map((hit) => hit.index ?? -1)
  const overrideIndex = overrideHits[0] ?? -1
  const storeIndex = storeHits[0] ?? -1

  const marked = source.includes(SWITCH_PUMP_START) && source.includes(SWITCH_PUMP_END)
  const config = marked ? readEmbeddedConfig(source) : undefined
  const installed = config !== undefined && runtimeMatchesConfig(source, config)
  const managed = source.includes(SWITCH_PUMP_OWNER)

  let supported = false
  let reason: string | undefined
  if (overrideHits.length !== 1 || storeHits.length !== 1) {
    reason = `鉴权构造器锚点不唯一（override ${overrideHits.length} 处 / store ${storeHits.length} 处），拒绝安装`
  } else if (storeIndex <= overrideIndex) {
    reason = '鉴权构造器锚点顺序异常（store 不在 override 之后），拒绝安装'
  } else {
    const nearby = stripped.slice(Math.max(0, overrideIndex - NEARBY_WINDOW), Math.min(stripped.length, storeIndex + NEARBY_WINDOW))
    const missing = NEARBY_MARKERS.filter((marker) => !nearby.includes(marker))
    if (missing.length > 0) {
      reason = `锚点附近认不出鉴权服务构造器（缺 ${missing.join(' / ')}），拒绝安装`
    } else {
      supported = true
    }
  }

  return {
    installed: installed && config !== undefined,
    supported,
    managed,
    ...(config ? { config } : {}),
    injectionIndex: supported ? storeIndex : -1,
    ...(reason ? { reason } : {})
  }
}

/** 已安装补丁配置与目标配置一致（端口+密钥相同）时视为无需变更。 */
export function switchPumpMatches(source: string, config: SwitchPumpConfig): boolean {
  const analysis = analyzeSwitchPump(source)
  const installed = analysis.config
  if (!analysis.installed || !installed || installed.port !== config.port || installed.key !== config.key) return false
  // 拾光管理的泵必须跟当前模板 revision 一致；外部兼容泵按运行体能力复用。
  return !analysis.managed || installed.revision === (config.revision ?? SWITCH_PUMP_REVISION)
}

/**
 * 生成补丁运行体（不含界标）：
 * 配置注释 + 轮询 IIFE。箭头函数 + 构造器内注入 → this 恒为鉴权服务实例。
 * 运行体字面形状（const zP=…,zK="…"）是 companion-config RUNTIME_PATTERN 的锚。
 */
export function buildSwitchPump(config: SwitchPumpConfig): string {
  const encoded = Buffer.from(
    JSON.stringify({ port: config.port, key: config.key, revision: config.revision ?? SWITCH_PUMP_REVISION }),
    'utf8'
  ).toString('base64')
  const keyLiteral = JSON.stringify(config.key)
  const clearKeysLiteral = JSON.stringify(CLEAR_KEYS)
  const runtime = '(()=>{'
    + `const zP=${config.port},zK=${keyLiteral},zH={"X-Zhimo-Switch-Key":zK};`
    + 'const zF=(zU,zO)=>fetch("http://127.0.0.1:"+zP+zU,zO);'
    + 'const zSub=zT=>{try{const zB=String(zT).split(".")[1].replace(/-/g,"+").replace(/_/g,"/");return JSON.parse(atob(zB.padEnd(zB.length+(4-zB.length%4)%4,"="))).sub||""}catch(zE){return""}};'
    + 'const zStore=(zN,zV)=>{try{this.storageService.store(zN,zV,-1,1)}catch(zE){}};'
    + 'const zRun=async zD=>{let zOk=!1,zWhy="";try{'
    + 'if(!zD.accessToken){zWhy="no-access-token";return}'
    + 'if(!this.storageService){zWhy="no-storage-service";return}'
    + 'try{if(this.localOverrideAccessToken&&typeof this.overrideAccessToken==="function")this.overrideAccessToken(void 0)}catch(zE){}'
    + `for(const zN of ${clearKeysLiteral})zStore(zN,null);`
    + 'const zA=String(zD.accessToken),zR=String(zD.refreshToken||zD.accessToken);'
    + 'this.storeAccessRefreshToken(zA,zR);'
    + 'const zEm=String(zD.email||"").trim();'
    + 'try{if(zEm&&typeof this.storeEmailAndSignUpType==="function")this.storeEmailAndSignUpType(zEm,String(zD.signUpType||"Auth_0"));else{zStore("cursorAuth/cachedEmail","");zStore("cursorAuth/cachedSignUpType","")}}catch(zE){}'
    + 'const zId=String(zD.userId||"")||zSub(zA);'
    + 'if(zId){zStore("cursorAuth/userId",zId);zStore("cursorAuth/cachedUserId",zId);zStore("cursorAuth/authId",zId)}'
    + 'try{if(typeof this.notifyLoginChangedListeners==="function")this.notifyLoginChangedListeners(!0)}catch(zE){}'
    + 'try{if(typeof this.refreshMembership==="function")Promise.resolve(this.refreshMembership()).catch(()=>{})}catch(zE){}'
    + 'try{if(typeof this.storageService.flush==="function")await this.storageService.flush()}catch(zE){}'
    + 'zOk=String(this.accessToken?.()||"")===zA;if(!zOk)zWhy="readback-mismatch"'
    + '}catch(zE){zWhy=String(zE&&zE.message||zE||"threw")}'
    + 'finally{try{await zF("/v1/switch-done",{method:"POST",headers:{...zH,"Content-Type":"application/json"},body:JSON.stringify({nonce:zD.nonce,success:zOk,reason:zWhy})})}catch(zE){}}};'
    + 'const zPoll=async()=>{try{const zResp=await zF("/v1/switch",{headers:zH});if(zResp.status!==200)return;const zD=await zResp.json();if(zD&&zD.nonce)await zRun(zD)}catch(zE){}};'
    + 'setTimeout(()=>{zPoll();setInterval(zPoll,1500)},1500)})()'
  return `${SWITCH_PUMP_OWNER}${CONFIG_PREFIX}${encoded}*/${runtime}`
}

/**
 * 把补丁注入鉴权构造器（storeAccessRefreshToken 赋值处）。
 * 注入点前一字符是逗号（压缩后的序列表达式）则按序列元素接入，否则按语句接入。
 */
export function installSwitchPump(source: string, config: SwitchPumpConfig): SwitchPumpEditResult {
  if (source.includes(SWITCH_PUMP_START) && !source.includes(SWITCH_PUMP_OWNER)) {
    return { ok: false, changed: false, source, message: '检测到其他工具管理的切号泵，拾光只复用，不覆盖' }
  }
  const stripped = stripMarked(source)
  const analysis = analyzeSwitchPump(stripped)
  if (!analysis.supported) {
    return { ok: false, changed: false, source, message: analysis.reason ?? '认不出鉴权构造器' }
  }
  if (switchPumpMatches(source, config)) {
    return { ok: true, changed: false, source, message: '切号补丁已是当前配置' }
  }
  const pump = buildSwitchPump(config)
  const at = analysis.injectionIndex
  const commaContext = stripped[at - 1] === ','
  const block = commaContext
    ? `${SWITCH_PUMP_START}${pump},${SWITCH_PUMP_END}`
    : `${SWITCH_PUMP_START};${pump};${SWITCH_PUMP_END}`
  const next = stripped.slice(0, at) + block + stripped.slice(at)
  const verify = analyzeSwitchPump(next)
  if (!verify.installed || !verify.supported || !switchPumpMatches(next, config)) {
    return { ok: false, changed: false, source, message: '补丁写完自检没过（界标或配置复读失败），拒绝落盘' }
  }
  return { ok: true, changed: true, source: next, message: '切号补丁已生成' }
}

/** 卸载补丁：界标不成对或剥完认不出构造器都拒绝落盘（宁可留在盘上也不写坏）。 */
export function removeSwitchPumpFromSource(source: string): SwitchPumpEditResult {
  if (!source.includes(SWITCH_PUMP_START)) {
    return { ok: true, changed: false, source, message: '本来就没装切号补丁' }
  }
  if (!source.includes(SWITCH_PUMP_OWNER)) {
    return { ok: false, changed: false, source, message: '当前切号泵由其他工具管理，拾光不执行卸载' }
  }
  const stripped = stripMarked(source)
  if (stripped.includes(SWITCH_PUMP_START) || stripped.includes(SWITCH_PUMP_END)) {
    return { ok: false, changed: false, source, message: '补丁界标不成对，剥不干净，拒绝落盘' }
  }
  if (!analyzeSwitchPump(stripped).supported) {
    return { ok: false, changed: false, source, message: '剥完之后认不出鉴权构造器了，说明剥多了，拒绝落盘' }
  }
  return { ok: true, changed: true, source: stripped, message: '切号补丁已卸载' }
}

/** Parse as ESM in an isolated Node process. SourceTextModule never links or executes the bundle. */
export function assertJavaScriptSyntax(source: string): void {
  const check = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e',
    'try{new(require("node:vm").SourceTextModule)(require("node:fs").readFileSync(0,"utf8"))}'
    + 'catch(e){process.stderr.write(String(e.message).slice(0,240));process.exitCode=1}'
  ], {
    input: source, encoding: 'utf8', timeout: 45_000, maxBuffer: 8_192, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }
  })
  if (check.error || check.status !== 0) {
    const detail = check.error?.message || check.stderr?.trim() || `解析器未完成（${check.signal ?? check.status}）`
    throw new Error(`补丁自检没过（语法解析失败：${detail.slice(0, 160)}），没有写盘`)
  }
}

/** product.json 校验和键：workbench bundle 相对 app 根的路径（去掉 out/ 前缀）。 */
const WORKBENCH_CHECKSUM_KEY = 'vs/workbench/workbench.desktop.main.js'

function productChecksum(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('base64').replace(/=+$/, '')
}

/**
 * 同步 product.json 的 workbench 校验和，避免 Cursor 启动报「安装似乎已损坏」。
 * 键不存在/读不到/写不进都按 best-effort 收场（返回 false 由调用方决定提示口径）。
 */
export function syncProductChecksum(appRoot: string, source: string): boolean {
  const productPath = join(appRoot, 'product.json')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(productPath, 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const checksums = parsed.checksums
  if (!checksums || typeof checksums !== 'object' || !(WORKBENCH_CHECKSUM_KEY in (checksums as Record<string, unknown>))) {
    return false
  }
  const table = checksums as Record<string, string>
  const next = productChecksum(source)
  if (table[WORKBENCH_CHECKSUM_KEY] === next) return true
  table[WORKBENCH_CHECKSUM_KEY] = next
  try {
    writeStoreFileSync(productPath, `${JSON.stringify(parsed, null, 2)}\n`, { temporaryPath: `${productPath}.sg-checksum.tmp` })
    return true
  } catch {
    return false
  }
}

/** 从 app 根目录向上找 .app bundle 路径（macOS 重签名目标）。 */
export function macBundlePathFromAppRoot(appRoot: string): string | undefined {
  let current = normalize(appRoot)
  for (;;) {
    if (current.toLowerCase().endsWith('.app')) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * macOS 改写 bundle 后重签名（ad-hoc）。失败不阻断安装——Electron 校验的是
 * asar 完整性而非签名本身，签名失效最多换来 Gatekeeper 提示；错误交由调用方提示。
 */
export async function resignMacApp(
  appRoot: string,
  execFn: (file: string, args: string[]) => Promise<void> = async (file, args) => {
    await execFileAsync(file, args, { timeout: 300_000, maxBuffer: 1024 * 1024 })
  }
): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const bundle = macBundlePathFromAppRoot(appRoot)
  if (!bundle) return `没有从 app 根目录找到 .app：${appRoot}`
  try {
    await execFn('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
    return undefined
  } catch (error) {
    return `Cursor.app 重签名失败（功能不受影响）：${error instanceof Error ? error.message : String(error)}`
  }
}

export interface SwitchPumpInstallerOptions {
  /** Presentation only. It receives neither credentials nor patch config and cannot control any command. */
  statusObserver?: CursorCompatibilityObserver
  bundlePath?: string
  locateBundle?: () => Promise<string | undefined>
  execFn?: (file: string, args: string[]) => Promise<void>
  /** 平台注入点（测试替身）：路径定位与写失败提示。 */
  platform?: NodeJS.Platform
}

/**
 * 改写 bundle 失败的人话。Windows 上 EPERM / EACCES / EBUSY 几乎只有三种来历：
 * Cursor 还开着（Windows 不允许替换被占用的文件，mac 可以）、杀软实时扫描短暂锁住
 * 刚写出的 61 MB 临时文件、Cursor 装在 Program Files（「所有用户」安装，改文件要管理员）。
 * 原始错误保留在末尾，供排查。
 */
export function describeBundleWriteFailure(error: unknown, bundlePath: string, platform: NodeJS.Platform = process.platform): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const detail = error instanceof Error ? error.message : String(error)
  if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
    return `写 Workbench 失败：${detail}`
  }
  const hints = [
    '先完全退出 Cursor（任务管理器里不再有 Cursor.exe）再重试',
    /\bProgram Files\b/i.test(bundlePath)
      ? '这份 Cursor 是「所有用户」安装（Program Files），改写需要以管理员身份运行拾光，或改用「仅当前用户」安装'
      : undefined,
    '装有杀毒软件时稍候几秒再试（实时扫描可能短暂锁住刚写出的文件）'
  ].filter((hint): hint is string => Boolean(hint))
  return `写 Workbench 失败（${code}）：${hints.join('；')}。原始错误：${detail}`
}

export class CursorSwitchPumpInstaller {
  constructor(private readonly options: SwitchPumpInstallerOptions = {}) {}

  private async resolveBundlePath(): Promise<string> {
    if (this.options.bundlePath) return this.options.bundlePath
    let located: string | undefined
    if (this.options.locateBundle) {
      located = await this.options.locateBundle()
    } else if ((this.options.platform ?? process.platform) === 'win32') {
      located = await resolveWindowsCursorWorkbench((file, args) =>
        execFileAsync(file, args, { timeout: WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }))
    } else {
      located = locateCursorWorkbenchBundle()
    }
    if (!located) {
      throw new Error(`未找到 Cursor 主程序 bundle（已查找：${cursorWorkbenchBundleCandidates().join('；') || '当前平台无默认安装位置'}）`)
    }
    return located
  }

  /** 只读检测（零副作用）：维护页状态卡与热切降级判定共用。 */
  async status(): Promise<SwitchPumpStatus> {
    let observation: ReturnType<CursorCompatibilityObserver['begin']> | undefined
    try { observation = this.options.statusObserver?.begin() } catch { /* Observation cannot block original status inspection. */ }
    let result: SwitchPumpStatus
    try { result = await this.inspectStatus() }
    catch (error) {
      try { observation?.complete({ compatibility: 'unavailable', patch: 'unavailable' }) } catch {}
      throw error
    }
    if (result.bundlePath) result.installationId = createHash('sha256').update(normalize(result.bundlePath)).digest('hex')
    try {
      observation?.complete({
        ...(result.installationId ? { installationId: result.installationId } : {}),
        ...(result.compatibility?.version ? { version: result.compatibility.version } : {}),
        compatibility: result.compatibility?.state ?? 'unavailable', patch: result.kind,
        ...(result.profileRefreshReady !== undefined ? { profileRefreshReady: result.profileRefreshReady } : {})
      })
    } catch { /* Config, secrets and original diagnostics remain at their source. */ }
    return result
  }
  private async inspectStatus(): Promise<SwitchPumpStatus> {
    let bundlePath: string
    try {
      bundlePath = await this.resolveBundlePath()
    } catch (error) {
      return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch (error) {
      return {
        kind: 'unavailable',
        bundlePath,
        message: `读不到 Workbench：${error instanceof Error ? error.message : String(error)}`
      }
    }
    const compatibility = readCursorCompatibility(bundlePath)
    const provenance = { bundlePath, compatibility, profileRefreshReady: hasProfileRefreshHook(source) }
    if (compatibility.state !== 'supported') {
      return { ...provenance, kind: compatibility.state === 'unsupported' ? 'unsupported' : 'unavailable', message: compatibility.detail }
    }
    const analysis = analyzeSwitchPump(source)
    if (analysis.installed && analysis.config) {
      // 外部兼容泵按能力复用；拾光自己管理的泵必须与当前模板 revision 一致。
      // 否则账号页会把旧运行体误判为可用，直到真正热切时才超时失败。
      if (analysis.managed && analysis.config.revision !== SWITCH_PUMP_REVISION) {
        return {
          kind: 'not-installed',
          ...provenance,
          managed: true,
          message: `拾光切号补丁需要更新（当前版本 ${analysis.config.revision}，目标版本 ${SWITCH_PUMP_REVISION}）`
        }
      }
      return {
        kind: 'installed', ...provenance, config: analysis.config, managed: analysis.managed,
        message: !provenance.profileRefreshReady
          ? '切号泵已安装；账号资料刷新需补全'
          : analysis.managed
            ? `拾光切号补丁已安装（端口 ${analysis.config.port}）`
            : `检测到兼容切号补丁（端口 ${analysis.config.port}，由其他工具管理）`
      }
    }
    if (source.includes(SWITCH_PUMP_START) || source.includes(SWITCH_PUMP_END)) {
      return {
        kind: 'unsupported',
        ...provenance,
        message: '检测到切号泵界标，但配置或运行体校验未通过；请先恢复对应工具的原始补丁'
      }
    }
    if (!analysis.supported) {
      return { kind: 'unsupported', ...provenance, message: analysis.reason ?? '这个 Cursor 版本装不了切号补丁' }
    }
    return { kind: 'not-installed', ...provenance, message: '切号补丁未安装' }
  }

  /** 读取运行中 Cursor 正在轮询的补丁配置（热切绑端口的依据）；未安装返回 undefined。 */
  async readInstalledConfig(): Promise<{ port: number; key: string; revision: number } | undefined> {
    try {
      const bundlePath = await this.resolveBundlePath()
      if (readCursorCompatibility(bundlePath).state !== 'supported') return undefined
      const analysis = analyzeSwitchPump(readFileSync(bundlePath, 'utf8'))
      if (!analysis.installed || !analysis.config) return undefined
      if (analysis.managed && analysis.config.revision !== SWITCH_PUMP_REVISION) return undefined
      return analysis.config
    } catch {
      return undefined
    }
  }

  /**
   * 安装/更新切号补丁：原子写 → 回读校验 → 校验和同步 → macOS 重签名（best-effort）。
   * 补丁住在鉴权构造器里，运行中的 Cursor 读不到新字节——装完必须重启 Cursor 才生效。
   */
  async ensure(config: SwitchPumpConfig): Promise<SwitchPumpInstallOutcome> {
    const bundlePath = await this.resolveBundlePath()
    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch (error) {
      return { ok: false, changed: false, message: `读不到 Workbench：${error instanceof Error ? error.message : String(error)}` }
    }
    const compatibility = readCursorCompatibility(bundlePath)
    if (compatibility.state !== 'supported') {
      return { ok: false, changed: false, message: compatibility.detail }
    }
    const existing = analyzeSwitchPump(source)
    const external = existing.installed && existing.config && !existing.managed
    const installed = external
      ? {
          ok: true,
          changed: false,
          source,
          message: `已检测到兼容切号补丁（端口 ${existing.config!.port}），拾光直接复用且不覆盖`
        }
      : switchPumpMatches(source, config)
        ? { ok: true, changed: false, source, message: '切号补丁已是当前配置' }
        : installSwitchPump(source, config)
    if (!installed.ok) return { ok: false, changed: false, message: installed.message }

    // 资料卡修复是独立界标：兼容外部切号泵时只改侧栏依赖，不触碰其配置与运行体。
    const profileRefresh = installProfileRefreshHook(installed.source)
    if (!profileRefresh.ok) {
      return { ok: false, changed: false, message: `Cursor ${compatibility.version} 资料刷新适配未通过：${profileRefresh.message}。未修改安装` }
    }
    const nextSource = profileRefresh.source
    const changed = installed.changed || profileRefresh.changed
    if (!changed) return { ok: true, changed: false, message: installed.message }
    try {
      assertJavaScriptSyntax(nextSource)
    } catch (error) {
      return { ok: false, changed: false, message: error instanceof Error ? error.message : String(error) }
    }
    // An external updater may have replaced the installation while the parser was running.
    try {
      const current = readCursorCompatibility(bundlePath)
      if (readFileSync(bundlePath, 'utf8') !== source || current.state !== 'supported' || current.version !== compatibility.version) {
        return { ok: false, changed: false, message: 'Cursor 安装在检查期间发生变化；请重新检测后再安装' }
      }
    } catch {
      return { ok: false, changed: false, message: 'Cursor 安装在检查期间不可读；请重新检测后再安装' }
    }
    // 备份只留第一份原始盘片：覆盖成已补丁版本就失去了还原锚点。
    const backup = cursorRuntimeBackupPath(bundlePath)
    try {
      if (!existsSync(backup)) copyFileSync(bundlePath, backup)
      writeStoreFileSync(bundlePath, nextSource, { temporaryPath: `${bundlePath}.sg-switch-pump.tmp` })
    } catch (error) {
      return { ok: false, changed: false, message: describeBundleWriteFailure(error, bundlePath, this.options.platform) }
    }
    let readback: string
    try {
      readback = readFileSync(bundlePath, 'utf8')
      const readbackPump = analyzeSwitchPump(readback)
      const pumpMatches = external
        ? readbackPump.installed
          && readbackPump.managed === false
          && readbackPump.config?.port === existing.config!.port
          && readbackPump.config.key === existing.config!.key
        : switchPumpMatches(readback, config)
      if (!pumpMatches) throw new Error('回读配置或运行体不一致')
      if (!hasProfileRefreshHook(readback)) throw new Error('账号资料刷新界标回读失败')
    } catch (error) {
      // 写后自检失败时立刻恢复本次写入前的字节，避免留下半可用 Cursor。
      try {
        writeStoreFileSync(bundlePath, source, { temporaryPath: `${bundlePath}.sg-switch-pump.rollback.tmp` })
      } catch { /* 返回值明确失败，备份仍保留供人工恢复。 */ }
      return { ok: false, changed: false, message: `写后自检失败，已回滚：${error instanceof Error ? error.message : String(error)}` }
    }
    const checksumSynced = syncProductChecksum(appRootOfBundle(bundlePath), readback)
    const warning = await resignMacApp(appRootOfBundle(bundlePath), this.options.execFn)
    const notes = [
      warning,
      checksumSynced ? undefined : 'product.json 校验和未能同步：Cursor 可能提示「安装似乎已损坏」，功能不受影响'
    ].filter((note): note is string => Boolean(note))
    return {
      ok: true,
      changed: true,
      message: installed.changed
        ? '切号补丁已装好。重启一次 Cursor 后生效。'
        : '账号资料异步刷新已启用。重启一次 Cursor 后，后续无感换号会同步更新侧栏姓名与头像。',
      ...(notes.length > 0 ? { warning: notes.join('；') } : {})
    }
  }

  /** 卸载补丁（维护页「移除」能力；同样需重启 Cursor 生效）。 */
  async remove(): Promise<SwitchPumpInstallOutcome> {
    const bundlePath = await this.resolveBundlePath()
    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch (error) {
      return { ok: false, changed: false, message: `读不到 Workbench：${error instanceof Error ? error.message : String(error)}` }
    }
    const removed = removeSwitchPumpFromSource(source)
    if (!removed.ok || !removed.changed) {
      return { ok: removed.ok, changed: false, message: removed.message }
    }
    try {
      assertJavaScriptSyntax(removed.source)
    } catch (error) {
      return { ok: false, changed: false, message: error instanceof Error ? error.message : String(error) }
    }
    try {
      writeStoreFileSync(bundlePath, removed.source, { temporaryPath: `${bundlePath}.sg-switch-pump.tmp` })
    } catch (error) {
      return { ok: false, changed: false, message: describeBundleWriteFailure(error, bundlePath, this.options.platform) }
    }
    let readback: string
    try {
      readback = readFileSync(bundlePath, 'utf8')
      if (readback.includes(SWITCH_PUMP_START) || !analyzeSwitchPump(readback).supported) throw new Error('卸载后回读校验失败')
    } catch (error) {
      try {
        writeStoreFileSync(bundlePath, source, { temporaryPath: `${bundlePath}.sg-switch-pump.rollback.tmp` })
      } catch { /* 返回值明确失败，原始备份仍保留。 */ }
      return { ok: false, changed: false, message: `卸载自检失败，已回滚：${error instanceof Error ? error.message : String(error)}` }
    }
    syncProductChecksum(appRootOfBundle(bundlePath), readback)
    const warning = await resignMacApp(appRootOfBundle(bundlePath), this.options.execFn)
    return {
      ok: true,
      changed: true,
      message: '切号补丁已卸载，重启 Cursor 生效。',
      ...(warning ? { warning } : {})
    }
  }
}
