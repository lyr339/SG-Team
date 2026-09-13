import { execFileSync } from 'node:child_process'
import { CURSOR_CDP_DEFAULT_PORT, CURSOR_CDP_PORT_ENV } from './cursor-cdp-session-creator'

/**
 * Cursor 调试端口的启动期解析。
 *
 * Windows 会为 Hyper-V / WSL2 / Docker 保留成段的 TCP 动态端口（`netsh int ipv4 show
 * excludedportrange protocol=tcp`），落在保留段里的端口任何进程都绑不上——Cursor 带
 * `--remote-debugging-port=9333` 启动会静默失败，拾光整条 CDP 链（会话创建、过程流、
 * 看门自愈）随之全部不可用，而且没有任何报错指向端口本身。这里在桌面端启动时读一次
 * 保留段，首选端口撞上就顺延到最近的可用端口；其余平台原样返回首选端口。
 *
 * 只在启动时解析一次：端口一旦定下，创建器、观察器、看门、重启参数、账号切换全部
 * 从 CursorCdpSessionCreator.debugPort 取同一个值。
 */

export interface PortRange {
  start: number
  end: number
}

/** 首选端口：环境变量 SG_TEAM_CURSOR_CDP_PORT 覆盖，否则默认 9333（与创建器 / 观察器同一规则）。 */
export function preferredCursorCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const envPort = Number(env[CURSOR_CDP_PORT_ENV])
  return Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : CURSOR_CDP_DEFAULT_PORT
}

/**
 * 解析 netsh 输出：表头 / 分隔线因系统语言而异，数据行恒为「起始端口  结束端口 [*]」。
 * 非法或倒置的区间跳过。
 */
export function parseExcludedPortRanges(output: string): PortRange[] {
  const ranges: PortRange[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(?:\s+\*)?\s*$/.exec(line)
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2])
    if (start < 1 || end > 65_535 || end < start) continue
    ranges.push({ start, end })
  }
  return ranges
}

export function excludedRangeOf(port: number, ranges: readonly PortRange[]): PortRange | undefined {
  return ranges.find((range) => port >= range.start && port <= range.end)
}

/** 从首选端口起向上顺延，跳过保留段；attempts 内找不到就退回首选端口（让后续报错指向端口）。 */
export function pickCursorCdpPort(
  preferred: number,
  ranges: readonly PortRange[],
  attempts = 256
): { port: number; moved: boolean; blockedBy?: PortRange } {
  const blockedBy = excludedRangeOf(preferred, ranges)
  if (!blockedBy) return { port: preferred, moved: false }
  for (let offset = 1; offset <= attempts; offset += 1) {
    const candidate = preferred + offset
    if (candidate > 65_535) break
    if (!excludedRangeOf(candidate, ranges)) return { port: candidate, moved: true, blockedBy }
  }
  return { port: preferred, moved: false, blockedBy }
}

export interface CursorCdpPortResolution {
  port: number
  preferred: number
  /** 首选端口撞上保留段，已顺延。 */
  moved: boolean
  /** 首选端口所在的保留段（撞上时才有；moved=false 且有此值 = 顺延也没找到可用端口）。 */
  blockedBy?: PortRange
  /** 保留段探测本身失败（netsh 不可用等）：按首选端口继续，不阻断启动。 */
  probeError?: string
}

function defaultReadExcludedPortRanges(): string {
  return execFileSync('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true
  })
}

export function resolveCursorCdpPort(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** 测试注入：netsh 输出。 */
  readExcludedPortRanges?: () => string
} = {}): CursorCdpPortResolution {
  const preferred = preferredCursorCdpPort(options.env ?? process.env)
  if ((options.platform ?? process.platform) !== 'win32') return { port: preferred, preferred, moved: false }
  let output: string
  try {
    output = (options.readExcludedPortRanges ?? defaultReadExcludedPortRanges)()
  } catch (error) {
    return {
      port: preferred,
      preferred,
      moved: false,
      probeError: error instanceof Error ? error.message : String(error)
    }
  }
  const picked = pickCursorCdpPort(preferred, parseExcludedPortRanges(output))
  return { port: picked.port, preferred, moved: picked.moved, ...(picked.blockedBy ? { blockedBy: picked.blockedBy } : {}) }
}

/** 启动日志 / 名册提示用的人话。 */
export function describeCursorCdpPortResolution(resolution: CursorCdpPortResolution): string | undefined {
  if (resolution.moved && resolution.blockedBy) {
    return `Cursor 调试端口 ${resolution.preferred} 位于 Windows 保留端口段 ${resolution.blockedBy.start}-${resolution.blockedBy.end}（Hyper-V / WSL2 / Docker），已改用 ${resolution.port}`
  }
  if (!resolution.moved && resolution.blockedBy) {
    return `Cursor 调试端口 ${resolution.preferred} 位于 Windows 保留端口段 ${resolution.blockedBy.start}-${resolution.blockedBy.end}，且向上 256 个端口内没有可用端口；请用环境变量 ${CURSOR_CDP_PORT_ENV} 指定其他端口`
  }
  if (resolution.probeError) {
    return `未能读取 Windows 保留端口段（${resolution.probeError}），按端口 ${resolution.port} 继续`
  }
  return undefined
}
