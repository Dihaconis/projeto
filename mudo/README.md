# MUDO

Gerador local de vídeo narrado para canal sem rosto (Windows). Electron + React + TypeScript + SQLite.

> **Estado: Fase 1 (esqueleto).** Fila persistente, runner em `utilityProcess`, migrações e um
> **job de teste** que percorre as etapas do pipeline sem gerar vídeo. O job de teste sai na Fase 2.

## Requisitos de desenvolvimento

- Node 22+ e npm
- Windows 10/11 x64 (alvo). Linux/macOS funcionam para desenvolvimento e testes.

```bash
npm install
npm run dev          # app com recarga
npm run typecheck
npm test             # unitários + integração (core, crash com kill -9)
npm run test:e2e     # build + e2e no app Electron real (Linux sem tela: usa xvfb-run)
```

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
