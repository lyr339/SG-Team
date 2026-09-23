import { defineConfig } from 'vitest/config'

// 时间断言统一使用东八区。
process.env.TZ = 'Asia/Shanghai'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows CI 限制磁盘争用；失败直接呈现，不自动重试。
    maxWorkers: process.env.CI && process.platform === 'win32' ? 2 : undefined,
    testTimeout: 20_000
  }
})
