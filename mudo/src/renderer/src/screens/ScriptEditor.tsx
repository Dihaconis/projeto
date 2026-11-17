import { AlertTriangle, Loader2, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ScriptForEdit } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label, Textarea } from '@/components/ui/input'
import { mudo } from '@/lib/bridge'

const KIND_LABEL: Record<string, string> = {
  coherence: 'Coerência',
  hook: 'Gancho',
  pacing: 'Ritmo',
  act_length: 'Tamanho do ato',
  repetition: 'Repetição',
  factual: 'Afirmação duvidosa',
}

const words = (t: string) => t.trim().split(/\s+/u).filter(Boolean).length

/**
 * Roteiro editável com os pontos da revisão ao lado (seção 8.2). Salvar
 * invalida cenas e narração e retoma a geração.
 */
export function ScriptEditor({ videoId, onClose, onSaved }: { videoId: string | null; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<ScriptForEdit | null>(null)
  const [acts, setActs] = useState<ScriptForEdit['acts']>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!videoId) return
    setData(null)
    setError(null)
    mudo
      .invoke('videos:getScript', { id: videoId })
      .then((d) => {
        setData(d)
        setActs(d.acts)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [videoId])

  const total = useMemo(() => acts.reduce((s, a) => s + words(a.text), 0), [acts])
  const min = data ? Math.floor(data.targetWords * 0.9) : 0
  const max = data ? Math.ceil(data.targetWords * 1.1) : 0
  const inRange = total >= min && total <= max

  const save = async () => {
    if (!videoId) return
    setSaving(true)
    setError(null)
    try {
      await mudo.invoke('videos:saveScript', { id: videoId, acts })
      const r = await mudo.invoke('videos:resume', { id: videoId })
      if (!r.ok) throw new Error(r.message ?? 'Não foi possível retomar.')
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={!!videoId}
      onClose={onClose}
      title="Editar roteiro"
      wide
      footer={
        <>
          <span className={`mr-auto self-center text-xs ${inRange ? 'text-muted-foreground' : 'text-warning'}`} data-testid="word-count">
            {total} palavras · alvo {data?.targetWords ?? '—'} (aceito {min}–{max}){inRange ? '' : ' — a narração pode sair fora da duração'}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button data-testid="save-script" disabled={!data?.editable || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="animate-spin" /> : <Play />} Salvar e retomar
          </Button>
        </>
      }
    >
      {error && <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      {!data && !error && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Carregando roteiro…
        </div>
      )}
      {data && (
        <div className="grid grid-cols-[1fr_280px] gap-4">
          <div className="space-y-3">
            {!data.editable && (
              <p className="text-xs text-warning">
                {acts.length === 0 ? 'Este vídeo ainda não tem roteiro para editar.' : 'O roteiro só pode ser editado com a geração parada.'}
              </p>
            )}
            {acts.map((a, i) => (
              <div key={i} className="rounded-md border border-border p-3" data-testid="act-editor">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">Ato {i + 1}</span>
                  <Input
                    aria-label={`Título interno do ato ${i + 1}`}
                    value={a.heading}
                    onChange={(e) => setActs(acts.map((x, k) => (k === i ? { ...x, heading: e.target.value } : x)))}
                  />
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">{words(a.text)} pal.</span>
                </div>
                <Textarea
                  aria-label={`Narração do ato ${i + 1}`}
                  rows={4}
                  value={a.text}
                  onChange={(e) => setActs(acts.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                />
              </div>
            ))}
          </div>
          <aside>
            <Label>Pontos da revisão</Label>
            {data.issues.length === 0 && <p className="text-xs text-muted-foreground">Nenhum ponto registrado.</p>}
            <ul className="space-y-2">
              {data.issues.map((is, k) => (
                <li key={k} className="rounded-md border border-border bg-background p-2 text-xs">
                  <div className="mb-0.5 flex items-center gap-1 font-medium">
                    {is.kind === 'factual' && <AlertTriangle className="size-3 text-warning" />}
                    {KIND_LABEL[is.kind] ?? is.kind}
                    {is.act ? <span className="text-muted-foreground"> · ato {is.act}</span> : null}
                  </div>
                  <p className="text-muted-foreground">{is.note}</p>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}
    </Dialog>
  )
}
