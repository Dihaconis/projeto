import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // o runner Windows do CI é bem mais lento (ver SLOW em tests/helpers/env.ts)
    testTimeout: process.platform === 'win32' ? 120_000 : 30_000,
    hookTimeout: process.platform === 'win32' ? 120_000 : 30_000,
    pool: 'forks',
  },
})
