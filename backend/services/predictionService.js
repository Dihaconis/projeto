const predictionModel = require('../models/predictionModel');

/**
 * Busca as previsões do modelo.
 */
const getPredictions = async () => {
    console.log('Serviço: Obtendo previsões do modelo.');
    // Simula a coleta de dados de uma API externa e passa para o modelo
    const externalData = Array.from({ length: 10 }, () => Math.random());
    return await predictionModel.predict(externalData);
};

/**
 * Atualiza o modelo com novos dados.
 */
const updatePredictions = async (data) => {
    console.log('Serviço: Atualizando modelo com novos dados.');
    return await predictionModel.train(data);
};

module.exports = { getPredictions, updatePredictions };