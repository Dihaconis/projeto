import { ArrowDown, ArrowUp, CheckCircle2, FolderOpen, KeyRound, Loader2, PlugZap, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { SECRET_IDS, SECRET_LABELS, type SecretId } from '../../../core/secrets'
import type { QuotaView, SettingsView } from '../../../shared/ipc'
import { PLANS } from '../../../shared/plans'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label, Select } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { mudo } from '@/lib/bridge'
import { cn } from '@/lib/utils'

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  elevenlabs: 'ElevenLabs',
  azure: 'Azure AI Speech',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
}

function Section({ title, children, hint }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {hint && <p className="mb-3 text-xs text-muted-foreground">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </Card>
  )
}

/** Medidor de cota (seção 12): sempre a partir de `plans.ts` e da tabela `usage`. */
export function QuotaMeter({ compact }: { compact?: boolean }) {
  const [q, setQ] = useState<QuotaView | null>(null)
  useEffect(() => {
    const load = () => void mudo.invoke('quota:status').then(setQ).catch(() => undefined)
    load()
    return mudo.on('jobs:changed', load)
  }, [])
  if (!q) return null
  const used = q.videosUsed + q.videosPending
  return (
    <div className={cn('flex items-center gap-3 text-xs', compact ? '' : 'rounded-md border border-border p-3')} data-testid="quota-meter">
      <span className="text-muted-foreground">Plano {q.planName}</span>
      {q.videosLimit === null ? (
        <span>
          {q.videosUsed} vídeo(s) em {q.month} · sem limite
        </span>
      ) : (
        <>
          <Progress className="w-40" value={used / q.videosLimit} tone={q.videosRemaining === 0 ? 'danger' : 'info'} />
          <span>
            {q.videosUsed}/{q.videosLimit} vídeos{q.videosPending ? ` (+${q.videosPending} em produção)` : ''} · restam {q.videosRemaining}
          </span>
        </>
      )}
    </div>
  )
}

