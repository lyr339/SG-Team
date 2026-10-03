import { defineConfig } from 'vitest/config'

// 时间断言统一使用东八区。
process.env.TZ = 'Asia/Shanghai'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows CI 限制磁盘争用；失败直接呈现，不自动重试。
    maxWorkers: process.env.CI && process.platform === 'win32' ? 2 : undefined,
    // Fixture hooks have a separate default budget; slow Windows CI needs the same 20s as tests.
    hookTimeout: process.env.CI && process.platform === 'win32' ? 20_000 : 10_000,
    testTimeout: 20_000
  }
})
