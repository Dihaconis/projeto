import { FileText, Loader2, Pencil, Plus, RotateCcw, Trash2, Tv } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ChannelSummary } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { mudo } from '@/lib/bridge'
import { ChannelForm, MOOD_LABEL, draftFrom, toInput, type ChannelDraft } from './ChannelForm'

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; channels: ChannelSummary[] }

export function ChannelsScreen() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [editing, setEditing] = useState<{ id: string | null; draft: ChannelDraft } | null>(null)
  const [removing, setRemoving] = useState<ChannelSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoad({ status: 'ok', channels: await mudo.invoke('channels:list') })
    } catch (e) {
      setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])
  useEffect(() => void refresh(), [refresh])

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      await mudo.invoke('channels:save', { id: editing.id, channel: toInput(editing.draft) })
      setEditing(null)
      setNotice('Canal salvo.')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-[15px] font-semibold">Canais</h1>
          <p className="text-xs text-muted-foreground">Cada canal tem voz, estilo visual, trilha e tom próprios — vídeos de canais diferentes não saem iguais.</p>
        </div>
        <Button data-testid="new-channel" onClick={() => (setError(null), setEditing({ id: null, draft: draftFrom() }))}>
          <Plus /> Novo canal
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {notice && <p className="mb-3 text-xs text-success">{notice}</p>}
        {load.status === 'loading' && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Carregando canais…
          </div>
        )}
        {load.status === 'error' && (
          <Card className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium text-destructive">Não foi possível ler os canais.</p>
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
        {load.status === 'ok' && load.channels.length === 0 && (
          <Card className="p-8 text-center">
            <Tv className="mx-auto mb-2 size-6 text-muted-foreground" />
            <p className="font-medium">Nenhum canal ainda.</p>
            <p className="mt-1 text-xs text-muted-foreground">Crie o primeiro canal para começar a gerar vídeos.</p>
          </Card>
        )}
        {load.status === 'ok' && load.channels.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {load.channels.map((c) => (
              <Card key={c.id} className="p-4" data-testid="channel-card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.niche}</p>
                  </div>
                  <span className="size-4 rounded-full border border-border" style={{ background: c.stylePreset.highlightColor }} title="Cor de destaque" />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {c.language} · voz {c.ttsProvider ?? 'automática'}
                  {c.voiceId ? ` (${c.voiceId})` : ''} · trilha {MOOD_LABEL[c.musicMood ?? 'calm']} · {c.videoCount} vídeo(s)
                  {c.stylePreset.manualReview ? ' · revisão manual' : ''}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => (setError(null), setEditing({ id: c.id, draft: draftFrom(c) }))}>
                    <Pencil /> Editar
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setRemoving(c)}>
                    <Trash2 /> Remover
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Editar canal' : 'Novo canal'}
        wide
        footer={
          <>
            {error && <span className="mr-auto self-center text-xs text-destructive">{error}</span>}
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button data-testid="save-channel" disabled={saving || !editing?.draft.name.trim() || !editing?.draft.niche.trim()} onClick={() => void save()}>
              {saving && <Loader2 className="animate-spin" />} Salvar
            </Button>
          </>
        }
      >
        {editing && <ChannelForm value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />}
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remover canal?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const c = removing!
                setRemoving(null)
                void mudo.invoke('channels:remove', { id: c.id }).then((r) => {
                  setNotice(r.result === 'archived' ? 'Canal arquivado: os vídeos dele continuam na Biblioteca.' : 'Canal removido.')
                  void refresh()
                })
              }}
            >
              <Trash2 /> Remover
            </Button>
          </>
        }
      >
        <p className="text-[13px]">
          {removing && removing.videoCount > 0
            ? `"${removing.name}" tem ${removing.videoCount} vídeo(s): o canal será arquivado e os vídeos continuam na Biblioteca.`
            : `"${removing?.name}" será removido.`}
        </p>
      </Dialog>
    </div>
  )
}
