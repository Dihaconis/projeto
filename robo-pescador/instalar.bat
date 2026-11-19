@echo off
chcp 65001 >nul
echo === Instalando o Robo do Pescador ===
where python >nul 2>nul || (echo Python nao encontrado. Rode: winget install Python.Python.3.12 & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo FFmpeg nao encontrado. Rode: winget install --id Gyan.FFmpeg & pause & exit /b 1)
python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if not exist .env copy .env.example .env
echo.
echo Pronto. Abra o arquivo .env no Bloco de Notas e cole sua GEMINI_API_KEY.
echo Depois rode: rodar.bat --teste   (teste sem internet)
echo e depois:    rodar.bat           (episodio de verdade)
pause
