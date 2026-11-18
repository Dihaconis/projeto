# Verifica a instalação do MUDO no Windows e imprime um relatório.
# Não mostra nenhuma chave de API: só os NOMES das chaves configuradas.
# Uso (PowerShell):  powershell -ExecutionPolicy Bypass -File verificar-instalacao.ps1

$ok = 0; $falhas = 0
function Item($nome, $passou, $detalhe = '') {
  if ($passou) { $script:ok++; Write-Host "[OK]    $nome $detalhe" -ForegroundColor Green }
  else { $script:falhas++; Write-Host "[FALHA] $nome $detalhe" -ForegroundColor Red }
}

Write-Host "`n== Instalação ==" -ForegroundColor Cyan
$reg = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'MUDO*' } | Select-Object -First 1
$dir = $null
if ($reg) {
  $dir = $reg.InstallLocation
  Item 'Registro de instalação' $true "($($reg.DisplayName) $($reg.DisplayVersion))"
  Item 'Instalado só para o usuário (sem admin)' ($reg.PSPath -like '*HKEY_CURRENT_USER*')
} else {
  Item 'Registro de instalação' $false '(não achei; se usa a versão Portable, isso é normal)'
}
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Programs\MUDO' }
Write-Host "        Pasta: $dir"
$res = Join-Path $dir 'resources'
Item 'MUDO.exe' (Test-Path (Join-Path $dir 'MUDO.exe'))
Item 'Não está em Arquivos de Programas' (-not ($dir -like "$env:ProgramFiles*"))
foreach ($f in 'app.asar', 'bin\ffmpeg.exe', 'bin\ffprobe.exe', 'bin\whisper-cli.exe', 'bin\yt-dlp.exe',
  'models\ggerganov\whisper.cpp\ggml-base.bin', 'models\Xenova\clip-vit-base-patch32\onnx\vision_model_quantized.onnx',
  'migrations\meta\_journal.json', 'cli\mudo.cmd') {
  Item $f (Test-Path (Join-Path $res $f))
}

Write-Host "`n== Dados do usuário ==" -ForegroundColor Cyan
$data = Join-Path $env:APPDATA 'MUDO'
Write-Host "        Pasta: $data"
Item 'Banco de dados (mudo.db)' (Test-Path (Join-Path $data 'mudo.db')) '(criado ao abrir o app pela 1ª vez)'
$cfg = Join-Path $data 'config.json'
if (Test-Path $cfg) {
  $nomes = @((Get-Content $cfg -Raw | ConvertFrom-Json).secrets.PSObject.Properties.Name)
  Item 'Chaves salvas (cifradas)' ($nomes.Count -gt 0) "($($nomes -join ', '))"
  $temLlm = @($nomes | Where-Object { $_ -in 'anthropic', 'openai', 'gemini' }).Count -gt 0
  $temTts = @($nomes | Where-Object { $_ -in 'elevenlabs', 'openai', 'azure' }).Count -gt 0
  Item 'Chave de roteiro (Anthropic/OpenAI/Gemini)' $temLlm
  Item 'Chave de narração (ElevenLabs/OpenAI/Azure)' $temTts
} else {
  Item 'Chaves salvas' $false '(nenhuma ainda: Configurações > Chaves)'
}

Write-Host "`n== CLI ==" -ForegroundColor Cyan
$cli = Join-Path $res 'cli\mudo.cmd'
if (Test-Path $cli) {
  $canais = & $cli channel list --json 2>&1
  if ($LASTEXITCODE -eq 0) {
    $lista = @($canais | ConvertFrom-Json)
    Item 'CLI responde' $true
    Item 'Pelo menos um canal criado' ($lista.Count -gt 0) "($($lista.Count) canal(is))"
  } else { Item 'CLI responde' $false "($canais)" }
  & $cli quota
}

Write-Host "`n== Últimos erros nos logs ==" -ForegroundColor Cyan
$logs = Join-Path $data 'logs'
if (Test-Path $logs) {
  $erros = Get-ChildItem $logs -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 |
    ForEach-Object { Select-String -Path $_.FullName -Pattern '"level":50|startup-error|Error' -SimpleMatch:$false } | Select-Object -Last 5
  if ($erros) { $erros | ForEach-Object { Write-Host "  $($_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)))" } }
  else { Write-Host '  nenhum erro recente' }
}

Write-Host "`nResultado: $ok OK, $falhas falha(s)." -ForegroundColor Cyan
