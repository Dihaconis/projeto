import { AlertTriangle, FileText, Loader2, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { JOB_STATE_LABELS, STAGES, STAGE_LABELS, type JobState } from '../../../shared/enums'
import type { JobView, RunnerStatus } from '../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { mudo } from '@/lib/bridge'
import { cn, formatDuration } from '@/lib/utils'

const STATE_TONE: Record<JobState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'info',
  needs_input: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; jobs: JobView[] }

export function QueueScreen({ runner }: { runner: RunnerStatus | null }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const jobs = await mudo.invoke('jobs:list')
      setLoad({ status: 'ok', jobs })
    } catch (e) {
      setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) })
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
      }, 100)
    })
    // relógio do tempo decorrido + captura jobs criados por outro processo (CLI)
    const t = setInterval(() => {
      setTick((n) => n + 1)
      void refresh()
    }, 2000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-[15px] font-semibold">Fila de jobs</h1>
          <p className="text-xs text-muted-foreground">
            Vídeos em produção e concluídos. Para gerar, use a CLI: <code className="font-mono">mudo generate --theme "…" --channel &lt;id&gt;</code>
          </p>
        </div>
      </header>

      {runner && runner.state !== 'running' && (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5" />
          {runner.message ?? (runner.state === 'starting' ? 'Iniciando o processo de geração…' : 'Processo de geração parado.')}
        </div>
      )}
      {actionError && (
        <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          <span>{actionError}</span>
          <Button size="icon" variant="ghost" aria-label="Fechar" onClick={() => setActionError(null)}>
            <X />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {load.status === 'loading' && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Carregando fila…
          </div>
        )}
        {load.status === 'error' && (
          <Card className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium text-destructive">Não foi possível ler a fila.</p>
              <p className="text-xs text-muted-foreground">{load.message}</p>
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
        {load.status === 'ok' && load.jobs.length === 0 && (
          <Card className="p-8 text-center">
            <p className="font-medium">Nenhum vídeo na fila.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Crie um canal e gere um vídeo pela CLI. Se o app fechar no meio, ao reabrir a geração continua do último checkpoint.
            </p>
          </Card>
        )}
        {load.status === 'ok' && load.jobs.length > 0 && (
          <Card>
            <table className="w-full text-left" data-testid="jobs-table">
              <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Vídeo</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium">Etapa</th>
                  <th className="w-[28%] px-3 py-2 font-medium">Progresso</th>
                  <th className="px-3 py-2 font-medium">Tentativa</th>
                  <th className="px-3 py-2 font-medium">Decorrido</th>
                  <th className="px-3 py-2 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {load.jobs.map((j) => (
                  <JobRowView key={j.id} job={j} busy={busy} onAct={act} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  )
}

function JobRowView({
  job: j,
  busy,
  onAct,
}: {
  job: JobView
  busy: string | null
  onAct: (key: string, fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>
}) {
  const canCancel = j.state === 'queued' || j.state === 'running' || j.state === 'needs_input' || j.state === 'failed'
  const canResume = j.state === 'failed' || j.state === 'cancelled' || j.state === 'needs_input'
  const elapsed = (j.finishedAt ?? Date.now()) - j.createdAt
  const stageIdx = j.stage ? STAGES.indexOf(j.stage) : -1
  const tone = j.state === 'done' ? 'success' : j.state === 'failed' ? 'danger' : j.state === 'running' ? 'info' : 'muted'

  return (
    <tr className="border-b border-border last:border-0 align-top" data-testid="job-row" data-job-id={j.id} data-state={j.state} data-stage={j.stage ?? ''}>
      <td className="px-3 py-2.5">
        <div className="max-w-[260px] truncate" title={j.title ?? j.theme ?? ''}>{j.title ?? j.theme ?? 'Vídeo'}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{j.id.slice(0, 8)}</div>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={STATE_TONE[j.state]}>{JOB_STATE_LABELS[j.state]}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <div>{j.stage ? STAGE_LABELS[j.stage] : '—'}</div>
        <div className="mt-1 flex gap-0.5" aria-hidden>
          {STAGES.map((s, i) => (
            <span
              key={s}
              title={STAGE_LABELS[s]}
              className={cn('h-1 w-4 rounded-sm', j.state === 'done' || i < stageIdx ? 'bg-success' : i === stageIdx ? 'bg-accent' : 'bg-muted')}
            />
          ))}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Progress value={j.progress} tone={tone} />
          <span className="w-9 text-right font-mono text-[11px] text-muted-foreground">{Math.round(j.progress * 100)}%</span>
        </div>
        {j.lastError && <p className={cn('mt-1 text-[11px]', j.state === 'needs_input' ? 'text-warning' : j.state === 'cancelled' ? 'text-muted-foreground' : 'text-destructive')}>{j.lastError.message}</p>}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
        {j.attempt}/{j.maxAttempts}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{formatDuration(elapsed)}</td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-1.5">
          {canResume && (
            <Button size="sm" variant="secondary" disabled={busy === `resume:${j.id}`} onClick={() => onAct(`resume:${j.id}`, () => mudo.invoke('jobs:resume', { id: j.id }))}>
              <RotateCcw /> Retomar
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="destructive" disabled={busy === `cancel:${j.id}`} onClick={() => onAct(`cancel:${j.id}`, () => mudo.invoke('jobs:cancel', { id: j.id }))}>
              <X /> Cancelar
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
