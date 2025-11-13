const tf = require('@tensorflow/tfjs');

const model = tf.sequential();
model.add(tf.layers.dense({ units: 1, inputShape: [10] }));
model.compile({ loss: 'meanSquaredError', optimizer: 'sgd' });

const train = async (data) => {
  // Lógica de treinamento do modelo
  const xs = tf.tensor2d(data.inputs);
  const ys = tf.tensor2d(data.outputs);
  await model.fit(xs, ys, { epochs: 10 });
  return Array.from(model.predict(xs).dataSync());
};

const predict = async () => {
  // Lógica de previsão
  const input = tf.tensor2d([[0,0,0,0,0,0,0,0,0,0]]);
  return Array.from(model.predict(input).dataSync());
};

module.exports = { model, train, predict };