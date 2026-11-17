import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
