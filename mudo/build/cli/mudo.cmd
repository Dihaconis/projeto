@echo off
rem CLI do MUDO: roda o core no próprio executável do app (modo Node), sem Node instalado.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\MUDO.exe" "%~dp0..\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
