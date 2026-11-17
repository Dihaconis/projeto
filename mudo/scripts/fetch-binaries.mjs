// Prepara os binários nativos em resources/bin (vão para extraResources):
//  - whisper-cli: compilado do código-fonte do whisper.cpp numa tag fixa, com o
//    commit conferido (o git verifica a integridade do conteúdo pelo hash).
//  - ffmpeg/ffprobe: copiados dos pacotes ffmpeg-static/ffprobe-static e
//    conferidos contra o SHA-256 registrado em scripts/binaries.lock.json.
// Uso: node scripts/fetch-binaries.mjs [--update]
// Requer cmake e um compilador C++ (no Windows: Visual Studio Build Tools).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const lockFile = path.join(root, 'scripts', 'binaries.lock.json')
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
const update = process.argv.includes('--update')
const binDir = path.join(root, 'resources', 'bin')
const exe = process.platform === 'win32' ? '.exe' : ''
const platformKey = `${process.platform}-${process.arch}`
fs.mkdirSync(binDir, { recursive: true })

const sha256 = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

// ---- ffmpeg / ffprobe ----
const ffmpegSrc = require('ffmpeg-static')
const ffprobeSrc = require('ffprobe-static').path
lock.ffmpeg[platformKey] ??= {}
for (const [name, src] of [['ffmpeg', ffmpegSrc], ['ffprobe', ffprobeSrc]]) {
  const got = sha256(src)
  const want = lock.ffmpeg[platformKey][name]
  if (update || !want) lock.ffmpeg[platformKey][name] = got
  else if (got !== want) throw new Error(`${name}: hash não confere (${got} ≠ ${want})`)
  const dest = path.join(binDir, `${name}${exe}`)
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
  console.log(`${name} ok (${got.slice(0, 12)}…)`)
}

// ---- whisper-cli ----
const w = lock.whisper
const whisperBin = path.join(binDir, `whisper-cli${exe}`)
const stamp = path.join(binDir, 'whisper-cli.commit')
if (update || !fs.existsSync(whisperBin) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== w.commit) {
  const src = path.join(root, '.cache', 'whisper.cpp')
  if (!fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(src), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', w.tag, w.repo, src])
  }
  const head = run('git', ['rev-parse', 'HEAD^{commit}'], src).trim()
  if (head !== w.commit) throw new Error(`whisper.cpp: commit ${head} não é o esperado ${w.commit} (tag ${w.tag})`)
  const build = path.join(src, 'build')
  run('cmake', ['-B', build, '-S', src, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DGGML_NATIVE=OFF'])
  run('cmake', ['--build', build, '--config', 'Release', '-j', '4', '--target', 'whisper-cli'])
  const candidates = [path.join(build, 'bin', `whisper-cli${exe}`), path.join(build, 'bin', 'Release', `whisper-cli${exe}`)]
  const built = candidates.find((c) => fs.existsSync(c))
  if (!built) throw new Error('whisper-cli não foi gerado')
  fs.copyFileSync(built, whisperBin)
  fs.chmodSync(whisperBin, 0o755)
  fs.writeFileSync(stamp, `${w.commit}\n`)
}
execFileSync(whisperBin, ['--help'], { stdio: 'ignore' })
console.log(`whisper-cli ok (${w.tag})`)

// ---- yt-dlp (Cortes): binário oficial da release fixa, SHA-256 conferido ----
const y = lock.ytdlp
const asset = y.assets[platformKey]
if (!asset) {
  console.warn(`yt-dlp: sem binário registrado para ${platformKey} (Cortes por link indisponível nesta plataforma)`)
} else {
  const dest = path.join(binDir, `yt-dlp${exe}`)
  if (!fs.existsSync(dest) || sha256(dest) !== asset.sha256) {
    const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${y.version}/${asset.file}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`yt-dlp: HTTP ${res.status} em ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== asset.sha256) throw new Error(`yt-dlp: hash não confere (${got} ≠ ${asset.sha256})`)
    fs.writeFileSync(dest, buf)
    fs.chmodSync(dest, 0o755)
  }
  console.log(`yt-dlp ok (${y.version})`)
}

if (update) fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`binários prontos em ${binDir}`)
