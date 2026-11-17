import os from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // o runner Windows do CI é bem mais lento (ver SLOW em tests/helpers/env.ts)
    testTimeout: process.platform === 'win32' ? 120_000 : 30_000,
    hookTimeout: process.platform === 'win32' ? 120_000 : 30_000,
    pool: 'forks',
    // os testes de integração rodam ffmpeg em paralelo; com um arquivo por núcleo eles
    // disputam CPU e estouram os tempos-limite. Metade dos núcleos (mín. 2) é mais rápido no total.
    maxWorkers: Math.max(2, Math.floor(os.availableParallelism() / 2)),
  },
})
