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
    app.exit(0)
  }
  const line = await new Promise<string>((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c: string) => {
      buf += c
      const i = buf.indexOf('\n')
      if (i >= 0) resolve(buf.slice(0, i))
    })
    process.stdin.on('end', () => resolve(buf))
  })
  await app.whenReady()
  try {
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
