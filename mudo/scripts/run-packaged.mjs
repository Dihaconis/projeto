// Gera o pacote da plataforma atual (pasta, sem instalador) e roda o smoke sobre ele.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(process.execPath, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'])
run(process.execPath, [path.join('node_modules', 'electron-builder', 'cli.js'), '--dir'])
const vitest = [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '-c', 'vitest.packaged.config.mts']
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY
const r = needsXvfb ? spawnSync('xvfb-run', ['-a', process.execPath, ...vitest], { stdio: 'inherit' }) : spawnSync(process.execPath, vitest, { stdio: 'inherit' })
process.exit(r.status ?? 1)
