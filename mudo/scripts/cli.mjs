// Desenvolvimento: roda a CLI compilada (out/main/cli.js) com o Electron do
// projeto em modo Node — o mesmo jeito que o app instalado roda (`mudo.cmd`).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
delete env.NODE_OPTIONS
const r = spawnSync(electron, [path.join(root, 'out', 'main', 'cli.js'), ...process.argv.slice(2)], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
