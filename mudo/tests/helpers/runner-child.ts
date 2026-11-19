/**
 * Processo runner isolado para os testes de crash: abre o banco indicado e
 * consome a fila até ser morto. Argumentos: <dataRoot> <orphanAfterMs> [selftest|video].
 * No modo `video` roda o pipeline real com provedores de FIXTURE.
 */
import { Runner, dataPaths, jobHandlers, nullLogger, openDatabase, resolveMediaBinaries } from '../../src/core'
import { fixtureLlm, fixtureSource, fixtureTts, noProviders } from './fixtures'
import { testHandlers } from './selftest-handler'

const [root, orphanMs, mode = 'selftest'] = process.argv.slice(2)
if (!root) throw new Error('uso: runner-child <dataRoot> <orphanAfterMs> [selftest|video]')
const paths = dataPaths(root)
const handle = openDatabase(paths.db)
const video = mode === 'video'
const runner = new Runner({
  handle,
  paths,
  log: nullLogger(),
  handlers: video ? jobHandlers : testHandlers,
  providers: video ? fixtureSource([fixtureLlm()], [fixtureTts()]) : noProviders,
  media: resolveMediaBinaries(),
  orphanAfterMs: Number(orphanMs ?? 60000),
  heartbeatMs: 100,
  reaperIntervalMs: 200,
  pollMs: 50,
})
runner.start()
process.stdout.write(`ready ${runner.id}\n`)
