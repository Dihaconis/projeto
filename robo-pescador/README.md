# Robô do Pescador 🎣

Robô que produz sozinho, de graça, vídeos curtos verticais de **As Histórias de um Pescador**
(Shorts, Reels, TikTok e Kwai) e te avisa no Telegram com tudo pronto para postar:
vídeo com voz e legenda, thumbnail, título, legenda e hashtags.

Ele **não posta sozinho**, de propósito: você confere e posta. Isso protege o canal
(veja "Riscos" no fim).

---

## 1. Visão geral da arquitetura

```
                ┌──────────────────────── ROBÔ CHEFE (chefe.py) ────────────────────────┐
 agenda         │                                                                        │
 (GitHub   ──►  │  1 Roteirista ──► 2 Social media ──► 3 Diretor de arte ──► 4 Narrador  │
 Actions,       │    Gemini          Gemini              Pollinations        edge-tts     │
 4x/semana)     │                                                              │         │
                │  8 Aviso ◄── 7 Qualidade ◄── 6 Capa ◄── 5 Editor (FFmpeg) ◄──┘         │
                └────┬───────────────────────────────────────────────────────────────────┘
                     ▼
              Telegram no seu celular: vídeo + thumbnail + textos  ──► você posta
```

| Robô | Arquivo | O que faz | Ferramenta (grátis) |
|---|---|---|---|
| Chefe | `robo/chefe.py` | Coordena a fila, salva tudo na pasta do episódio | — |
| Roteirista | `agentes/roteirista.py` | Escreve o causo em 6 cenas, sem repetir temas | Gemini (plano gratuito) |
| Social media | `agentes/social.py` | Título, legenda, hashtags, frase da capa | Gemini |
| Diretor de arte | `agentes/diretor_arte.py` | 1 imagem 9:16 por cena + thumbnail | Pollinations + Pillow |
| Narrador | `agentes/narrador.py` | Voz de cada cena em pt-BR | edge-tts |
| Editor | `agentes/editor.py` | Zoom lento nas imagens, voz, legenda, música | FFmpeg |
| Qualidade | `agentes/qa.py` | Duração, áudio, palavrões, título longo | FFmpeg |
| Aviso | `robo/notificador.py` | Manda o pacote no Telegram | API de bots do Telegram |

Tudo que define a série (personagens, estilo, regras, duração) fica num lugar só:
**`config/serie.yaml`**. Mude ali e todos os robôs seguem.

### Suposições que eu fiz (corrija se estiver errado)

- **Projeto:** o robô dos cortes curtos (3 a 4 por semana). O episódio completo a cada
  duas semanas continua sendo feito com mais cuidado, com as folhas de personagem.
- **Sem site/painel web por enquanto.** O prompt pedia uma "aplicação web", mas com
  R$ 0 e uma pessoa só, o Telegram já é o painel: chega no celular, tem o vídeo e
  os textos para copiar. Um painel web vira a versão 2 quando houver vários canais.
- **Python em vez de Node.js/Next.js**, porque as bibliotecas de vídeo, voz e IA
  são melhores e mais simples em Python.
- **Nada de Docker, Kubernetes, PostgreSQL ou LangChain.** Para um robô que roda
  4 vezes por semana, isso só traria complexidade e custo. O "banco de dados" é o
  arquivo `dados/historico.json` (temas já usados).
- **Nuvem = GitHub Actions**, gratuito. Seu computador pode ficar desligado.

---

## 2. Auditoria do seu ambiente atual

Hoje você tem: **só o Claude**, Windows, R$ 0/mês.

**Remover:** nada. Como o ambiente está vazio, não há nada redundante.

**Ferramentas sugeridas antes que eu NÃO uso nesta fase** (todas pagas ou caras para o volume):

| Ferramenta | Por que fica de fora agora | Quando voltar |
|---|---|---|
| ElevenLabs | Voz mais bonita, mas paga por caractere | Quando o canal monetizar |
| Kling / Runway / Sora | Animação real cobra por vídeo | Episódios completos especiais |
| Midjourney | Só tem plano pago | Arte da capa do quadrinho |
| API da OpenAI e do Claude | Paga por uso (a assinatura do Claude não inclui API) | Se o Gemini gratuito não der conta |
| n8n | Faz o mesmo que o GitHub Actions, mas precisa de servidor | Se quiser editar o fluxo arrastando blocos |

