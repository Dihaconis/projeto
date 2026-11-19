import { AlertTriangle, CheckCircle2, FileText, Loader2, Pencil, Play, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DURATION, JOB_STATE_LABELS, LANGUAGES, STAGES, STAGE_LABELS, type JobState, type Language } from '../../../shared/enums'
import type { VideoView } from '../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label, Select, Textarea } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { mudo } from '@/lib/bridge'
import { AI_PUBLISH_NOTICE, cn, formatDuration, formatMoney } from '@/lib/utils'
import { ScriptEditor } from './ScriptEditor'

const STATE_TONE: Record<JobState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'info',
  needs_input: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}
const LANG_LABEL: Record<Language, string> = { 'pt-BR': 'Português (BR)', es: 'Español', en: 'English' }
const DURATIONS = Array.from({ length: (DURATION.maxS - DURATION.minS) / 30 + 1 }, (_, i) => DURATION.minS + i * 30)

type Channel = { id: string; name: string; niche: string; language: Language }
type Estimate = { totalCents: number; missing: string[] } | { error: string } | null

export function VideosScreen({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [videos, setVideos] = useState<VideoView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [theme, setTheme] = useState('')
  const [channelId, setChannelId] = useState('')
  const [language, setLanguage] = useState<Language | ''>('')
  const [durationS, setDurationS] = useState<number>(DURATION.defaultS)
  const [estimate, setEstimate] = useState<Estimate>(null)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const [c, v] = await Promise.all([mudo.invoke('channels:list'), mudo.invoke('videos:list', { onlyDone: false })])
      setChannels(c)
      setVideos(v)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    let pending = false
    const off = mudo.on('jobs:changed', () => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        void refresh()
      }, 150)
    })
    const t = setInterval(() => {
      setTick((n) => n + 1)
      void refresh()
    }, 2000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  // canal padrão e idioma padrão do canal
  useEffect(() => {
    if (!channels?.length) return
    if (!channels.some((c) => c.id === channelId)) setChannelId(channels[0]!.id)
  }, [channels, channelId])
  const channel = channels?.find((c) => c.id === channelId)
  const lang: Language | undefined = language || channel?.language

  // custo estimado ao vivo (seção 7: mostrado antes de enfileirar)
  const reqSeq = useRef(0)
  useEffect(() => {
    if (!channelId || theme.trim().length < 3) {
      setEstimate(null)
      return
    }
    const seq = ++reqSeq.current
    const t = setTimeout(() => {
      mudo
        .invoke('videos:estimate', { channelId, theme, language: lang, durationS })
        .then((e) => seq === reqSeq.current && setEstimate(e))
        .catch((err: unknown) => seq === reqSeq.current && setEstimate({ error: err instanceof Error ? err.message : String(err) }))
    }, 350)
    return () => clearTimeout(t)
  }, [channelId, theme, lang, durationS])

  const generate = async () => {
    setCreating(true)
    setFormError(null)
    try {
      await mudo.invoke('videos:create', { channelId, theme, language: lang, durationS })
      setTheme('')
      await refresh()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const act = async (key: string, fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(key)
    setActionError(null)
    try {
      const r = await fn()
      if (!r.ok) setActionError(r.message ?? 'Ação não permitida.')
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const visible = useMemo(() => {
    if (!videos) return []
    const active = videos.filter((v) => v.state !== 'done')
    const recentDone = videos.filter((v) => v.state === 'done').slice(0, 5)
    return [...active, ...recentDone].sort((a, b) => b.createdAt - a.createdAt)
  }, [videos])

  const canGenerate = !!channelId && theme.trim().length >= 3 && !creating

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-5 py-3">
        <h1 className="text-[15px] font-semibold">Meus Vídeos</h1>
        <p className="text-xs text-muted-foreground">Do tema ao vídeo narrado, editado, legendado e com thumbnail.</p>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        {loadError && (
          <Card className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium text-destructive">Não foi possível carregar seus vídeos.</p>
              <p className="text-xs text-muted-foreground">{loadError}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void mudo.invoke('app:openLogs')}>
                <FileText /> Abrir logs
              </Button>
              <Button onClick={() => void refresh()}>
                <RotateCcw /> Tentar de novo
              </Button>
            </div>
          </Card>
        )}

        <Card className="p-4">
          {channels === null && !loadError && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Carregando…
            </div>
          )}
          {channels?.length === 0 && (
            <div data-testid="no-channels">
              <p className="font-medium">Crie um canal para começar.</p>
              <p className="mt-1 text-xs text-muted-foreground">O canal define voz, estilo visual e tom. Na linha de comando: mudo channel create --name "…" --niche "…" --lang pt-BR</p>
            </div>
          )}
          {!!channels?.length && (
            <div className="grid grid-cols-[1fr_200px_190px_130px] items-end gap-3">
              <div className="row-span-1">
                <Label htmlFor="theme">Tema</Label>
                <Textarea id="theme" data-testid="theme" rows={2} placeholder="Ex.: Por que o céu é azul" value={theme} onChange={(e) => setTheme(e.target.value)} maxLength={500} />
              </div>
              <div>
                <Label htmlFor="channel">Canal</Label>
                <Select id="channel" data-testid="channel" value={channelId} onChange={(e) => (setChannelId(e.target.value), setLanguage(''))}>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="lang">Idioma</Label>
                <Select id="lang" value={lang ?? ''} onChange={(e) => setLanguage(e.target.value as Language)}>
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {LANG_LABEL[l]}
                      {l === channel?.language ? ' · canal' : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="duration">Duração</Label>
                <Select id="duration" value={durationS} onChange={(e) => setDurationS(Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {formatDuration(d * 1000)} min
                    </option>
                  ))}
                </Select>
              </div>
              <div className="col-span-4 flex items-center justify-between">
                <div className="text-xs" data-testid="estimate">
                  {estimate === null && <span className="text-muted-foreground">Custo estimado aparece ao preencher o tema.</span>}
                  {estimate && 'error' in estimate && <span className="text-destructive">{estimate.error}</span>}
                  {estimate && 'totalCents' in estimate && (
                    <>
                      <span className="text-muted-foreground">Custo estimado: </span>
                      <span className="font-mono">{formatMoney(estimate.totalCents)}</span>
                      {estimate.missing.length > 0 && (
                        <span className="ml-2 text-warning">
                          Sem provedor configurado para {estimate.missing.map((m) => (m === 'llm' ? 'roteiro' : 'narração')).join(' e ')} — adicione a chave em Configurações.
                        </span>
                      )}
                    </>
                  )}
                </div>
                <Button data-testid="generate" disabled={!canGenerate} onClick={() => void generate()}>
                  {creating ? <Loader2 className="animate-spin" /> : <Sparkles />} Gerar
                </Button>
              </div>
              {formError && <p className="col-span-4 text-xs text-destructive">{formError}</p>}
            </div>
          )}
        </Card>

        {actionError && (
          <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span>{actionError}</span>
            <Button size="icon" variant="ghost" aria-label="Fechar" onClick={() => setActionError(null)}>
              <X />
            </Button>
          </div>
        )}

        {videos && visible.length === 0 && (
          <Card className="p-8 text-center">
            <p className="font-medium">Nenhum vídeo ainda.</p>
            <p className="mt-1 text-xs text-muted-foreground">Escolha um tema e clique em Gerar. Se o app fechar no meio, a geração continua do último ponto salvo ao reabrir.</p>
          </Card>
        )}

        {visible.length > 0 && (
          <Card>
            <table className="w-full text-left" data-testid="videos-table">
              <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Vídeo</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium">Etapa</th>
                  <th className="w-[26%] px-3 py-2 font-medium">Progresso</th>
                  <th className="px-3 py-2 font-medium">Decorrido</th>
                  <th className="px-3 py-2 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((v) => (
                  <VideoRow key={v.id} v={v} busy={busy} onAct={act} onEdit={() => setEditing(v.id)} onOpenLibrary={onOpenLibrary} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <ScriptEditor videoId={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
    </div>
  )
}

function VideoRow({
  v,
  busy,
  onAct,
  onEdit,
  onOpenLibrary,
}: {
  v: VideoView
  busy: string | null
  onAct: (key: string, fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>
  onEdit: () => void
  onOpenLibrary: () => void
}) {
  const canCancel = ['queued', 'running', 'needs_input', 'failed'].includes(v.state)
  const canResume = ['failed', 'cancelled', 'needs_input'].includes(v.state)
  // só há roteiro para editar depois da etapa de roteiro
  const canEdit = v.state === 'needs_input' && ['review', 'images', 'tts'].includes(v.stage ?? '')
  const start = v.state === 'running' && v.startedAt ? v.startedAt : v.createdAt
  const elapsed = v.state === 'running' ? Date.now() - start : (v.finishedAt ?? Date.now()) - v.createdAt
  const stageIdx = v.stage ? STAGES.indexOf(v.stage) : -1
  const tone = v.state === 'done' ? 'success' : v.state === 'failed' ? 'danger' : v.state === 'running' ? 'info' : 'muted'
  return (
    <tr className="border-b border-border align-top last:border-0" data-testid="video-row" data-video-id={v.id} data-state={v.state} data-stage={v.stage ?? ''}>
      <td className="px-3 py-2.5">
        <div className="max-w-[300px] truncate font-medium" title={v.title ?? v.theme}>
          {v.title ?? v.theme}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {v.channelName} · {v.language} · {formatDuration(v.targetDurationS * 1000)} min · {formatMoney(v.costCents)}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={STATE_TONE[v.state]}>{JOB_STATE_LABELS[v.state]}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <div>{v.stage ? STAGE_LABELS[v.stage] : '—'}</div>
        <div className="mt-1 flex gap-0.5" aria-hidden>
          {STAGES.map((s, i) => (
            <span key={s} title={STAGE_LABELS[s]} className={cn('h-1 w-4 rounded-sm', v.state === 'done' || i < stageIdx ? 'bg-success' : i === stageIdx ? 'bg-accent' : 'bg-muted')} />
          ))}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Progress value={v.progress} tone={tone} />
          <span className="w-9 text-right font-mono text-[11px] text-muted-foreground">{Math.round(v.progress * 100)}%</span>
        </div>
        {v.error && v.state !== 'done' && (
          <p className={cn('mt-1 text-[11px]', v.state === 'needs_input' ? 'text-warning' : v.state === 'cancelled' ? 'text-muted-foreground' : 'text-destructive')}>{v.error.message}</p>
        )}
        {v.state === 'done' && (
          <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground" data-testid="ai-notice">
            <AlertTriangle className="mt-px size-3 shrink-0 text-warning" /> {AI_PUBLISH_NOTICE}
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{formatDuration(elapsed)}</td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap justify-end gap-1.5">
          {v.state === 'done' && (
            <Button size="sm" variant="secondary" onClick={onOpenLibrary}>
              <CheckCircle2 /> Ver na Biblioteca
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={onEdit} data-testid="edit-script">
              <Pencil /> Editar roteiro
            </Button>
          )}
          {canResume && (
            <Button size="sm" variant="secondary" disabled={busy === `resume:${v.id}`} onClick={() => onAct(`resume:${v.id}`, () => mudo.invoke('videos:resume', { id: v.id }))}>
              <Play /> Retomar
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="destructive" disabled={busy === `cancel:${v.id}`} onClick={() => onAct(`cancel:${v.id}`, () => mudo.invoke('videos:cancel', { id: v.id }))}>
              <X /> Cancelar
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
