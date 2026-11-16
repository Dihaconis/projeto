/**
 * Processo runner isolado para o teste de crash: abre o banco indicado e
 * consome a fila até ser morto. Argumentos: <dataRoot> <orphanAfterMs>.
 */
import { Runner, dataPaths, jobHandlers, nullLogger, openDatabase } from '../../src/core'

const [root, orphanMs] = process.argv.slice(2)
if (!root) throw new Error('uso: runner-child <dataRoot> <orphanAfterMs>')
const paths = dataPaths(root)
const handle = openDatabase(paths.db)
const runner = new Runner({
  handle,
  paths,
  log: nullLogger(),
  handlers: jobHandlers,
  orphanAfterMs: Number(orphanMs ?? 60000),
  heartbeatMs: 100,
  reaperIntervalMs: 200,
  pollMs: 50,
})
runner.start()
process.stdout.write(`ready ${runner.id}\n`)
