// Roda os testes e2e do app Electron. No Linux sem tela, usa xvfb-run.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const vitestBin = path.join('node_modules', 'vitest', 'vitest.mjs')
const vitest = [vitestBin, 'run', '-c', 'vitest.e2e.config.mts']
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY
const [cmd, args] = needsXvfb ? ['xvfb-run', ['-a', process.execPath, ...vitest]] : [process.execPath, vitest]
const r = spawnSync(cmd, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