**Manter:** o Claude (para criar roteiros dos episódios longos e evoluir este código) e o
Canva, que já está conectado aqui no Claude, para capas e artes caprichadas.

---

## 3. 🔴 Lacunas: o que instalar ou criar agora

Abra o **PowerShell** e rode os comandos de cada item.

- 🔴 **FALTA: Python 3.12** — linguagem do robô.
  `winget install Python.Python.3.12`
- 🔴 **FALTA: FFmpeg** — monta o vídeo. Use a versão completa (tem legenda).
  `winget install --id Gyan.FFmpeg`
- 🔴 **FALTA: Git** — para mandar o projeto para o GitHub.
  `winget install Git.Git`
- 🔴 **FALTA: Conta no GitHub** — onde o robô roda de graça. https://github.com/signup
- 🔴 **FALTA: Chave do Gemini** — o "cérebro" que escreve. Grátis, só precisa de conta Google.
  https://aistudio.google.com/apikey
- 🔴 **FALTA: Bot do Telegram** — para receber os vídeos no celular. No Telegram, fale com
  `@BotFather`, mande `/newbot` e copie o token. O passo a passo do `chat_id` está no `.env.example`.
- 🟡 **Opcional: VS Code** — para ler e editar o código com conforto.
  `winget install Microsoft.VisualStudioCode`
  depois as extensões: `code --install-extension ms-python.python` e
  `code --install-extension charliermarsh.ruff`
- 🟡 **Opcional: token do Pollinations** — imagens mais rápidas e sem marca d'água.
  https://enter.pollinations.ai

Depois de instalar, **feche e abra o PowerShell** para o Windows achar os programas.

---

## 4. Como rodar

### No seu computador (primeiro teste)

1. Descompacte a pasta `robo-pescador` em `Documentos`.
2. Dê dois cliques em **`instalar.bat`**.
3. Abra o arquivo **`.env`** no Bloco de Notas e cole a `GEMINI_API_KEY`
   (e, se já tiver, `TELEGRAM_TOKEN` e `TELEGRAM_CHAT_ID`).
4. Teste sem internet: abra o PowerShell na pasta e rode `.\rodar.bat --teste`.
   Sai um vídeo com cores lisas e um bipe no lugar da voz: é só para provar que a montagem funciona.
5. Episódio de verdade: `.\rodar.bat`. Leva de 3 a 8 minutos (as imagens grátis são lentas).

