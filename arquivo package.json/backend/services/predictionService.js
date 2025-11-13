const fetch = require('node-fetch');
const { model, train, predict } = require('../models/predictionModel');

const getPredictions = async () => {
  // Lógica para obter previsões do modelo de machine learning
  return await predict();
};

const updatePredictions = async () => {
  // Lógica para atualizar previsões com novos dados
  const newData = await fetchData();
  return await train(newData);
};

const fetchData = async () => {
  // Lógica para coletar dados das casas de apostas
  const aviatorData = await fetchAviatorData();
  const minesData = await fetchMinesData();
  // Exemplo de estrutura esperada pelo modelo
  return {
    inputs: aviatorData.inputs || [[0,0,0,0,0,0,0,0,0,0]],
    outputs: aviatorData.outputs || [[0]],
  };
};

const fetchAviatorData = async () => {
  // Implementar web scraping ou API para coletar dados de Aviator
  try {
    const response = await fetch('https://api.betano.com/games/aviator');
    const data = await response.json();
    return data;
  } catch (error) {
    return { inputs: [[0,0,0,0,0,0,0,0,0,0]], outputs: [[0]] };
  }
};

const fetchMinesData = async () => {
  // Implementar web scraping ou API para coletar dados de Mines
  try {
    const response = await fetch('https://api.betano.com/games/mines');
    const data = await response.json();
    return data;
  } catch (error) {
    return { inputs: [[0,0,0,0,0,0,0,0,0,0]], outputs: [[0]] };
  }
};

module.exports = { getPredictions, updatePredictions };