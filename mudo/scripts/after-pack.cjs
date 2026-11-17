// afterPack do electron-builder: deixa no pacote só os binários nativos da
// plataforma/arquitetura-alvo (o onnxruntime-node traz todas, ~550 MB).
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName // 'win32' | 'linux' | 'darwin'
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch] ?? 'x64'
  const resources = platform === 'darwin' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources')
  const nm = path.join(resources, 'app.asar.unpacked', 'node_modules')
  let removed = 0
  const rm = (p) => {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true })
      removed++
    }
  }
  const ort = path.join(nm, 'onnxruntime-node', 'bin')
  if (fs.existsSync(ort)) {
    for (const napi of fs.readdirSync(ort)) {
      for (const plat of fs.readdirSync(path.join(ort, napi))) {
        if (plat !== platform) rm(path.join(ort, napi, plat))
        else for (const a of fs.readdirSync(path.join(ort, napi, plat))) if (a !== arch) rm(path.join(ort, napi, plat, a))
      }
    }
  }
  const pre = path.join(nm, 'better-sqlite3', 'prebuilds')
  if (fs.existsSync(pre)) for (const f of fs.readdirSync(pre)) if (f !== `${platform}-${arch}.node`) rm(path.join(pre, f))
  console.log(`  • after-pack: ${removed} binário(s) de outras plataformas removido(s) (${platform}-${arch})`)
}
