(async () => {
  // tenta usar node-fetch, se não existir assume global fetch (Node 18+)
  let fetchFn;
  try {
    fetchFn = require('node-fetch');
  } catch (e) {
    fetchFn = global.fetch;
  }

  const base = 'http://localhost:3001';
  try {
    // GET
    const getRes = await fetchFn(`${base}/api/predictions`);
    const getJson = await getRes.json();
    console.log('GET /api/predictions ->', getJson);

    // POST (treino)
    const payload = {
      inputs: [
        [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], // 10 valores de entrada
        [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1]  // 10 valores de entrada
      ],
      outputs: [[1], [0]] // Saídas correspondentes no formato correto
    };
    const postRes = await fetchFn(`${base}/api/update-predictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const postJson = await postRes.json();
    console.log('POST /api/update-predictions ->', postJson);
  } catch (err) {
    console.error('Erro nos testes HTTP:', err && err.stack ? err.stack : err);
  }
})();
