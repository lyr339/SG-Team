import { defineConfig } from 'vitest/config'

// 测试用例按东八区书写（名册卡「开始 09:59」这类本地时间断言）；CI runner 是 UTC，
// 不钉住时区 mac verify 就在 npm test 上红。worker 继承这里的 process.env。
process.env.TZ = 'Asia/Shanghai'

/** 测试只收 tests/ 目录；.handoff/ 只放交接文档，不含可执行代码。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}']
  }
})
