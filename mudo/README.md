# MUDO

Gerador local de vídeo narrado para canal sem rosto (Windows). Electron + React + TypeScript + SQLite.

> **Estado: Fase 2.** CLI completa gerando MP4 real: roteiro → revisão → cenas → narração → ffmpeg,
> com uma imagem de fundo fixa por enquanto (imagens por cena chegam na Fase 3; legenda, movimento,
> trilha, loudnorm e thumbnail na Fase 4).

## Requisitos de desenvolvimento

- Node 22+ e npm
- Windows 10/11 x64 (alvo). Linux/macOS funcionam para desenvolvimento e testes.

```bash
npm install
npm run dev          # app com recarga
npm run typecheck
npm test             # unitários + integração (fila, provedores, pipeline, CLI gerando MP4 real com fixtures, kill -9)
npm run test:e2e     # build + e2e no app Electron real (Linux sem tela: usa xvfb-run)
```

## CLI

A CLI usa o mesmo core, sem Electron. Ela roda no próprio executável do MUDO em modo Node
(`ELECTRON_RUN_AS_NODE=1`), então funciona sem Node instalado. Em desenvolvimento: `npm run build`
e depois `npm run cli -- <comando>`.

```bash
# chaves (lidas do stdin, cifradas com safeStorage; nunca por argumento)
echo "sk-ant-..." | npm run cli -- keys set anthropic
echo "..."        | npm run cli -- keys set elevenlabs
npm run cli -- keys list

npm run cli -- channel create --name "Ciência em 1 Minuto" --niche "ciência do dia a dia" --lang pt-BR
npm run cli -- estimate --theme "Por que o céu é azul" --channel <channelId> --duration 60
npm run cli -- generate --theme "Por que o céu é azul" --channel <channelId> --duration 60 --wait
npm run cli -- status <jobId> --json
npm run cli -- library list --json
npm run cli -- config set output.dir "D:\Vídeos\MUDO"
```

Códigos de saída: 0 ok · 1 erro (inclui "aguardando você") · 2 entrada inválida · 3 cota.

- Saída padrão: `Vídeos/MUDO` do usuário (`config set output.dir` muda).
- `--wait` processa o job no próprio processo da CLI. Sem `--wait`, o job fica na fila e o app
  (se aberto) o processa.
- **Chaves e a CLI:** o `safeStorage` só existe no processo principal do Electron. A CLI abre o app
  em modo `--mudo-secrets-helper` (sem janela) e troca uma linha JSON por pipe.
- **Linux de desenvolvimento sem chaveiro:** o Chromium cai no backend `basic_text`, que só ofusca.
  Esse backend só é aceito com `MUDO_ALLOW_BASIC_SECRET_STORE=1`. No Windows é sempre DPAPI.

## Provedores

| Etapa | Ordem padrão | Observações |
|---|---|---|
| LLM (roteiro, revisão, cenas) | Anthropic → OpenAI → Gemini | Anthropic via SDK oficial, `claude-opus-5-5`, saída em JSON schema; validação final sempre com zod |
| TTS | ElevenLabs → OpenAI → Azure | ElevenLabs pelo endpoint `/with-timestamps` |

- Cada chamada tem timeout, 3 tentativas com backoff exponencial e jitter, `AbortSignal` e uma
  linha em `provider_log`.
- **Erro técnico** (timeout, 5xx, 429, cota, rede): passa para o próximo provedor da ordem.
- **Recusa por política:** `needs_input` com a mensagem do provedor. Não troca de provedor e não
  usa o fallback de modelo do servidor.
- **TTS:** o provedor escolhido na 1ª cena fica travado para o vídeo inteiro, para a voz não mudar
  no meio.

## Testes e fixtures

Os testes usam **provedores de fixture** (`tests/helpers/fixtures.ts` + `tests/fixtures/`). Eles
devolvem respostas no formato real dos provedores, sem rede, e só existem em `/tests`. As respostas
foram escritas à mão no formato da API, não gravadas de chamadas reais. Os adaptadores reais são
testados contra um servidor HTTP local que imita cada API.

