# Licenças de terceiros

O MUDO é construído com os componentes abaixo. Os textos completos das licenças acompanham cada
pacote dentro da instalação (`resources/app.asar` / `node_modules`).

## Componentes embarcados

- **Electron 45.3.3** (MIT) e **Chromium** (BSD e outras): https://www.electronjs.org
- **FFmpeg / FFprobe** (binários estáticos via ffmpeg-static/ffprobe-static; build GPL v3). O código-fonte
  correspondente está em https://ffmpeg.org e nos repositórios dos pacotes; pedidos de fonte são atendidos
  conforme a GPL.
- **whisper.cpp** v1.9.5 (MIT): https://github.com/ggml-org/whisper.cpp — modelo `ggml-base` (MIT, OpenAI Whisper).
- **CLIP ViT-B/32** em ONNX (`Xenova/clip-vit-base-patch32`, MIT, OpenAI CLIP).
- **Fontes** Anton e Archivo Black — SIL Open Font License 1.1 (arquivos OFL em `assets/fonts`).
- **Trilhas embutidas**: sintetizadas pelo próprio MUDO (licença própria).

## Pacotes npm de produção

| Pacote | Versão | Licença |
|---|---|---|
| @anthropic-ai/sdk | 1.9.0 | Apache-2.0 |
| @babel/runtime | 7.29.14 | MIT |
| @derhuerst/http-basic | 8.2.4 | MIT |
| @huggingface/jinja | 0.5.13 | MIT |
| @huggingface/tokenizers | 0.2.0 | Apache-2.0 |
| @huggingface/transformers | 4.3.2 | Apache-2.0 |
| @img/colour | 1.1.0 | MIT |
| @img/sharp-libvips-linux-x64 | 1.3.4 | LGPL-3.0-or-later |
| @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 |
| @opentelemetry/api | 1.10.0 | Apache-2.0 |
| @pinojs/redact | 0.4.0 | MIT |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause |
| @protobufjs/float | 1.0.2 | BSD-3-Clause |
| @protobufjs/path | 1.1.2 | BSD-3-Clause |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause |
| @stablelib/base64 | 1.0.1 | MIT |
| @types/node | 26.6.6 | MIT |
| @types/node | 10.17.60 | MIT |
| adm-zip | 0.6.1 | MIT |
| agent-base | 6.0.2 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| better-sqlite3 | 13.2.0 | MIT |
| buffer-from | 1.1.2 | MIT |
| caseless | 0.12.0 | Apache-2.0 |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| concat-stream | 2.0.0 | MIT |
| date-fns | 4.4.0 | MIT |
| debug | 4.4.3 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-properties | 1.2.1 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| drizzle-orm | 0.45.4 | Apache-2.0 |
| env-paths | 2.2.1 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| escape-string-regexp | 4.0.0 | MIT |
| fast-sha256 | 1.3.0 | Unlicense |
| ffmpeg-static | 5.3.0 | GPL-3.0-or-later |
| ffprobe-static | 3.1.0 | MIT |
| flatbuffers | 25.9.23 | Apache-2.0 |
| global-agent | 4.1.7 | BSD-3-Clause |
| globalthis | 1.0.4 | MIT |
| gopd | 1.2.0 | MIT |
| guid-typescript | 1.0.9 | ISC |
| has-property-descriptors | 1.0.2 | MIT |
| http-response-object | 3.0.2 | MIT |
| https-proxy-agent | 5.0.1 | MIT |
| inherits | 2.0.4 | ISC |
| json-schema-to-ts | 3.1.1 | MIT |
| long | 5.3.2 | Apache-2.0 |
| lucide-react | 1.73.0 | ISC |
| matcher | 4.0.0 | MIT |
| ms | 2.1.3 | MIT |
| node-addon-api | 8.9.2 | MIT |
| object-keys | 1.1.1 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| onnxruntime-common | 1.30.0 | MIT |
| onnxruntime-common | 1.31.0-dev.20260911-2a43ec07e | MIT |
| onnxruntime-node | 1.30.0 | MIT |
| onnxruntime-web | 1.31.0-dev.20260914-8d85527a0 | MIT |
| parse-cache-control | 1.0.1 | BSD |
| pino | 10.4.0 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-roll | 4.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| platform | 1.3.6 | MIT |
| process-warning | 5.1.1 | MIT |
| progress | 2.0.3 | MIT |
| protobufjs | 7.6.6 | BSD-3-Clause |
| quick-format-unescaped | 4.0.4 | MIT |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| readable-stream | 3.6.2 | MIT |
| real-require | 1.0.0 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| scheduler | 0.28.0 | MIT |
| semver | 7.8.6 | ISC |
| serialize-error | 8.1.0 | MIT |
| sharp | 0.35.5 | Apache-2.0 |
| sonic-boom | 4.2.1 | MIT |
| split2 | 4.2.0 | ISC |
| standardwebhooks | 1.1.1 | MIT |
| string_decoder | 1.1.1 | MIT |
| tailwind-merge | 3.7.0 | MIT |
| thread-stream | 4.2.1 | MIT |
| ts-algebra | 2.0.0 | MIT |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) |
| typedarray | 0.0.6 | MIT |
| undici-types | 8.9.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| zod | 4.6.7 | MIT |