Cada episódio fica em `saida\EP-data-hora\` com: `video_final.mp4`, `thumbnail.jpg`,
`PACOTE.txt` (textos para copiar), `roteiro.json` (com o prompt de cada imagem, para
refazer uma cena à mão), as imagens, as falas e a legenda `.srt`.

### Na nuvem, no automático

1. Crie um repositório no GitHub (pode ser privado) e envie a pasta:
   ```powershell
   cd $HOME\Documents\robo-pescador
   git init
   git add .
   git commit -m "robo do pescador"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/robo-pescador.git
   git push -u origin main
   ```
2. No GitHub: **Settings → Secrets and variables → Actions → New repository secret** e crie
   `GEMINI_API_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` (e `POLLINATIONS_TOKEN`, se tiver).
3. Aba **Actions → Robô do Pescador → Run workflow** para rodar na hora.
   Depois disso ele roda sozinho **segunda, quarta, sexta e sábado às 8h** (Brasília).
   Para mudar os dias, edite a linha `cron` em `.github/workflows/robo.yml`.

O `.env` nunca vai para o GitHub (está no `.gitignore`). Na nuvem as chaves ficam nos *Secrets*.

---

## 5. Revisão crítica (o que pode dar errado e o que melhorar)

**Pontos fracos desta versão 1.0, em ordem de importância:**

1. **O Lucas e o Vô vão variar de uma imagem para outra.** O robô repete a descrição
   dos dois em todo prompt e usa uma "semente" fixa por cena, o que ajuda, mas a geração
   grátis não usa a folha de personagem como referência. *Melhoria:* quando houver orçamento,
   trocar o diretor de arte por um gerador que aceite imagem de referência.
   Por enquanto, se uma imagem sair estranha, copie o prompt dela do `roteiro.json`
   e gere de novo no Canva ou no ChatGPT, com o mesmo nome de arquivo.
2. **Imagens paradas com zoom não são animação.** Funciona para causo narrado,
   mas o episódio completo merece animação de verdade (Kling) mais tarde.
3. **A voz é boa, mas genérica** e não tem sotaque nortista nem nordestino.
   Troque entre `pt-BR-AntonioNeural` e `pt-BR-FranciscaNeural` no `.env` e escolha
   a que combina mais. Uma voz própria (a sua, gravada) é o maior salto de qualidade possível.
4. **Serviços gratuitos mudam sem aviso.** O plano gratuito do Gemini tem limites por
   minuto e por dia; o robô espera e troca de modelo quando bate o limite. O edge-tts usa
   um serviço da Microsoft que não é oficial para esse uso e pode parar; a alternativa
   local e gratuita é o Piper (`pip install piper-tts`). Se algo quebrar, me mande a
   mensagem de erro.
5. **Sem música por padrão.** Coloque o caminho de um MP3 livre de direitos
   (Biblioteca de áudio do YouTube) em `MUSICA_FUNDO` no `.env`.

**Riscos que não são de código:**

- **Monetização.** YouTube, TikTok e Instagram penalizam conteúdo repetitivo produzido
  em massa. O que protege o canal é ter uma série original, com personagens e voz própria,
  e você revisar antes de postar. Por isso o robô entrega o pacote em vez de postar.
- **Marcação de IA.** Marque o vídeo como feito com IA quando a rede perguntar.
- **Privacidade.** No plano gratuito, o Google pode usar o que você manda ao Gemini para
  melhorar os produtos dele. Não coloque dados pessoais de ninguém nos roteiros.
- **Direitos das imagens.** Antes de vender o quadrinho, confira os termos de uso comercial
  do gerador de imagens que usou. Para a HQ impressa, as artes devem passar pelo seu crivo
  e ajuste à mão, o que também fortalece o seu direito autoral sobre a obra.

**Próximas versões sugeridas:**

- v1.1: robô de "cortes" que pega um episódio longo pronto e tira 3 trechos curtos.
- v1.2: aprovar ou pedir "refaz a cena 3" respondendo no próprio Telegram.
- v2.0: painel web com a fila de episódios e as métricas das redes.

---

## 6. Desenho animado com boca sincronizada (`rodar.bat --animado`)

O Vô e o Lucas **conversando**, com a boca mexendo junto com a fala, a partir da **arte já
publicada da série** (a cara deles não muda).

```powershell
.\rodar.bat --animado              # pega um roteiro da fila ou o Gemini escreve um diálogo
.\rodar.bat --animado --lote 3     # 3 desenhos seguidos
.\rodar.bat --animado roteiros_animados\meu_causo.json
```

Como funciona:
1. **Roteiro em diálogo**: fila `roteiros_animados\` (no projeto ou no Drive), o mais antigo primeiro;
   se estiver vazia, o Gemini escreve. Formato no `roteiros_animados\prova_o_ouro_do_rio.json`.
2. **Vozes**: uma para cada personagem (`config\serie.yaml` → `animacao.vozes`). Padrão: vozes da
   Microsoft (edge-tts). Sem internet, usa as vozes offline do Piper.
3. **Boca**: o Rhubarb Lip Sync escuta cada fala e diz qual das 9 bocas usar a cada instante.
4. **Arte**: `midia\retratos\vo_e_lucas\` é a imagem publicada. O robô apaga só a boca e os olhos,
   desenha as bocas no mesmo traço e devolve o bigode do Vô por cima. O resto fica idêntico.
5. **Vídeo vertical 1080x1920** com título, legenda, close em quem fala; textos de cada rede no
   `PACOTE.txt` e aviso no Telegram, igual aos curtos.

**Nova imagem (retrato)**: crie `midia\retratos\<nome>\` com `base.jpg` e um `retrato.json` como o
do `vo_e_lucas` (centro e largura da boca, área a apagar, olhos e rosto de cada personagem).
O instalar.bat baixa o Rhubarb e as vozes offline (`python ferramentas\baixar.py`, com hash conferido).

---

## 7. Para quem for mexer no código

```powershell
.venv\Scripts\activate
python -m pytest -q        # 5 testes, inclusive um episódio inteiro em modo teste
python -m robo --teste     # gera um episódio sem internet
```

- Um robô = um arquivo em `robo/agentes/`, com uma função pública só.
- Nenhuma chave no código: tudo vem do `.env` ou dos *Secrets* do GitHub.
- Todo serviço externo tem tentativas com espera, e o modo teste substitui todos eles.
