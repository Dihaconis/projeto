# MUDO

Gerador local de vídeo narrado para canal sem rosto (Windows). Electron + React + TypeScript + SQLite.

> **Estado: Fase 8.** App completo (Meus Vídeos, Biblioteca, Cortes Beta, Canais, Licenças,
> Configurações), CLI, instalador NSIS x64 por usuário + portable, e CI no Windows que instala sem
> admin num caminho com espaço e acento e roda sem Node.

## Requisitos de desenvolvimento

- Node 22+ e npm
- Windows 10/11 x64 (alvo). Linux/macOS funcionam para desenvolvimento e testes.

```bash
npm install          # também baixa CLIP + whisper base (~290 MB) com hash verificado (npm run models)
npm run binaries     # ffmpeg/ffprobe (hash conferido) e whisper-cli compilado da tag v1.9.5 (requer cmake + C++)
npm run dev          # app com recarga
npm run typecheck
npm test             # unitários + integração (fila, provedores, pipeline, CLI gerando MP4 real com fixtures, kill -9)
npm run test:e2e     # build + e2e no app Electron real (Linux sem tela: usa xvfb-run)
```

## Instalador (Fase 8)

```bash
npm run dist            # modelos + binários (hash conferido) + licenças + build + NSIS e portable (no Windows)
npm run test:packaged   # gera o pacote da plataforma atual (pasta) e roda o smoke sobre ele
```

### Configuração (`electron-builder.yml`)

- **NSIS x64:**
  - Instalação por usuário (`perMachine: false`, sem elevação) em `%LOCALAPPDATA%\Programs`, nunca
    em Program Files.
  - Diretório escolhível; desinstalar não apaga `%APPDATA%\MUDO`.
- **Portable x64.**
- **Fora do asar:** os módulos nativos (better-sqlite3, sharp, onnxruntime-node). Todos são N-API
  pré-compilados, por isso `npmRebuild: false`.
- **`afterPack`:** remove os binários de outras plataformas (o onnxruntime traz todas).
- **`extraResources`:**
  - `bin/`: ffmpeg/ffprobe com SHA-256 no lock, whisper-cli de commit fixo, yt-dlp com SHA-256 oficial.
  - `models/`: CLIP e whisper base, com SHA-256.
  - Também: `migrations/`, `assets/` (fontes OFL, textos legais) e `cli/` (`mudo.cmd`).
- **Fuses:** `runAsNode` ligado, porque a CLI depende dele. `onlyLoadAppFromAsar`, cookies cifrados,
  `NODE_OPTIONS` e `--inspect` desligados.
- **Erro na inicialização:** caixa de erro com o caminho de `startup-error.log`, e a pasta de logs
  abre.

### CLI no Windows

```
"%LOCALAPPDATA%\Programs\MUDO\resources\cli\mudo.cmd" channel list
```

O `mudo.cmd` roda o core com o próprio `MUDO.exe` em modo Node; não precisa de Node instalado.

### CI no Windows (`.github/workflows/mudo-windows.yml`)

Roda em `windows-latest`, nos PRs que mexem em `mudo/` e sob demanda:

1. Typecheck, testes, e2e no Electron e smoke do pacote.
2. Gera o NSIS e o portable.
3. Instala em silêncio, **sem admin**, em `…\Programs\MUDO Teste ação`.
4. Tira do PATH tudo que tem `node.exe` e roda a CLI instalada.
5. Abre o app instalado e confere que o runner dele processa um vídeo até pedir a chave.
6. Desinstala e publica os instaladores como artefato.

## Critérios de aceite (seção 17) — onde cada um é verificado

