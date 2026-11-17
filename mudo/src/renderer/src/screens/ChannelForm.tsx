import { Loader2, Volume2 } from 'lucide-react'
import { useState } from 'react'
import type { ChannelInput } from '../../../shared/channel'
import { LANGUAGES, MUSIC_MOODS, type Language, type MusicMood } from '../../../shared/enums'
import type { ChannelSummary } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Input, Label, Select, Textarea } from '@/components/ui/input'
import { mudo } from '@/lib/bridge'

const LANG_LABEL: Record<Language, string> = { 'pt-BR': 'Português (BR)', es: 'Español', en: 'English' }
export const MOOD_LABEL: Record<MusicMood, string> = { calm: 'Calma', upbeat: 'Animada', dramatic: 'Dramática', mysterious: 'Misteriosa', inspiring: 'Inspiradora' }
const TTS_LABEL = { elevenlabs: 'ElevenLabs', openai: 'OpenAI', azure: 'Azure' } as const

export type ChannelDraft = {
  name: string
  niche: string
  language: Language
  ttsProvider: '' | 'elevenlabs' | 'openai' | 'azure'
  voiceId: string
  musicMood: MusicMood
  scriptStyle: string
  manualReview: boolean
  highlightColor: string
  subtitleColor: string
  motionIntensity: 'subtle' | 'medium'
}

export function draftFrom(c?: ChannelSummary): ChannelDraft {
  return {
    name: c?.name ?? '',
    niche: c?.niche ?? '',
    language: c?.language ?? 'pt-BR',
    ttsProvider: c?.ttsProvider ?? '',
    voiceId: c?.voiceId ?? '',
    musicMood: c?.musicMood ?? 'calm',
    scriptStyle: c?.stylePreset.scriptStyle ?? '',
    manualReview: c?.stylePreset.manualReview ?? false,
    highlightColor: c?.stylePreset.highlightColor ?? '#FFD400',
    subtitleColor: c?.stylePreset.subtitleColor ?? '#FFFFFF',
    motionIntensity: c?.stylePreset.motionIntensity ?? 'subtle',
  }
}

export function toInput(d: ChannelDraft): ChannelInput {
  return {
    name: d.name,
    niche: d.niche,
    language: d.language,
    ...(d.ttsProvider ? { ttsProvider: d.ttsProvider } : {}),
    ...(d.voiceId.trim() ? { voiceId: d.voiceId.trim() } : {}),
    musicMood: d.musicMood,
    stylePreset: {
      manualReview: d.manualReview,
      ...(d.scriptStyle.trim() ? { scriptStyle: d.scriptStyle.trim() } : {}),
      highlightColor: d.highlightColor.toUpperCase(),
      subtitleColor: d.subtitleColor.toUpperCase(),
      motionIntensity: d.motionIntensity,
    },
  }
}

/** Formulário de canal com preset (seção 10) e prévia da voz. */
export function ChannelForm({ value, onChange }: { value: ChannelDraft; onChange: (d: ChannelDraft) => void }) {
  const [previewing, setPreviewing] = useState(false)
  const [audio, setAudio] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const set = <K extends keyof ChannelDraft>(k: K, v: ChannelDraft[K]) => onChange({ ...value, [k]: v })

  const preview = async () => {
    setPreviewing(true)
    setPreviewError(null)
    setAudio(null)
    try {
      const r = await mudo.invoke('channels:previewVoice', { language: value.language, ttsProvider: value.ttsProvider || null, voiceId: value.voiceId.trim() || null })
      setAudio(r.dataUrl)
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor="ch-name">Nome</Label>
        <Input id="ch-name" data-testid="ch-name" value={value.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div>
        <Label htmlFor="ch-niche">Nicho</Label>
        <Input id="ch-niche" data-testid="ch-niche" value={value.niche} maxLength={200} placeholder="Ex.: curiosidades de ciência" onChange={(e) => set('niche', e.target.value)} />
      </div>
      <div>
        <Label htmlFor="ch-lang">Idioma padrão</Label>
        <Select id="ch-lang" value={value.language} onChange={(e) => set('language', e.target.value as Language)}>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="ch-mood">Trilha</Label>
        <Select id="ch-mood" value={value.musicMood} onChange={(e) => set('musicMood', e.target.value as MusicMood)}>
          {MUSIC_MOODS.map((m) => (
            <option key={m} value={m}>
              {MOOD_LABEL[m]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="ch-tts">Voz — provedor</Label>
        <Select id="ch-tts" value={value.ttsProvider} onChange={(e) => set('ttsProvider', e.target.value as ChannelDraft['ttsProvider'])}>
          <option value="">Automático (ordem das Configurações)</option>
          {(Object.keys(TTS_LABEL) as Array<keyof typeof TTS_LABEL>).map((p) => (
            <option key={p} value={p}>
              {TTS_LABEL[p]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="ch-voice">Voz — id</Label>
        <div className="flex gap-2">
          <Input id="ch-voice" value={value.voiceId} placeholder="padrão do provedor" onChange={(e) => set('voiceId', e.target.value)} />
          <Button variant="secondary" disabled={previewing} onClick={() => void preview()} aria-label="Ouvir prévia da voz">
            {previewing ? <Loader2 className="animate-spin" /> : <Volume2 />} Ouvir
          </Button>
        </div>
        {audio && <audio className="mt-2 w-full" controls autoPlay src={audio} />}
        {previewError && <p className="mt-1 text-[11px] text-destructive">{previewError}</p>}
      </div>
      <div className="col-span-2">
        <Label htmlFor="ch-style">Tom e estilo do roteiro</Label>
        <Textarea id="ch-style" rows={2} maxLength={500} value={value.scriptStyle} placeholder="Ex.: didático e leve, frases curtas, humor sutil" onChange={(e) => set('scriptStyle', e.target.value)} />
      </div>
      <div className="flex items-end gap-4">
        <div>
          <Label htmlFor="ch-hl">Destaque da legenda</Label>
          <input id="ch-hl" type="color" className="h-8 w-14 rounded border border-input bg-background" value={value.highlightColor} onChange={(e) => set('highlightColor', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ch-sub">Texto da legenda</Label>
          <input id="ch-sub" type="color" className="h-8 w-14 rounded border border-input bg-background" value={value.subtitleColor} onChange={(e) => set('subtitleColor', e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="ch-motion">Ritmo de movimento</Label>
        <Select id="ch-motion" value={value.motionIntensity} onChange={(e) => set('motionIntensity', e.target.value as 'subtle' | 'medium')}>
          <option value="subtle">Sutil</option>
          <option value="medium">Médio</option>
        </Select>
      </div>
      <label className="col-span-2 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={value.manualReview} onChange={(e) => set('manualReview', e.target.checked)} />
        Revisar manualmente sempre (a geração para antes das imagens, mesmo com o roteiro aprovado)
      </label>
    </div>
  )
}
