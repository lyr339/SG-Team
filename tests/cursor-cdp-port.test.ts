import { describe, expect, it } from 'vitest'
import {
  describeCursorCdpPortResolution,
  excludedRangeOf,
  parseExcludedPortRanges,
  pickCursorCdpPort,
  preferredCursorCdpPort,
  resolveCursorCdpPort
} from '../src/infrastructure/cursor/cursor-cdp-port'

/** Windows 10 zh-CN 的真实输出形态（表头本地化，数据行两列，管理员保留段带 *）。 */
const NETSH_OUTPUT_ZH = [
  '',
  '协议 tcp 端口排除范围',
  '',
  '开始端口    结束端口',
  '----------    --------',
  '      1024        1123',
  '      5357        5357',
  '      9300        9399',
  '     50000       50059     *',
  '',
  '* - 管理的端口排除。',
  ''
].join('\r\n')

describe('Cursor 调试端口 · Windows 保留端口段', () => {
  it('解析 netsh 输出：只认「起始 结束 [*]」数据行，表头 / 分隔线 / 说明忽略，非法区间跳过', () => {
    expect(parseExcludedPortRanges(NETSH_OUTPUT_ZH)).toEqual([
      { start: 1024, end: 1123 },
      { start: 5357, end: 5357 },
      { start: 9300, end: 9399 },
      { start: 50000, end: 50059 }
    ])
    expect(parseExcludedPortRanges('Start Port    End Port\n----------    --------\n      70000       70010\n      500         400\n')).toEqual([])
    expect(parseExcludedPortRanges('')).toEqual([])
  })

  it('首选端口不在保留段：原样使用；在保留段：向上顺延到第一个可用端口', () => {
    const ranges = parseExcludedPortRanges(NETSH_OUTPUT_ZH)
    expect(excludedRangeOf(9333, ranges)).toEqual({ start: 9300, end: 9399 })
    expect(excludedRangeOf(9400, ranges)).toBeUndefined()
    expect(pickCursorCdpPort(9333, ranges)).toEqual({ port: 9400, moved: true, blockedBy: { start: 9300, end: 9399 } })
    expect(pickCursorCdpPort(9500, ranges)).toEqual({ port: 9500, moved: false })
    // 相邻保留段连着：跨过全部
    const chained = [{ start: 9333, end: 9340 }, { start: 9341, end: 9350 }]
    expect(pickCursorCdpPort(9333, chained)).toEqual({ port: 9351, moved: true, blockedBy: { start: 9333, end: 9340 } })
  })

  it('顺延范围内全被保留：退回首选端口并带上保留段，让后续报错指向端口', () => {
    const wall = [{ start: 9333, end: 9333 + 256 }]
    expect(pickCursorCdpPort(9333, wall)).toEqual({ port: 9333, moved: false, blockedBy: { start: 9333, end: 9589 } })
    // 顶到 65535 也停
    expect(pickCursorCdpPort(65_530, [{ start: 65_530, end: 65_535 }])).toEqual({ port: 65_530, moved: false, blockedBy: { start: 65_530, end: 65_535 } })
  })

  it('首选端口：环境变量合法则覆盖默认 9333', () => {
    expect(preferredCursorCdpPort({})).toBe(9333)
    expect(preferredCursorCdpPort({ SG_TEAM_CURSOR_CDP_PORT: '9444' })).toBe(9444)
    expect(preferredCursorCdpPort({ SG_TEAM_CURSOR_CDP_PORT: '0' })).toBe(9333)
    expect(preferredCursorCdpPort({ SG_TEAM_CURSOR_CDP_PORT: '70000' })).toBe(9333)
    expect(preferredCursorCdpPort({ SG_TEAM_CURSOR_CDP_PORT: 'abc' })).toBe(9333)
  })

  it('resolve：非 Windows 不探测；Windows 撞段顺延并给出说明；netsh 失败按首选端口继续并说明', () => {
    expect(resolveCursorCdpPort({ platform: 'darwin', env: {}, readExcludedPortRanges: () => { throw new Error('不该调用') } }))
      .toEqual({ port: 9333, preferred: 9333, moved: false })

    const moved = resolveCursorCdpPort({ platform: 'win32', env: {}, readExcludedPortRanges: () => NETSH_OUTPUT_ZH })
    expect(moved).toEqual({ port: 9400, preferred: 9333, moved: true, blockedBy: { start: 9300, end: 9399 } })
    expect(describeCursorCdpPortResolution(moved)).toContain('9333 位于 Windows 保留端口段 9300-9399')
    expect(describeCursorCdpPortResolution(moved)).toContain('已改用 9400')

    const clear = resolveCursorCdpPort({ platform: 'win32', env: { SG_TEAM_CURSOR_CDP_PORT: '9500' }, readExcludedPortRanges: () => NETSH_OUTPUT_ZH })
    expect(clear).toEqual({ port: 9500, preferred: 9500, moved: false })
    expect(describeCursorCdpPortResolution(clear)).toBeUndefined()

    const failed = resolveCursorCdpPort({ platform: 'win32', env: {}, readExcludedPortRanges: () => { throw new Error('netsh ENOENT') } })
    expect(failed).toEqual({ port: 9333, preferred: 9333, moved: false, probeError: 'netsh ENOENT' })
    expect(describeCursorCdpPortResolution(failed)).toContain('未能读取 Windows 保留端口段')

    const walled = resolveCursorCdpPort({ platform: 'win32', env: {}, readExcludedPortRanges: () => '      9333        9700\n' })
    expect(walled.moved).toBe(false)
    expect(describeCursorCdpPortResolution(walled)).toContain('SG_TEAM_CURSOR_CDP_PORT')
  })
})