| # | Critério | Verificação |
|---|---|---|
| 1 | Tema → vídeo 6–9 min em até 10 min, tempo por etapa registrado | `stage_timings` e `gen_time_s` gravados por vídeo (`tests/integration/cli.e2e.test.ts`). **O tempo com provedores reais ainda precisa ser medido com as suas chaves.** |
| 2 | 1080p/30, legenda < 150 ms, música sob a voz, −14 LUFS ±1, thumbnail e cartela | `tests/integration/acceptance.test.ts` e `tests/unit/assembly.test.ts` |
| 3 | Matar na montagem e reabrir retoma do último segmento | `tests/integration/crash-assemble.test.ts` |
| 4 | Imagem que exige crédito sem crédito → `LICENSE_MISSING` | `tests/integration/pipeline.test.ts` |
| 5 | Provedor fora do ar → fallback | `tests/integration/cli.e2e.test.ts`, `tests/unit/providers.test.ts` |
| 6 | Recusa → `needs_input`, sem troca automática | `tests/integration/cli.e2e.test.ts`, `tests/unit/providers.test.ts` |
| 7 | Cota estourada recusa antes de enfileirar | `tests/integration/phase6.test.ts` |
| 8 | Instalador no Windows limpo, sem admin, sem Node, caminho com espaço/acento | workflow `mudo-windows.yml`; o mesmo smoke em Linux em `tests/packaged/` |
| 9 | Nenhuma marca d'água | não existe nenhum código que desenhe marca; só metadado `comment` e a cartela de créditos |
| 10 | Nenhuma chave em log, banco em texto claro ou renderer | `tests/e2e/app.e2e.test.ts` (config.json, logs, HTML da página) e redação no pino |
| 11 | Testes unitários do core + e2e da CLI com fixtures | `npm test` |

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

### Imagens (Fase 3)

- **Acervo local:** `mudo images import <pasta> --license own|cc0|public_domain [--credit "..."]`.
  - Os arquivos ficam onde estão; o app guarda pHash e embedding.
  - Imagem sem licença fica em **quarentena** e nunca é usada; `mudo images license <id> ...` define a
    licença por arquivo.
  - Imagens abaixo de 1280 px são recusadas.
- **Ordem por cena:**
  1. **Acervo:** cosseno entre o embedding da busca e o da imagem, com penalidade por uso nos últimos
     30 dias.
  2. **Pexels → Pixabay:** os candidatos são pontuados pela prévia, em memória. Só a escolhida é
     baixada e guardada, com licença, autor e URL gravados na hora.
  3. **Geração por IA** (licença `generated`).
  4. Nada encontrado → `IMAGES_UNAVAILABLE`.
- **Regras:**
  - Nunca repete imagem no mesmo vídeo; a comparação é por pHash, não só por id.
  - Recorte inteligente 16:9, pré-escalado a 4K.
  - Créditos na ordem de aparição, gravados na tabela `credits` e no `.txt`.
- **Embeddings:** CLIP local (`Xenova/clip-vit-base-patch32`, q8), offline, em revisão fixa. Os
  arquivos e seus SHA-256 estão em `scripts/models.lock.json` e o app nunca baixa nada em execução.
  Alternativa: OpenAI (só texto), com `config set embeddings.provider openai`.

### Cortes (Beta, Fase 7)

- **Entrada:** link (baixado com **yt-dlp** 2026.10.26, binário oficial com SHA-256 conferido) ou
  arquivo local.
- **Autorização:** o checkbox "este vídeo é meu ou tenho autorização" é obrigatório; sem ele, nada é
  criado (UI e core). O momento da confirmação fica gravado.
- **Análise** (job `cut`, no runner):
  - Transcrição com whisper.cpp, idioma detectado.
  - O LLM aponta de 1 a 6 trechos de 15–90 s com nota 0–100 e justificativa, encaixados em limites
    de frase e sem sobreposição.
  - Recusa e falta de chave seguem as regras de sempre.
- **Exportação 9:16** (job `cut_export`):
  - 1080×1920, recorte central, legenda queimada palavra a palavra, loudnorm −14 LUFS.
  - Metadado de IA; arquivo em `<saída>/Cortes`.
  - Consome a cota de cortes só quando o arquivo fica pronto; a cota é checada antes de enfileirar.

### Canais, Licenças, Configurações e cota (Fase 6)

- **Canais:**
  - Criar, editar e remover; um canal com vídeos é arquivado.
  - Preset por canal: voz (provedor e id, com prévia de áudio), trilha, cores da legenda, ritmo de
    movimento, tom do roteiro e revisão manual.
