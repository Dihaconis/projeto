console.log('Iniciando app.js...');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
console.log('Antes de importar as rotas...');
const predictionsRouter = require('./routes/predictions');
console.log('Rotas importadas com sucesso!');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/api', predictionsRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
