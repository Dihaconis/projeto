import { AlertTriangle, Copy, FileText, FolderOpen, Loader2, RotateCcw, Trash2, Video } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { VideoView } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { mudo } from '@/lib/bridge'
import { AI_PUBLISH_NOTICE, formatDate, formatDuration, formatMoney } from '@/lib/utils'
import { QuotaMeter } from './SettingsScreen'

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; videos: VideoView[] }

export function LibraryScreen() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [selected, setSelected] = useState<VideoView | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const videos = await mudo.invoke('videos:list', { onlyDone: true })
      setLoad({ status: 'ok', videos })
      setSelected((s) => (s ? (videos.find((v) => v.id === s.id) ?? null) : null))
    } catch (e) {
      setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void refresh()
    return mudo.on('jobs:changed', () => void refresh())
  }, [refresh])

  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>, okText: string) => {
    try {
      const r = await fn()
      setNotice(r.ok ? { tone: 'ok', text: okText } : { tone: 'error', text: r.message ?? 'Não foi possível.' })
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    }
    setTimeout(() => setNotice(null), 2500)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-5 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-semibold">Biblioteca</h1>
            <p className="text-xs text-muted-foreground">Vídeos prontos para publicar.</p>
          </div>
          <QuotaMeter compact />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {load.status === 'loading' && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Carregando biblioteca…
            </div>
          )}
          {load.status === 'error' && (
            <Card className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium text-destructive">Não foi possível ler a biblioteca.</p>
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
          {load.status === 'ok' && load.videos.length === 0 && (
            <Card className="p-8 text-center">
              <Video className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="font-medium">Nenhum vídeo pronto ainda.</p>
              <p className="mt-1 text-xs text-muted-foreground">Os vídeos aparecem aqui quando a geração termina em Meus Vídeos.</p>
            </Card>
          )}
          {load.status === 'ok' && load.videos.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4" data-testid="library-grid">
              {load.videos.map((v) => (
                <button
                  key={v.id}
                  data-testid="library-card"
                  data-video-id={v.id}
                  onClick={() => setSelected(v)}
                  className={`overflow-hidden rounded-md border text-left transition-colors ${selected?.id === v.id ? 'border-accent' : 'border-border hover:border-muted-foreground'} bg-card`}
                >
                  <div className="aspect-video bg-muted">
                    {v.hasThumb ? <img alt="" className="size-full object-cover" src={`mudo-media://thumb/${v.id}`} /> : <div className="flex size-full items-center justify-center text-xs text-muted-foreground">sem thumbnail</div>}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 text-[13px] font-medium">{v.title ?? v.theme}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {v.durationS ? formatDuration(v.durationS * 1000) : '—'} · {formatDate(v.finishedAt ?? v.createdAt)} · {formatMoney(v.costCents)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <aside className="w-[420px] shrink-0 overflow-auto border-l border-border p-4" data-testid="library-detail">
            {selected.hasOutput ? (
              <video key={selected.id} data-testid="player" className="aspect-video w-full rounded-md bg-black" controls preload="metadata" src={`mudo-media://video/${selected.id}`} />
            ) : (
              <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">O arquivo do vídeo não está mais na pasta de saída.</p>
            )}
            <h2 className="mt-3 text-[14px] font-semibold">{selected.title ?? selected.theme}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {selected.channelName} · {selected.durationS ? formatDuration(selected.durationS * 1000) : '—'} · gerado em {selected.genTimeS ? formatDuration(selected.genTimeS * 1000) : '—'} · {formatMoney(selected.costCents)}
            </p>
            <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning" data-testid="library-ai-notice">
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> {AI_PUBLISH_NOTICE}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void run(() => mudo.invoke('videos:openFolder', { id: selected.id }), 'Pasta aberta.')}>
                <FolderOpen /> Abrir pasta
              </Button>
              <Button size="sm" variant="secondary" data-testid="copy-title" onClick={() => void run(() => mudo.invoke('videos:copy', { id: selected.id, field: 'title' }), 'Título copiado.')}>
                <Copy /> Copiar título
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void run(() => mudo.invoke('videos:copy', { id: selected.id, field: 'description' }), 'Descrição copiada.')}>
                <Copy /> Copiar descrição
              </Button>
              <Button size="sm" variant="destructive" data-testid="delete-video" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Apagar
              </Button>
            </div>
            {notice && <p className={`mt-2 text-xs ${notice.tone === 'ok' ? 'text-success' : 'text-destructive'}`}>{notice.text}</p>}
          </aside>
        )}
      </div>

      <Dialog
        open={confirmDelete && !!selected}
        onClose={() => setConfirmDelete(false)}
        title="Apagar vídeo?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-delete"
              onClick={() => {
                const id = selected!.id
                setConfirmDelete(false)
                setSelected(null)
                void run(() => mudo.invoke('videos:delete', { id }), 'Vídeo apagado.').then(() => refresh())
              }}
            >
              <Trash2 /> Apagar
            </Button>
          </>
        }
      >
        <p className="text-[13px]">O MP4, as thumbnails, o .txt e os arquivos de trabalho deste vídeo serão apagados. Isso não pode ser desfeito.</p>
      </Dialog>
    </div>
  )
}
