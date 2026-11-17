import { ArrowRight, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SecretId } from '../../../core/secrets'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { mudo } from '@/lib/bridge'
import { ChannelForm, draftFrom, toInput } from './ChannelForm'
import { KeysEditor } from './SettingsScreen'

const ESSENTIAL: SecretId[] = ['anthropic', 'elevenlabs', 'openai', 'pexels', 'pixabay']

/** Primeiro uso (seção 15): chaves + primeiro canal, depois Meus Vídeos. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [configured, setConfigured] = useState<SecretId[]>([])
  const [draft, setDraft] = useState(draftFrom())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const load = () => void mudo.invoke('settings:get').then((s) => setConfigured(s.configuredKeys))
  useEffect(load, [])

  const finish = async () => {
    setSaving(true)
    setError(null)
    try {
      await mudo.invoke('channels:save', { id: null, channel: toInput(draft) })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8" data-testid="onboarding">
      <Card className="w-full max-w-3xl p-6">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Primeiro uso · passo {step} de 2</p>
        {step === 1 ? (
          <>
            <h1 className="mb-1 text-lg font-semibold">Conecte seus provedores</h1>
            <p className="mb-4 text-xs text-muted-foreground">
              O MUDO usa as suas chaves: um provedor de texto (Claude, OpenAI ou Gemini), um de voz (ElevenLabs, OpenAI ou Azure) e, para imagens, Pexels e/ou Pixabay. Dá para mudar
              tudo depois em Configurações.
            </p>
            <KeysEditor configured={configured} onChanged={load} only={ESSENTIAL} />
            <div className="mt-5 flex justify-end">
              <Button data-testid="onboarding-next" onClick={() => setStep(2)}>
                {configured.length === 0 ? 'Pular por agora' : 'Continuar'} <ArrowRight />
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-lg font-semibold">Crie seu primeiro canal</h1>
            <p className="mb-4 text-xs text-muted-foreground">O canal define voz, estilo visual e tom de todos os vídeos dele.</p>
            <ChannelForm value={draft} onChange={setDraft} />
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            <div className="mt-5 flex justify-between">
              <Button variant="secondary" onClick={() => setStep(1)}>
                Voltar
              </Button>
              <Button data-testid="onboarding-finish" disabled={saving || !draft.name.trim() || !draft.niche.trim()} onClick={() => void finish()}>
                {saving && <Loader2 className="animate-spin" />} Criar canal e começar
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
