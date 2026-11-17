import { FileVideo, FolderOpen, Link2, Loader2, RotateCcw, Scissors, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { JOB_STATE_LABELS, STAGE_LABELS, type AnyStage } from '../../../shared/enums'
import type { CutDetailDto, CutViewDto } from '../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { mudo } from '@/lib/bridge'
import { cn, formatDuration } from '@/lib/utils'

const scoreTone = (s: number) => (s >= 75 ? 'success' : s >= 50 ? 'info' : 'neutral')

export function CutsScreen() {
  const [list, setList] = useState<CutViewDto[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CutDetailDto | null>(null)
  const [source, setSource] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const l = await mudo.invoke('cuts:list')
      setList(l)
      if (selected) setDetail(await mudo.invoke('cuts:detail', { id: selected }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [selected])
  useEffect(() => {
    void refresh()
    const off = mudo.on('jobs:changed', () => void refresh())
    const t = setInterval(() => void refresh(), 2000)
    return () => (off(), clearInterval(t))
  }, [refresh])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await mudo.invoke('cuts:create', { source: source.trim(), authorized })
      setSource('')
      setAuthorized(false)
      setSelected(r.cutId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-5 py-3">
        <h1 className="flex items-center gap-2 text-[15px] font-semibold">
          Cortes <Badge tone="warning">Beta</Badge>
        </h1>
        <p className="text-xs text-muted-foreground">Encontre os melhores trechos de um vídeo seu e exporte em 9:16 com legenda.</p>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-border">
          <div className="space-y-2 border-b border-border p-3">
            <Label htmlFor="cut-src">Link ou arquivo</Label>
            <div className="flex gap-1">
              <Input id="cut-src" data-testid="cut-source" placeholder="https://… ou escolha um arquivo" value={source} onChange={(e) => setSource(e.target.value)} />
              <Button size="icon" variant="secondary" aria-label="Escolher arquivo" onClick={() => void mudo.invoke('cuts:chooseFile').then((r) => r.path && setSource(r.path))}>
                <FolderOpen />
              </Button>
            </div>
            <label className="flex items-start gap-2 text-[12px]">
              <input type="checkbox" data-testid="cut-authorized" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5" />
              <span>Este vídeo é meu ou tenho autorização para usá-lo.</span>
            </label>
            <Button className="w-full" data-testid="cut-create" disabled={!authorized || !source.trim() || busy} onClick={() => void create()}>
              {busy ? <Loader2 className="animate-spin" /> : <Scissors />} Analisar
            </Button>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {list === null && <Loader2 className="m-2 size-4 animate-spin text-muted-foreground" />}
            {list?.length === 0 && <p className="p-2 text-xs text-muted-foreground">Nenhum vídeo analisado ainda.</p>}
            {list?.map((c) => (
              <button
                key={c.id}
                data-testid="cut-item"
                data-state={c.state}
                onClick={() => setSelected(c.id)}
                className={cn('mb-1 w-full rounded-md p-2 text-left', selected === c.id ? 'bg-muted' : 'hover:bg-muted/60')}
              >
                <div className="flex items-center gap-1.5 text-[13px]">
                  {c.sourceType === 'url' ? <Link2 className="size-3.5 shrink-0" /> : <FileVideo className="size-3.5 shrink-0" />}
                  <span className="truncate">{c.title ?? c.source}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Progress value={c.progress} tone={c.state === 'failed' ? 'danger' : c.state === 'done' ? 'success' : 'info'} />
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                    {c.state === 'running' && c.stage ? STAGE_LABELS[c.stage as AnyStage] : JOB_STATE_LABELS[c.state]}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </aside>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {!selected && (
            <Card className="p-8 text-center">
              <Scissors className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="font-medium">Escolha um vídeo para ver os trechos sugeridos.</p>
              <p className="mt-1 text-xs text-muted-foreground">Cada trecho vem com nota de 0 a 100 e a justificativa.</p>
            </Card>
          )}
          {selected && !detail && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {detail && <CutDetailView d={detail} onChanged={() => void refresh()} onDeleted={() => (setSelected(null), setDetail(null), void refresh())} />}
        </div>
      </div>
    </div>
  )
}

function CutDetailView({ d, onChanged, onDeleted }: { d: CutDetailDto; onChanged: () => void; onDeleted: () => void }) {
  const [msg, setMsg] = useState<string | null>(null)
  const hlOf = useMemo(() => {
    const m = new Map<number, number>()
    d.transcript.forEach((w, i) => {
      const k = d.highlights.findIndex((h) => w.startMs >= h.startMs && w.endMs <= h.endMs + 50)
      if (k >= 0) m.set(i, k)
    })
    return m
  }, [d])
  const act = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setMsg(null)
    try {
      const r = await fn()
      if (!r.ok) setMsg(r.message ?? 'Não foi possível.')
      onChanged()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }
  const c = d.cut
  return (
    <div className="space-y-4" data-testid="cut-detail">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">{c.title ?? c.source}</h2>
          <p className="text-xs text-muted-foreground">
            {c.durationS ? formatDuration(c.durationS * 1000) : '—'} · {JOB_STATE_LABELS[c.state]}
          </p>
          {c.error && <p className="mt-1 text-xs text-destructive">{c.error.message}</p>}
        </div>
        <div className="flex gap-2">
          {['failed', 'cancelled', 'needs_input'].includes(c.state) && (
            <Button size="sm" variant="secondary" onClick={() => void act(() => mudo.invoke('cuts:retry', { id: c.id }))}>
              <RotateCcw /> Tentar de novo
            </Button>
          )}
          <Button size="sm" variant="destructive" onClick={() => void mudo.invoke('cuts:delete', { id: c.id }).then(onDeleted, (e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))}>
            <Trash2 /> Apagar
          </Button>
        </div>
      </div>
      {msg && <p className="text-xs text-destructive">{msg}</p>}

      {d.highlights.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {d.highlights.map((h, k) => (
            <Card key={h.id} className="p-3" data-testid="highlight">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {k + 1}. {h.title}
                </span>
                <Badge tone={scoreTone(h.score)}>{h.score}/100</Badge>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {formatDuration(h.startMs)}–{formatDuration(h.endMs)} · {Math.round((h.endMs - h.startMs) / 1000)} s
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground">{h.reason}</p>
              <div className="mt-2 flex gap-2">
                {h.exportedPath ? (
                  <Button size="sm" variant="secondary" onClick={() => void act(() => mudo.invoke('cuts:showFile', { highlightId: h.id }))}>
                    <FolderOpen /> Ver arquivo 9:16
                  </Button>
                ) : h.exportState === 'queued' || h.exportState === 'running' ? (
                  <Button size="sm" disabled>
                    <Loader2 className="animate-spin" /> Exportando…
                  </Button>
                ) : (
                  <Button size="sm" data-testid="export-cut" onClick={() => void act(() => mudo.invoke('cuts:export', { highlightId: h.id }))}>
                    <Scissors /> Exportar 9:16
                  </Button>
                )}
              </div>
              {h.exportError && !h.exportedPath && <p className="mt-1 text-[11px] text-destructive">{h.exportError}</p>}
            </Card>
          ))}
        </div>
      )}

      {d.transcript.length > 0 && (
        <Card className="p-4">
          <Label>Transcrição (trechos sugeridos destacados)</Label>
          <p className="text-[13px] leading-relaxed" data-testid="transcript">
            {d.transcript.map((w, i) => (
              <span key={i} className={cn(hlOf.has(i) && 'rounded-sm bg-accent/25 text-foreground')}>
                {w.word}{' '}
              </span>
            ))}
          </p>
        </Card>
      )}
    </div>
  )
}
