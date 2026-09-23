import { defineConfig } from 'vitest/config'

// 测试用例按东八区书写（名册卡「开始 09:59」这类本地时间断言）；CI runner 是 UTC，
// 不钉住时区 mac verify 就在 npm test 上红。worker 继承这里的 process.env。
process.env.TZ = 'Asia/Shanghai'

/** 测试只收 tests/ 目录；.handoff/ 只放交接文档，不含可执行代码。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows runner 上大量 SQLite 临时库与文件扫描同时争用磁盘会让无关用例一起超时；
    // 限制并行文件数而不放宽断言/时限。macOS 和本地保持原并发。
    maxWorkers: process.env.CI && process.platform === 'win32' ? 2 : undefined,
    // windows-latest runner 的磁盘 / node:sqlite 建库偶尔慢到让默认 5s 超时（同一提交前两次绿、
    // 第三次 5 个用例超时全在建临时库的文件里）。本地 1758 个用例 25s 跑完，放宽只影响 CI 的慢盘。
    testTimeout: 20_000,
    // 仅 CI：超时类抖动重试一次；本地不重试，抖动要被看见。
    retry: process.env.CI ? 1 : 0
  }
})
