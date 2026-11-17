/**
 * Entrada da CLI `mudo`. Roda só com o core (sem Electron), pelo próprio
 * executável do MUDO em modo Node (`ELECTRON_RUN_AS_NODE=1`), então funciona
 * sem Node instalado. Chaves vêm do app via `--mudo-secrets-helper`.
 */
import path from 'node:path'
import { configuredProviders, createLogger, dataPaths, defaultDataRoot, resolveMediaBinaries } from '../core'
import { helperSecrets } from './helper-secrets'
import { EXIT, runCli } from './run'

async function main(): Promise<number> {
  // out/main/cli.js → raiz do app (pasta do projeto ou resources/app.asar)
  const appRoot = path.resolve(__dirname, '..', '..')
  const packaged = appRoot.endsWith('.asar')
  const resources = packaged ? path.dirname(appRoot) : null

  let electronExec = process.execPath
  if (!process.versions.electron) {
    // rodando com Node puro em desenvolvimento: usa o Electron do projeto
    electronExec = (await import('electron')).default as unknown as string
  }
  const secrets = helperSecrets({ exec: electronExec, args: packaged ? [] : [appRoot] })
  const dataRoot = defaultDataRoot()
  const log = await createLogger(dataPaths(dataRoot).logs, 'cli')

  return runCli(process.argv.slice(2), {
    dataRoot,
    migrationsDir: resources ? path.join(resources, 'migrations') : path.join(appRoot, 'migrations'),
    providers: (h) => configuredProviders(h, secrets),
    media: resolveMediaBinaries({ binDir: resources ? path.join(resources, 'bin') : undefined }),
    secrets,
    log,
    io: {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      readStdin: () =>
        new Promise((resolve) => {
          let buf = ''
          process.stdin.setEncoding('utf8')
          process.stdin.on('data', (c: string) => (buf += c))
          process.stdin.on('end', () => resolve(buf))
        }),
    },
  })
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`Erro: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = EXIT.error
  },
)
