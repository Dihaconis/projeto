# Este script testa as rotas da API do backend.
# Execute-o com o servidor Node.js rodando.

# Define a URL base para o servidor.
# A variável foi nomeada '$baseUrl' para evitar conflito com a variável automática '$host' do PowerShell.
$baseUrl = "http://localhost:3001"

Write-Host "--- Testando a API em ${baseUrl} ---" -ForegroundColor Green


# --- Teste 1: GET /api/predictions ---
try {
    $predictionsUrl = "${baseUrl}/api/predictions"
    Write-Host "Enviando requisição GET para $predictionsUrl"
    $responseGet = Invoke-RestMethod -Uri $predictionsUrl -Method Get
    Write-Host "Resposta GET recebida:"
    $responseGet | ConvertTo-Json | Write-Host
} catch {
    Write-Host "Erro no teste GET: $_" -ForegroundColor Red
}

Write-Host "" # Linha em branco para separar os testes

# --- Teste 2: POST /api/update-predictions ---
try {
    $updateUrl = "${baseUrl}/api/update-predictions"
    $body = @{
        inputs = @(@(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0), @(0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1))
        outputs = @(@(1), @(0))
    } | ConvertTo-Json -Depth 3

    Write-Host "Enviando requisição POST para $updateUrl"
    $responsePost = Invoke-RestMethod -Uri $updateUrl -Method Post -Body $body -ContentType "application/json"
    Write-Host "Resposta POST recebida:"
    $responsePost | ConvertTo-Json | Write-Host
} catch {
    Write-Host "Erro no teste POST: $_" -ForegroundColor Red
}

Write-Host "--- Testes concluídos ---" -ForegroundColor Green