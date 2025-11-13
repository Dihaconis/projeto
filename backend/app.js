const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const predictionsRouter = require('./routes/predictions');

console.log('Inicializando a aplicação...');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

app.use(bodyParser.json());

console.log('Registrando rotas de previsões...');
app.use('/api', predictionsRouter);

app.get('/', (req, res) => {
    res.send('Servidor de previsões no ar!');
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});