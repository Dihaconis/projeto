// Gera assets/legal/third-party.md: licenças das dependências de produção
// (árvore completa a partir de package.json → dependencies), fontes, modelos e
// binários embarcados. Rodado no build.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const seen = new Map()

function findPkg(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(p)) return p
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function walk(name, fromDir) {
  const p = findPkg(name, fromDir)
  if (!p) return
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  const key = `${j.name}@${j.version}`
  if (seen.has(key)) return
  const license = typeof j.license === 'string' ? j.license : (j.license?.type ?? (Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(' OR ') : 'ver pacote'))
  seen.set(key, { name: j.name, version: j.version, license, homepage: j.homepage ?? (typeof j.repository === 'string' ? j.repository : j.repository?.url) ?? '' })
  for (const dep of Object.keys({ ...(j.dependencies ?? {}), ...(j.optionalDependencies ?? {}) })) walk(dep, path.dirname(p))
}
for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, root)
const electron = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))

const lines = [
  '# Licenças de terceiros',
  '',
  'O MUDO é construído com os componentes abaixo. Os textos completos das licenças acompanham cada',
  'pacote dentro da instalação (`resources/app.asar` / `node_modules`).',
  '',
  '## Componentes embarcados',
  '',
  `- **Electron ${electron.version}** (MIT) e **Chromium** (BSD e outras): https://www.electronjs.org`,
  '- **FFmpeg / FFprobe** (binários estáticos via ffmpeg-static/ffprobe-static; build GPL v3). O código-fonte',
  '  correspondente está em https://ffmpeg.org e nos repositórios dos pacotes; pedidos de fonte são atendidos',
  '  conforme a GPL.',
  '- **whisper.cpp** v1.9.5 (MIT): https://github.com/ggml-org/whisper.cpp — modelo `ggml-base` (MIT, OpenAI Whisper).',
  '- **CLIP ViT-B/32** em ONNX (`Xenova/clip-vit-base-patch32`, MIT, OpenAI CLIP).',
  '- **Fontes** Anton e Archivo Black — SIL Open Font License 1.1 (arquivos OFL em `assets/fonts`).',
  '- **Trilhas embutidas**: sintetizadas pelo próprio MUDO (licença própria).',
  '',
  '## Pacotes npm de produção',
  '',
  '| Pacote | Versão | Licença |',
  '|---|---|---|',
  ...[...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => `| ${d.name} | ${d.version} | ${d.license} |`),
  '',
]
fs.mkdirSync(path.join(root, 'assets', 'legal'), { recursive: true })
fs.writeFileSync(path.join(root, 'assets', 'legal', 'third-party.md'), lines.join('\n'))
console.log(`third-party.md: ${seen.size} pacotes`)
