import { FileText, Film, LibraryBig, Scissors, Settings, ShieldCheck, Tv } from 'lucide-react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import type { RunnerStatus } from '../../shared/ipc'
import { Button } from '@/components/ui/button'
import { mudo } from '@/lib/bridge'
import { cn } from '@/lib/utils'
import { ChannelsScreen } from '@/screens/ChannelsScreen'
import { CutsScreen } from '@/screens/CutsScreen'
import { LibraryScreen } from '@/screens/LibraryScreen'
import { LicensesScreen } from '@/screens/LicensesScreen'
import { Onboarding } from '@/screens/Onboarding'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { VideosScreen } from '@/screens/VideosScreen'

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

type Screen = 'videos' | 'library' | 'cuts' | 'channels' | 'licenses' | 'settings'
const NAV: Array<{ id: Screen; label: string; icon: typeof Film }> = [
  { id: 'videos', label: 'Meus Vídeos', icon: Film },
  { id: 'library', label: 'Biblioteca', icon: LibraryBig },
  { id: 'cuts', label: 'Cortes (Beta)', icon: Scissors },
  { id: 'channels', label: 'Canais', icon: Tv },
  { id: 'licenses', label: 'Licenças', icon: ShieldCheck },
  { id: 'settings', label: 'Configurações', icon: Settings },
]

export function App() {
  const [screen, setScreen] = useState<Screen>('videos')
  // primeiro uso: sem canal e sem nenhuma chave → assistente curto
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  useEffect(() => {
    void Promise.all([mudo.invoke('channels:list'), mudo.invoke('settings:get')])
      .then(([c, s]) => setOnboarding(c.length === 0 && s.configuredKeys.length === 0))
      .catch(() => setOnboarding(false))
  }, [])
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
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              data-testid={`nav-${id}`}
              aria-current={screen === id ? 'page' : undefined}
              onClick={() => (setOnboarding(false), setScreen(id))}
              className={cn('mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]', screen === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60')}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
        <div className="space-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5" data-testid="runner-status" data-state={runner?.state ?? 'unknown'}>
            <span className={cn('size-1.5 rounded-full', dot)} />
            Runner: {runner?.state === 'running' ? 'ativo' : runner?.state === 'restarting' ? 'reiniciando' : runner?.state === 'stopped' ? 'parado' : 'iniciando'}
          </div>
          <div>v{version}</div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary>
          {runner && runner.state !== 'running' && (
            <div className="border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-warning">
              {runner.message ?? (runner.state === 'starting' ? 'Iniciando o processo de geração…' : 'Processo de geração parado.')}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {onboarding ? (
              <Onboarding onDone={() => (setOnboarding(false), setScreen('videos'))} />
            ) : screen === 'videos' ? (
              <VideosScreen onOpenLibrary={() => setScreen('library')} />
            ) : screen === 'library' ? (
              <LibraryScreen />
            ) : screen === 'cuts' ? (
              <CutsScreen />
            ) : screen === 'channels' ? (
              <ChannelsScreen />
            ) : screen === 'licenses' ? (
              <LicensesScreen />
            ) : (
              <SettingsScreen />
            )}
          </div>
        </ErrorBoundary>
      </main>
    </div>
  )
}