- **Repetição entre vídeos do canal (seção 10):**
  - A revisão reprova o roteiro que repete a estrutura de um dos 10 últimos do canal.
  - Mede sequências de 3 palavras e aberturas de frase em comum; limite `review.maxSimilarity`,
    padrão 0,30.
  - Não usa embedding: o CLIP só lê 77 tokens.
- **Licenças:**
  - Por vídeo, cada imagem e a música, com fonte, autor, URL de origem, licença, crédito e situação.
  - Crédito que falta pode ser preenchido na tela. Exportação CSV de um vídeo ou de todos.
  - Acervo: importar a pasta (CLIP roda no runner, com progresso) e liberar imagens em quarentena.
- **Configurações:**
  - Chaves com "testar conexão"; a chave nunca volta à tela.
  - Ordem dos provedores, modelos, embeddings, pastas, jobs simultâneos, plano e cota.
  - Sobre: versão, Termos, Privacidade e licenças de terceiros (`npm run legal`).
- **Cota (seção 12):**
  - Planos só em `src/shared/plans.ts`. O padrão é Ilimitado (uso pessoal).
  - Checada antes de enfileirar, contando os vídeos em produção. Consumida só em `done`.
  - Estouro → `QUOTA_EXCEEDED` com quanto resta (código 3 na CLI). Reset no dia 1, no fuso local.
- **Primeiro uso:** assistente com as chaves e o primeiro canal, depois Meus Vídeos.

### Telas (Fase 5)

- **Meus Vídeos:**
  - Formulário com tema, canal, idioma (padrão do canal) e duração de 6 a 9 min.
  - Custo estimado ao vivo, antes de enfileirar.
  - Fila com etapa, progresso, tempo decorrido e as ações cancelar, retomar e editar roteiro. A
    edição fica disponível em "aguardando você", com os pontos da revisão ao lado.
  - Ao terminar, aviso para marcar o conteúdo como sintético na plataforma.
- **Biblioteca:**
  - Grade com thumbnail, duração, data e custo.
  - Player, abrir pasta, copiar título e descrição, e apagar com confirmação.
  - Vídeo e thumbnails chegam ao renderer pelo protocolo só-leitura `mudo-media://`; o renderer
    nunca vê caminhos de disco.
- Toda tela tem estados de vazio, carregando, erro (com "Abrir logs") e sucesso.

### Montagem (Fase 4)

- **Movimento:**
  - `zoompan` sobre o quadro 4K, decodificado uma vez.
  - Alterna zoom in, zoom out, pan à esquerda e pan à direita, nunca dois iguais seguidos.
  - Intensidade sutil por padrão (preset `motionIntensity`).
- **Cortes:** corte seco entre cenas. Na virada de ato, a cena anterior continua o movimento por
  0,4 s e funde na nova (crossfade); a linha do tempo não muda.
- **Legenda `.ASS` queimada em cada segmento:**
  - Até 2 linhas de ~32 caracteres, palavra atual destacada (cor do preset).
  - Fonte embarcada (Archivo Black, OFL), contorno grosso, área segura inferior.
  - Tempos das palavras: os do provedor quando existem (ElevenLabs, descontando o silêncio cortado);
    senão whisper.cpp (`base`) alinhado ao texto conhecido por programação dinâmica.
  - Sincronia medida no teste de aceite: < 150 ms.
- **Trilha:**
  - Clima do canal (`calm`, `upbeat`, `dramatic`, `mysterious`, `inspiring`).
  - Músicas do usuário com licença (`mudo music import`). Senão, trilha embutida sintetizada pelo
    próprio ffmpeg (licença própria).
  - Em loop, com fade e `sidechaincompress` sob a voz.
- **Loudnorm** em duas passadas: −14 LUFS integrados, pico real ≤ −1 dBTP (alvo −1,5 para margem
  do AAC).
- **Fechamento:**
  - Cartela final de créditos (páginas de 3,5 s), com a narração, as imagens e a música que exigem
    crédito.
  - 2 thumbnails 1280×720 com as imagens mais fortes do ato 1, gradiente escuro e título em caixa
    alta (Anton, OFL).
- **Binários e modelos:** ffmpeg/ffprobe com SHA-256 em `scripts/binaries.lock.json`; whisper-cli
  compilado de commit fixo; modelos com SHA-256 em `scripts/models.lock.json`.

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
