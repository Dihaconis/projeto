import { FileText, ListOrdered } from 'lucide-react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import type { RunnerStatus } from '../../shared/ipc'
import { Button } from '@/components/ui/button'
import { mudo } from '@/lib/bridge'
import { cn } from '@/lib/utils'
import { QueueScreen } from '@/screens/QueueScreen'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-medium text-destructive">A interface encontrou um erro e parou esta tela.</p>
        <p className="text-xs text-muted-foreground">{this.state.error}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void mudo.invoke('app:openLogs')}>
            <FileText /> Abrir logs
          </Button>
          <Button onClick={() => this.setState({ error: null })}>Recarregar tela</Button>
        </div>
      </div>
    )
  }
}

export function App() {
  const [runner, setRunner] = useState<RunnerStatus | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void mudo.invoke('runner:status').then(setRunner).catch(() => undefined)
    void mudo.invoke('app:info').then((i) => setVersion(i.version)).catch(() => undefined)
    return mudo.on('runner:status', setRunner)
  }, [])

  const dot = runner?.state === 'running' ? 'bg-success' : runner?.state === 'restarting' ? 'bg-destructive' : 'bg-warning'

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card">
        <div className="px-4 py-4 text-[15px] font-bold tracking-[0.2em]">MUDO</div>
        <nav className="flex-1 px-2">
          <a className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-[13px]" aria-current="page">
            <ListOrdered className="size-4" /> Fila de jobs
          </a>
        </nav>
        <div className="space-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5" data-testid="runner-status" data-state={runner?.state ?? 'unknown'}>
            <span className={cn('size-1.5 rounded-full', dot)} />
            Runner: {runner?.state === 'running' ? 'ativo' : runner?.state === 'restarting' ? 'reiniciando' : runner?.state === 'stopped' ? 'parado' : 'iniciando'}
          </div>
          <div>v{version}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <ErrorBoundary>
          <QueueScreen runner={runner} />
        </ErrorBoundary>
      </main>
    </div>
  )
}
