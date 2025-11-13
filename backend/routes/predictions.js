const express = require('express');
const router = express.Router();
const predictionService = require('../services/predictionService');

console.log('Rotas de previsões importadas.');

router.get('/predictions', async (req, res) => {
    try {
        const predictions = await predictionService.getPredictions();
        res.json(predictions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/update-predictions', async (req, res) => {
    try {
        const result = await predictionService.updatePredictions(req.body);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;