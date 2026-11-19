import { spawn } from 'node:child_process'
import {
  secretsHelperResponseSchema,
  type SecretId,
  type SecretStore,
  type SecretsHelperRequest,
  type SecretsHelperResponse,
} from '../core/secrets'

export interface HelperLaunch {
  /** Executável do Electron/MUDO. */
  exec: string
  /** Argumentos antes da flag (em desenvolvimento: a pasta do app). */
  args: string[]
}

export interface SecretsAdmin extends SecretStore {
  set(id: SecretId, value: string): Promise<SecretId[]>
  remove(id: SecretId): Promise<SecretId[]>
  list(): Promise<SecretId[]>
}

/**
 * Acesso às chaves a partir da CLI (que roda sem Electron): abre o próprio app
 * em modo `--mudo-secrets-helper`, sem janela, e troca uma linha JSON por
 * pipe. A chave nunca passa por argumento de linha de comando.
 */
export function helperSecrets(launch: HelperLaunch): SecretsAdmin {
  const cache = new Map<SecretId, string | null>()

  const call = (req: SecretsHelperRequest): Promise<SecretsHelperResponse> =>
    new Promise((resolve, reject) => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const extra = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? ['--ozone-platform=headless'] : []
      const child = spawn(launch.exec, [...launch.args, '--mudo-secrets-helper', ...extra], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      let out = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('o MUDO não respondeu ao pedido de chave (tempo esgotado)'))
      }, 30_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c: string) => {
        out += c
      })
      child.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.once('close', () => {
        clearTimeout(timer)
        const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{'))
        if (!line) return reject(new Error('resposta vazia do MUDO ao pedido de chave'))
        let json: unknown
        try {
          json = JSON.parse(line)
        } catch {
          // não inclui o conteúdo: pode conter a chave
          return reject(new Error(`resposta incompleta do MUDO ao pedido de chave (${line.length} bytes)`))
        }
        const parsed = secretsHelperResponseSchema.safeParse(json)
        if (!parsed.success) return reject(new Error('resposta inválida do MUDO ao pedido de chave'))
        resolve(parsed.data)
      })
      child.stdin.end(`${JSON.stringify(req)}\n`)
    })

  const unwrap = (r: SecretsHelperResponse) => {
    if (!r.ok) throw new Error(r.error)
    return r
  }

  return {
    async get(id) {
      if (cache.has(id)) return cache.get(id) ?? null
      const r = unwrap(await call({ op: 'get', id }))
      const v = r.value ?? null
      cache.set(id, v)
      return v
    },
    async set(id, value) {
      cache.delete(id)
      return unwrap(await call({ op: 'set', id, value })).configured ?? []
    },
    async remove(id) {
      cache.delete(id)
      return unwrap(await call({ op: 'delete', id })).configured ?? []
    },
    async list() {
      return unwrap(await call({ op: 'list' })).configured ?? []
    },
  }
}
