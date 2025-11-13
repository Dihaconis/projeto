const tf = require('@tensorflow/tfjs');

// Modelo sequencial simples
const model = tf.sequential();
model.add(tf.layers.dense({ units: 5, inputShape: [10], activation: 'relu' }));
model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

model.compile({
    optimizer: 'sgd',
    loss: 'binaryCrossentropy'
});

console.log('Modelo de ML inicializado.');

/**
 * Gera uma previsão com base nos dados de entrada.
 * @param {number[]} inputData - Array de números para a previsão.
 * @returns {Promise<any>} - A previsão do modelo.
 */
const predict = async (inputData) => {
    if (!inputData || inputData.length !== 10) {
        throw new Error('Dados de entrada inválidos. Esperado um array com 10 elementos.');
    }
    const predictionTensor = tf.tidy(() => {
        const tensor = tf.tensor2d([inputData]);
        return model.predict(tensor);
    });
    const data = await predictionTensor.data();
    predictionTensor.dispose(); // Limpa o tensor de predição final
    return { prediction: data[0] };
};

/**
 * Treina o modelo com os dados fornecidos.
 * @param {{inputs: number[][], outputs: number[][]}} trainingData - Dados para treinamento.
 * @returns {Promise<{status: string, loss: number}>} - O status do treinamento.
 */
const train = async (trainingData) => {
    // Adiciona validação para garantir que os dados de treinamento são válidos
    if (!trainingData || !trainingData.inputs || !trainingData.outputs) {
        throw new Error('Dados de treinamento inválidos. A estrutura esperada é { inputs: [...], outputs: [...] }.');
    }

    const { inputs, outputs } = trainingData;    
    const history = tf.tidy(() => {
        const xs = tf.tensor2d(inputs);
        const ys = tf.tensor2d(outputs);
        return model.fit(xs, ys, { epochs: 10 });
    });
    return { status: 'Treinamento concluído', loss: (await history).history.loss[0] };
};

module.exports = { predict, train };