### Módulo nativo (`better-sqlite3`)

`better-sqlite3` 13 vem com binários **N-API** pré-compilados (`prebuilds/`), que servem para Node e
Electron sem recompilar. O mesmo binário atende o app, os testes e a CLI. Se você trocar para uma
versão sem prebuild para sua plataforma, recompile para o ABI do Electron:

```bash
npm run rebuild:native   # @electron/rebuild -f -w better-sqlite3 (precisa de Visual Studio Build Tools no Windows)
```

## Arquitetura

| Camada | Pasta | Papel |
|---|---|---|
| core | `src/core` | TypeScript puro, sem Electron: banco, fila, runner, pipeline, spawn de processos |
| main | `src/main` | janela, IPC tipado (zod), ciclo de vida, supervisão do runner |
| runner | `src/runner` | entrada do `utilityProcess`; consome a fila usando o core |
| preload | `src/preload` | `contextBridge` — única ponte do renderer, valida entrada com zod |
| renderer | `src/renderer` | React, sem acesso a Node, disco, rede ou chaves |
| shared | `src/shared` | enums, contrato de IPC, protocolo main↔runner |

Dados em `%APPDATA%/MUDO` (`mudo.db`, `work/<id>/`, `logs/`, `backups/`). `MUDO_DATA_DIR` sobrescreve.

### Pipeline (Fase 2)

1. **Roteiro:** JSON validado por zod e contagem de palavras ±10%. 1 retry enviando o erro; depois
   `SCRIPT_SCHEMA`.
2. **Revisão** com rubrica: reprovou 2× → `needs_input`, com as issues. Canal com
   `--manual-review` para mesmo quando aprovado. Retomar vale como liberação humana.
3. **Cenas:** divisão determinística de 5–10 s por frase/oração, sem perda de texto. O LLM só
   escreve a `image_query` de cada cena.
4. **Narração:**
   - TTS por cena, em paralelo, com checkpoint por cena.
   - Corte de silêncio e loudnorm por trecho; pausas exatas de 250 ms entre cenas e 600 ms entre
     atos.
   - `atempo` de até ±8% para caber na faixa; se não couber, `DURATION_OUT_OF_RANGE`.
5. **Montagem:**
   - Um segmento H.264 por cena (checkpoint), concat sem recodificar e AAC 192k.
   - Metadado `comment` de conteúdo gerado por IA.
   - `.txt` com título, descrição, tags e créditos.
   - Antes de montar, confere licenças (`LICENSE_MISSING`).

Faixa de duração: alvos de 6–9 min usam a faixa fechada do briefing. A CLI aceita alvos curtos
(30–359 s, ex.: 60 s) para teste, com janela de ±15%.

### Fila e retomada

- `jobs.state`: `queued → running → done | failed | cancelled | needs_input`; `jobs.stage`: `script → review → images → tts → assemble`.
- Reivindicação atômica (`UPDATE … RETURNING`), segura entre processos (app + CLI) com WAL.
- Toda escrita do runner exige posse (`state='running' AND locked_by=<runner>`). Cancelar ou recuperar um órfão
  tira a posse; o runner percebe no heartbeat (5 s, ou na hora via mensagem do main), aborta, mata a árvore de
  processos filhos e limpa `tmp/`.
- Heartbeat > 60 s ⇒ órfão: o reaper (na partida e a cada 15 s) mata filhos remanescentes registrados em
  `job_procs` (conferindo o executável, para não matar PID reaproveitado) e devolve o job à fila a partir do checkpoint.
- Fechar o app normalmente devolve jobs ativos à fila sem gastar tentativa.
- Pool padrão de 2 jobs; montagem limitada a 1 por vez (semáforo).

### Logs

`pino` + `pino-roll` (diário ou 10 MB, 7 arquivos) em `logs/main.N.log` e `logs/runner.N.log`, com redação de
campos de chave/token.
