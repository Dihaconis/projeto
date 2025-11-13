const express = require('express');
const router = express.Router();
const predictionService = require('../services/predictionService');

router.get('/predictions', async (req, res) => {
  try {
    const predictions = await predictionService.getPredictions();
    res.json(predictions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter previsões' });
  }
});

router.get('/update-predictions', async (req, res) => {
  try {
    const updatedPredictions = await predictionService.updatePredictions();
    res.json(updatedPredictions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar previsões' });
  }
});

module.exports = router;