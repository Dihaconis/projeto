import { app } from 'electron'
import fs from 'node:fs'
import { secretsHelperRequestSchema, type SecretsHelperResponse } from '../core/secrets'
import type { SafeStorageSecretStore } from './secret-store'

/**
 * Modo auxiliar `--mudo-secrets-helper`: a CLI roda sem Electron (só o core),
 * mas as chaves vivem no safeStorage, que só existe no processo main. A CLI
 * inicia o app neste modo — sem janela — e troca UMA linha JSON pelo
 * stdin/stdout (pipe, nunca argumento de linha de comando).
 */
export async function runSecretsHelper(store: SafeStorageSecretStore): Promise<void> {
  const respond = (r: SecretsHelperResponse) => {
    // escrita síncrona e completa no fd 1: no Windows a escrita assíncrona no pipe
    // podia ser cortada pelo app.exit e a CLI recebia a linha pela metade
    const buf = Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')
    let off = 0
    while (off < buf.length) {
      try {
        off += fs.writeSync(1, buf, off, buf.length - off)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') break
      }
    }
    // saída normal (não app.exit): no Windows a chave do safeStorage fica no
    // "Local State" do Chromium, que só é gravado no encerramento normal —
    // com app.exit o próximo processo não conseguia decifrar o que foi salvo
    if (app.isReady()) app.quit()
    else app.exit(0)
  }
  try {
    const line = readRequestLine()
    await app.whenReady()
    const req = secretsHelperRequestSchema.parse(JSON.parse(line))
    switch (req.op) {
      case 'get':
        respond({ ok: true, value: await store.get(req.id) })
        break
      case 'set':
        store.set(req.id, req.value)
        respond({ ok: true, configured: store.configured() })
        break
      case 'delete':
        store.delete(req.id)
        respond({ ok: true, configured: store.configured() })
        break
      case 'list':
        respond({ ok: true, configured: store.configured() })
        break
    }
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : 'pedido inválido' })
  }
}

/**
 * Lê a linha do pedido direto do fd 0. No Windows o `process.stdin` do processo
 * main do Electron não entrega dados de pipe (chega vazio), então a leitura é
 * síncrona e explícita, em todas as plataformas.
 */
function readRequestLine(): string {
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(64 * 1024)
  const deadline = Date.now() + 10_000
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    let n: number
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EOF') break
      if (code === 'EAGAIN' && Date.now() < deadline) {
        Atomics.wait(wait, 0, 0, 20)
        continue
      }
      throw e
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    if (buf.subarray(0, n).includes(0x0a)) break
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const i = text.indexOf('\n')
  return i >= 0 ? text.slice(0, i) : text
}
