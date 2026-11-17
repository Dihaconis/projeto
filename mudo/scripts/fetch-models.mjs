// Baixa o modelo CLIP local (embeddings offline, seção 7) numa revisão fixa e
// confere o SHA-256 de cada arquivo contra scripts/models.lock.json.
// Uso: node scripts/fetch-models.mjs            (baixa e verifica)
//      node scripts/fetch-models.mjs --update   (regrava o lock — só ao trocar de revisão)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockFile = path.join(root, 'scripts', 'models.lock.json')
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
const update = process.argv.includes('--update')
const outRoot = path.join(root, 'resources', 'models')

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

for (const model of lock.models) {
  const dir = path.join(outRoot, model.id)
  for (const f of model.files) {
    const dest = path.join(dir, f.path)
    if (fs.existsSync(dest) && !update && sha256(dest) === f.sha256) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${f.path}`
    process.stdout.write(`baixando ${model.id}/${f.path} … `)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} em ${url}`)
    const tmp = `${dest}.part`
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
    const got = sha256(tmp)
    if (update) f.sha256 = got
    else if (got !== f.sha256) {
      fs.rmSync(tmp, { force: true })
      throw new Error(`hash não confere para ${f.path}: esperado ${f.sha256}, veio ${got}`)
    }
    fs.renameSync(tmp, dest)
    console.log('ok')
  }
}
if (update) fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`modelos prontos em ${outRoot}`)
