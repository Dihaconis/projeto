import { Download, FolderInput, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LIBRARY_LICENSES } from '../../../shared/enums'
import type { LicenseEntryView } from '../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Label, Select } from '@/components/ui/input'
import { mudo } from '@/lib/bridge'
import { cn, formatDate } from '@/lib/utils'

type VideoItem = { id: string; title: string | null; theme: string; state: string; createdAt: number }
type Img = { id: string; fileName: string; source: string; license: string | null; author: string | null; creditText: string | null; width: number | null; height: number | null; usedCount: number }
const LICENSE_LABEL: Record<string, string> = { cc0: 'CC0', public_domain: 'Domínio público', own: 'Própria', pexels: 'Pexels', pixabay: 'Pixabay', generated: 'Gerada por IA' }

export function LicensesScreen() {
  const [videos, setVideos] = useState<VideoItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [entries, setEntries] = useState<LicenseEntryView[] | null>(null)
  const [quarantine, setQuarantine] = useState<Img[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [importLicense, setImportLicense] = useState<string>('own')
  const [importCredit, setImportCredit] = useState('')
  const [importing, setImporting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [v, q] = await Promise.all([mudo.invoke('licenses:videos'), mudo.invoke('images:list', { quarantine: true })])
      setVideos(v)
      setQuarantine(q)
      setSelected((s) => s ?? v[0]?.id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => void refresh(), [refresh])
  useEffect(() => {
    if (!selected) return setEntries(null)
    setEntries(null)
    mudo
      .invoke('licenses:forVideo', { id: selected })
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [selected])
  useEffect(() => mudo.on('images:importProgress', (p) => setImporting(`${p.done} arquivo(s)… ${p.file}`)), [])

  const exportCsv = async (ids: string[]) => {
    const r = await mudo.invoke('licenses:exportCsv', { ids })
    if (r.ok) setNotice(`CSV salvo em ${r.path} (${r.rows} linha(s)).`)
  }

  const runImport = async () => {
    setImporting('Iniciando…')
    setError(null)
    try {
      const r = await mudo.invoke('images:import', { license: importLicense === 'none' ? null : (importLicense as 'own'), credit: importCredit.trim() || null })
      if (!r.ok) setError(r.message ?? 'A importação falhou.')
      else setNotice(`Acervo: ${r.imported} importada(s), ${r.updated} atualizada(s), ${r.rejected} recusada(s) (menos de 1280 px ou formato inválido), ${r.quarantined} em quarentena.`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-[15px] font-semibold">Licenças</h1>
          <p className="text-xs text-muted-foreground">Toda imagem e música usada, com fonte, autor, origem e crédito. Sem licença registrada, nada entra no vídeo.</p>
        </div>
        {videos && videos.length > 0 && (
          <Button variant="secondary" onClick={() => void exportCsv(videos.map((v) => v.id))}>
            <Download /> Exportar todos (CSV)
          </Button>
        )}
      </header>
      {(error || notice) && (
        <p className={cn('border-b px-5 py-2 text-xs', error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-success/30 bg-success/10 text-success')}>{error ?? notice}</p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-auto border-r border-border p-3">
          <Label>Vídeos</Label>
          {videos === null && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {videos?.length === 0 && <p className="text-xs text-muted-foreground">Nenhum vídeo ainda.</p>}
          {videos?.map((v) => (
            <button key={v.id} onClick={() => setSelected(v.id)} className={cn('mb-1 w-full rounded-md px-2 py-1.5 text-left text-[13px]', selected === v.id ? 'bg-muted' : 'hover:bg-muted/60')}>
              <div className="truncate">{v.title ?? v.theme}</div>
              <div className="text-[11px] text-muted-foreground">{formatDate(v.createdAt)}</div>
            </button>
          ))}
        </aside>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[13px] font-semibold">Usadas no vídeo</h2>
              {selected && (
                <Button size="sm" variant="secondary" onClick={() => void exportCsv([selected])}>
                  <Download /> Exportar CSV
                </Button>
              )}
            </div>
            {selected && entries === null && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {entries?.length === 0 && <p className="text-xs text-muted-foreground">Este vídeo ainda não chegou à etapa de imagens.</p>}
            {entries && entries.length > 0 && (
              <Card>
                <table className="w-full text-left text-[12px]" data-testid="licenses-table">
                  <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Tipo</th>
                      <th className="px-3 py-2">Cenas</th>
                      <th className="px-3 py-2">Fonte / autor</th>
                      <th className="px-3 py-2">Licença</th>
                      <th className="px-3 py-2">Crédito</th>
                      <th className="px-3 py-2">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <LicenseRow key={e.assetId} e={e} onSaved={() => selected && mudo.invoke('licenses:forVideo', { id: selected }).then(setEntries)} />
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-semibold">Acervo local</h2>
            <Card className="mb-3 flex flex-wrap items-end gap-3 p-3">
              <div>
                <Label htmlFor="imp-lic">Licença da pasta</Label>
                <Select id="imp-lic" value={importLicense} onChange={(e) => setImportLicense(e.target.value)}>
                  {LIBRARY_LICENSES.map((l) => (
                    <option key={l} value={l}>
                      {LICENSE_LABEL[l]}
                    </option>
                  ))}
                  <option value="none">Escolher por arquivo (quarentena)</option>
                </Select>
              </div>
              <div className="min-w-60 flex-1">
                <Label htmlFor="imp-cred">Crédito (opcional)</Label>
                <Input id="imp-cred" value={importCredit} placeholder="Ex.: Fotos: Fulana" onChange={(e) => setImportCredit(e.target.value)} />
              </div>
              <Button disabled={!!importing} onClick={() => void runImport()}>
                {importing ? <Loader2 className="animate-spin" /> : <FolderInput />} Importar pasta do acervo
              </Button>
              {importing && <p className="w-full text-[11px] text-muted-foreground">{importing}</p>}
            </Card>
            <Label>Em quarentena (sem licença — não são usadas)</Label>
            {quarantine.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma imagem em quarentena.</p>}
            {quarantine.map((q) => (
              <QuarantineRow key={q.id} img={q} onSaved={() => void refresh()} />
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}

function LicenseRow({ e, onSaved }: { e: LicenseEntryView; onSaved: () => void }) {
  const [credit, setCredit] = useState('')
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-3 py-2">{e.kind === 'image' ? 'Imagem' : 'Música'}</td>
      <td className="px-3 py-2 font-mono text-[11px]">{e.scenes.join(', ') || '—'}</td>
      <td className="px-3 py-2">
        <div>{LICENSE_LABEL[e.source] ?? e.source}</div>
        <div className="text-[11px] text-muted-foreground">{e.author ?? '—'}</div>
        {e.sourceUrl && <div className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={e.sourceUrl}>{e.sourceUrl}</div>}
      </td>
      <td className="px-3 py-2">{e.license ? (LICENSE_LABEL[e.license] ?? e.license) : '—'}</td>
      <td className="px-3 py-2">
        {e.creditText ?? (e.requiresCredit ? '' : <span className="text-muted-foreground">não exigido</span>)}
        {e.status === 'missing_credit' && e.kind === 'image' && (
          <div className="mt-1 flex gap-1">
            <Input value={credit} placeholder="Texto do crédito" onChange={(ev) => setCredit(ev.target.value)} />
            <Button size="sm" disabled={!credit.trim()} onClick={() => void mudo.invoke('licenses:setCredit', { imageId: e.assetId, credit }).then(onSaved)}>
              Salvar
            </Button>
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {e.status === 'ok' ? (
          <Badge tone="success">
            <ShieldCheck className="mr-1 size-3" /> ok
          </Badge>
        ) : (
          <Badge tone="danger">
            <ShieldAlert className="mr-1 size-3" /> {e.status === 'missing_license' ? 'sem licença' : 'falta crédito'}
          </Badge>
        )}
      </td>
    </tr>
  )
}

function QuarantineRow({ img, onSaved }: { img: Img; onSaved: () => void }) {
  const [license, setLicense] = useState('own')
  const [credit, setCredit] = useState('')
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-[12px]" data-testid="quarantine-row">
      <span className="min-w-48 flex-1 truncate" title={img.fileName}>
        {img.fileName} <span className="text-muted-foreground">({img.width}×{img.height})</span>
      </span>
      <Select className="w-40" value={license} onChange={(e) => setLicense(e.target.value)} aria-label="Licença">
        {LIBRARY_LICENSES.map((l) => (
          <option key={l} value={l}>
            {LICENSE_LABEL[l]}
          </option>
        ))}
      </Select>
      <Input className="w-56" value={credit} placeholder="Crédito (opcional)" onChange={(e) => setCredit(e.target.value)} />
      <Button size="sm" onClick={() => void mudo.invoke('images:setLicense', { id: img.id, license: license as 'own', credit: credit.trim() || null }).then(onSaved)}>
        Liberar
      </Button>
    </div>
  )
}
