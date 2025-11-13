# Copilot Instructions for AI Agents

## Visão Geral da Arquitetura
Este projeto é um backend Node.js para previsões de jogos, estruturado em componentes modulares:
- **backend/app.js**: Ponto de entrada do servidor Express. Registra rotas e inicializa o serviço.
- **backend/routes/predictions.js**: Define rotas REST para obter e atualizar previsões.
- **backend/services/predictionService.js**: Orquestra coleta de dados externos e interação com o modelo de ML.
- **backend/models/predictionModel.js**: Implementa o modelo de machine learning usando TensorFlow.js.

Fluxo principal:
1. Requisições chegam via rotas `/api/predictions` e `/api/update-predictions`.
2. O serviço coleta dados de APIs externas (Betano) e repassa ao modelo.
3. O modelo retorna previsões ou atualiza seus parâmetros.

## Convenções e Padrões
- **Estrutura de pastas**: Siga a separação por responsabilidade (routes, services, models).
- **Importação de dependências**: Use `@tensorflow/tfjs` (não `-node`) para evitar problemas nativos no Windows.
- **Dados de entrada do modelo**: Estrutura esperada: `{ inputs: [[...]], outputs: [[...]] }`.
- **Tratamento de erros**: Retorne sempre JSON com chave `error` em falhas nas rotas.
- **Logs**: Use `console.log` para depuração em pontos críticos (inicialização, importação de rotas, subida do servidor).

## Workflows Essenciais
- **Instalação**:
  ```sh
  npm install express @tensorflow/tfjs node-fetch body-parser
  ```
- **Execução**:
  ```sh
  node backend/app.js
  ```
- **Testes manuais**: Use Postman ou navegador para acessar as rotas REST.

## Integrações e Dependências
- **APIs externas**: O serviço consome dados das APIs da Betano para Aviator e Mines.
- **TensorFlow.js**: O modelo é simples, mas pode ser expandido. Ajuste o shape dos dados conforme necessário.

## Exemplos de Padrão
- Rotas REST:
  ```js
  router.get('/predictions', async (req, res) => { ... });
  ```
- Serviço:
  ```js
  const getPredictions = async () => { return await predict(); };
  ```
- Modelo:
  ```js
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape: [10] }));
  ```

## Arquivos-Chave
- `backend/app.js`: Inicialização do servidor
- `backend/routes/predictions.js`: Rotas principais
- `backend/services/predictionService.js`: Lógica de negócio
- `backend/models/predictionModel.js`: Modelo ML

---

Se algum padrão ou fluxo não estiver claro, peça exemplos ou esclarecimentos para manter a produtividade do agente.