function OrderList<T extends string>({ value, onChange }: { value: T[]; onChange: (v: T[]) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const n = [...value]
    const [x] = n.splice(i, 1)
    n.splice(i + d, 0, x!)
    onChange(n)
  }
  return (
    <ol className="space-y-1">
      {value.map((p, i) => (
        <li key={p} className="flex items-center gap-2 text-[13px]">
          <span className="w-4 font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
          <span className="flex-1">{PROVIDER_LABEL[p] ?? p}</span>
          <Button size="icon" variant="ghost" aria-label={`Subir ${p}`} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp />
          </Button>
          <Button size="icon" variant="ghost" aria-label={`Descer ${p}`} disabled={i === value.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown />
          </Button>
        </li>
      ))}
    </ol>
  )
}

export function KeysEditor({ configured, onChanged, only }: { configured: SecretId[]; onChanged: () => void; only?: SecretId[] }) {
  const [values, setValues] = useState<Partial<Record<SecretId, string>>>({})
  const [status, setStatus] = useState<Partial<Record<SecretId, { ok: boolean; text: string }>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, id: SecretId, fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(key)
    try {
      const r = await fn()
      setStatus((s) => ({ ...s, [id]: { ok: r.ok, text: r.message ?? (r.ok ? 'ok' : 'falhou') } }))
      onChanged()
    } catch (e) {
      setStatus((s) => ({ ...s, [id]: { ok: false, text: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-2">
      {(only ?? [...SECRET_IDS]).map((id) => {
        const has = configured.includes(id)
        return (
          <div key={id} className="grid grid-cols-[170px_1fr_auto] items-center gap-2" data-testid={`key-${id}`}>
            <span className="flex items-center gap-1.5 text-[13px]">
              {has ? <CheckCircle2 className="size-3.5 text-success" /> : <KeyRound className="size-3.5 text-muted-foreground" />} {SECRET_LABELS[id]}
            </span>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`Chave ${SECRET_LABELS[id]}`}
              placeholder={has ? '•••••••• (guardada — digite para trocar)' : 'cole a chave aqui'}
              value={values[id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [id]: e.target.value }))}
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                disabled={!values[id]?.trim() || busy !== null}
                onClick={() =>
                  void run(`save:${id}`, id, async () => {
                    const r = await mudo.invoke('keys:set', { id, value: values[id]!.trim() })
                    setValues((v) => ({ ...v, [id]: '' })) // a chave não fica na interface
                    return r
                  })
                }
              >
                <Save /> Salvar
              </Button>
              <Button size="sm" variant="secondary" disabled={!has || busy !== null} onClick={() => void run(`test:${id}`, id, () => mudo.invoke('keys:test', { id }))}>
                {busy === `test:${id}` ? <Loader2 className="animate-spin" /> : <PlugZap />} Testar conexão
              </Button>
              <Button size="icon" variant="ghost" aria-label={`Remover chave ${id}`} disabled={!has || busy !== null} onClick={() => void run(`del:${id}`, id, () => mudo.invoke('keys:delete', { id }))}>
                <Trash2 />
              </Button>
            </div>
            {status[id] && <p className={cn('col-span-3 -mt-1 text-[11px]', status[id]!.ok ? 'text-success' : 'text-destructive')}>{status[id]!.text}</p>}
          </div>
        )
      })}
    </div>
  )
}

export function SettingsScreen() {
  const [s, setS] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<SettingsView | null>(null)
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const [legal, setLegal] = useState<{ title: string; text: string } | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const v = await mudo.invoke('settings:get')
    setS(v)
    setDraft((d) => (d ? { ...v, ...pick(d, v) } : v))
  }, [])
  useEffect(() => {
    void refresh()
    void mudo.invoke('app:info').then(setInfo)
  }, [refresh])
  if (!s || !draft) {
    return (
      <div className="flex items-center gap-2 p-5 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando configurações…
      </div>
    )
  }
  const set = <K extends keyof SettingsView>(k: K, v: SettingsView[K]) => setDraft({ ...draft, [k]: v })
  const dirty = JSON.stringify({ ...draft, configuredKeys: [] }) !== JSON.stringify({ ...s, configuredKeys: [] })
  const save = async () => {
    try {
      const { configuredKeys: _k, ...patch } = draft
      void _k
      const v = await mudo.invoke('settings:save', patch)
      setS(v)
      setDraft(v)
      setNotice({ ok: true, text: 'Configurações salvas.' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  const choose = async (purpose: 'output' | 'library') => {
    const r = await mudo.invoke('settings:chooseFolder', { purpose })
    if (r.path) set(purpose === 'output' ? 'outputDir' : 'libraryDir', r.path)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-[15px] font-semibold">Configurações</h1>
          {notice && <p className={cn('text-xs', notice.ok ? 'text-success' : 'text-destructive')}>{notice.text}</p>}
        </div>
        <Button data-testid="save-settings" disabled={!dirty} onClick={() => void save()}>
          <Save /> Salvar alterações
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        <Section title="Chaves de API" hint="Guardadas cifradas pelo cofre do sistema (DPAPI no Windows). Nunca aparecem de volta nesta tela, em logs ou no banco.">
          <KeysEditor configured={s.configuredKeys} onChanged={() => void refresh()} />
        </Section>

        <Section title="Ordem dos provedores" hint="Em erro técnico (fora do ar, limite, cota da API) o MUDO tenta o próximo. Recusa por política nunca troca de provedor sozinha.">
          <div className="grid grid-cols-3 gap-6">
            <div>
              <Label>Roteiro e revisão</Label>
              <OrderList value={draft.llmOrder} onChange={(v) => set('llmOrder', v)} />
            </div>
            <div>
              <Label>Narração</Label>
              <OrderList value={draft.ttsOrder} onChange={(v) => set('ttsOrder', v)} />
            </div>
            <div>
              <Label>Bancos de imagem</Label>
              <OrderList value={draft.imagesOrder} onChange={(v) => set('imagesOrder', v)} />
              <label className="mt-2 flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={draft.imageGeneration} onChange={(e) => set('imageGeneration', e.target.checked)} /> Gerar imagem por IA como último recurso (OpenAI)
              </label>
            </div>
          </div>
        </Section>

        <Section title="Modelos">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="m-claude">Claude</Label>
              <Input id="m-claude" value={draft.anthropicModel} onChange={(e) => set('anthropicModel', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-effort">Esforço do Claude</Label>
              <Select id="m-effort" value={draft.anthropicEffort} onChange={(e) => set('anthropicEffort', e.target.value as SettingsView['anthropicEffort'])}>
                {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="m-gemini">Gemini</Label>
              <Input id="m-gemini" value={draft.geminiModel} onChange={(e) => set('geminiModel', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-oai">OpenAI (texto)</Label>
              <Input id="m-oai" value={draft.openaiLlmModel} onChange={(e) => set('openaiLlmModel', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-oaitts">OpenAI (voz)</Label>
              <Input id="m-oaitts" value={draft.openaiTtsModel} onChange={(e) => set('openaiTtsModel', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-11">ElevenLabs</Label>
              <Input id="m-11" value={draft.elevenlabsModel} onChange={(e) => set('elevenlabsModel', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-az">Região do Azure</Label>
              <Input id="m-az" value={draft.azureRegion} placeholder="ex.: brazilsouth" onChange={(e) => set('azureRegion', e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))} />
            </div>
            <div>
              <Label htmlFor="m-emb">Embeddings de imagem</Label>
              <Select id="m-emb" value={draft.embeddings} onChange={(e) => set('embeddings', e.target.value as 'clip' | 'openai')}>
                <option value="clip">CLIP local (offline)</option>
                <option value="openai">OpenAI (só texto)</option>
              </Select>
            </div>
          </div>
        </Section>

        <Section title="Pastas e execução">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div>
              <Label>Pasta de saída</Label>
              <Input readOnly value={draft.outputDir} />
            </div>
            <Button variant="secondary" onClick={() => void choose('output')}>
              <FolderOpen /> Escolher
            </Button>
            <div>
              <Label>Pasta do acervo de imagens</Label>
              <Input readOnly value={draft.libraryDir} placeholder="nenhuma — importe em Licenças depois de escolher" />
            </div>
            <Button variant="secondary" onClick={() => void choose('library')}>
              <FolderOpen /> Escolher
            </Button>
            <div>
              <Label htmlFor="conc">Vídeos gerados ao mesmo tempo</Label>
              <Select id="conc" className="w-32" value={draft.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">A montagem roda sempre uma de cada vez, para não saturar o processador.</p>
            </div>
          </div>
        </Section>

        <Section title="Plano e cota">
          <div className="flex flex-wrap items-center gap-4">
            <Select className="w-64" value={draft.planId} onChange={(e) => set('planId', e.target.value as SettingsView['planId'])} aria-label="Plano">
              {PLANS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.videosPerMonth !== null ? ` — ${p.videosPerMonth} vídeos + ${p.cutsPerMonth} cortes/mês` : ''}
                  {p.priceCents !== null ? ` — R$ ${(p.priceCents / 100).toFixed(2).replace('.', ',')}` : ''}
                </option>
              ))}
            </Select>
            <QuotaMeter compact />
          </div>
        </Section>

        <Section title="Sobre">
          <p className="text-[13px]">MUDO v{info?.version}</p>
          <p className="mb-3 text-[11px] text-muted-foreground">Dados em {info?.dataDir}</p>
          <div className="flex gap-2">
            {(['terms', 'privacy', 'third-party'] as const).map((doc) => (
              <Button key={doc} size="sm" variant="secondary" onClick={() => void mudo.invoke('app:legal', { doc }).then(setLegal)}>
                {doc === 'terms' ? 'Termos' : doc === 'privacy' ? 'Privacidade' : 'Licenças de terceiros'}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onClick={() => void mudo.invoke('app:openLogs')}>
              Abrir logs
            </Button>
          </div>
        </Section>
        <p className="text-[11px] text-muted-foreground">
          Divulgação de IA: sempre ativa. <Badge tone="neutral">não pode ser desligada</Badge>
        </p>
      </div>
      <Dialog open={!!legal} onClose={() => setLegal(null)} title={legal?.title ?? ''} wide>
        <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed">{legal?.text}</pre>
      </Dialog>
    </div>
  )
}

/** Mantém o que o usuário já alterou e ainda não salvou quando a tela recarrega. */
function pick(d: SettingsView, fresh: SettingsView): Partial<SettingsView> {
  const out: Partial<SettingsView> = {}
  for (const k of Object.keys(d) as Array<keyof SettingsView>) if (k !== 'configuredKeys' && JSON.stringify(d[k]) !== JSON.stringify(fresh[k])) (out as Record<string, unknown>)[k] = d[k]
  return out
}
