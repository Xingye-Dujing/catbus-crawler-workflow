import { defineConfig } from 'vitest/config'

// 在线测试（AGENTS 7.5）：不加载 tests/setup.ts，请求打到真实平台
export default defineConfig({
  test: {
    include: ['**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
