# Privacidade

- **Tudo fica no seu computador.** Banco de dados, vídeos, imagens, logs e configurações ficam em
  `%APPDATA%/MUDO` e na pasta de saída que você escolher. O MUDO não tem servidor próprio e não envia
  telemetria.
- **Chaves de API** ficam em `%APPDATA%/MUDO/config.json`, cifradas com o cofre do sistema
  (DPAPI no Windows, via `safeStorage` do Electron). Elas nunca aparecem em logs, no banco ou na
  interface.
- **O que vai para os provedores:**
  - Para o provedor de roteiro: o tema, o idioma, o nome e o nicho do canal, e o roteiro (na
    revisão).
  - Para o provedor de narração: o texto de cada cena.
  - Para os bancos de imagem: as buscas visuais das cenas.
  - Cada provedor trata esses dados conforme a política dele.
- **Embeddings de imagem** são calculados localmente (CLIP offline), a não ser que você escolha a
  OpenAI em Configurações.
- **Logs** (`%APPDATA%/MUDO/logs`) guardam eventos técnicos e erros, para diagnóstico. Eles nunca
  guardam chaves e você pode apagá-los quando quiser.
