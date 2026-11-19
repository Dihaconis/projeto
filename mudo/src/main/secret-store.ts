import { safeStorage } from 'electron'
import fs from 'node:fs'
import { configFileSchema, type ConfigFile, type SecretId, type SecretStore, SECRET_IDS } from '../core/secrets'
import { writeFileAtomic } from '../core/paths'

/**
 * Chaves em `%APPDATA%/MUDO/config.json`, cifradas com `safeStorage` (DPAPI no
 * Windows). Só o processo main lê este arquivo; o valor decifrado nunca é
 * logado nem enviado ao renderer.
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  private read(): ConfigFile {
    if (!fs.existsSync(this.file)) return { version: 1, secrets: {} }
    const parsed = configFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    if (!parsed.success) throw new Error('config.json corrompido')
    return parsed.data
  }

  private write(cfg: ConfigFile): void {
    writeFileAtomic(this.file, JSON.stringify(cfg, null, 2))
  }

  /**
   * No Windows (alvo do produto) é DPAPI e está sempre disponível. No Linux sem
   * chaveiro o Chromium cai no backend "basic_text" (chave fixa, só ofusca):
   * só é aceito com opt-in explícito `MUDO_ALLOW_BASIC_SECRET_STORE=1`
   * (desenvolvimento/CI), nunca em silêncio.
   */
  available(): boolean {
    if (safeStorage.isEncryptionAvailable()) return true
    if (process.platform === 'linux' && process.env.MUDO_ALLOW_BASIC_SECRET_STORE === '1' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      safeStorage.setUsePlainTextEncryption(true)
      return safeStorage.isEncryptionAvailable()
    }
    return false
  }

  backend(): string {
    return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'
  }

  async get(id: SecretId): Promise<string | null> {
    const enc = this.read().secrets[id]
    if (!enc || !this.available()) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }

  set(id: SecretId, value: string): void {
    if (!this.available()) throw new Error('A criptografia do sistema (safeStorage) não está disponível nesta máquina.')
    const cfg = this.read()
    cfg.secrets[id] = safeStorage.encryptString(value.trim()).toString('base64')
    this.write(cfg)
  }

  delete(id: SecretId): void {
    const cfg = this.read()
    delete cfg.secrets[id]
    this.write(cfg)
  }

  configured(): SecretId[] {
    const cfg = this.read()
    return SECRET_IDS.filter((id) => !!cfg.secrets[id])
  }
}
