@echo off
REM ============================================================================
REM  KuvaConnect - Panel con IMPRESION DIRECTA
REM
REM  Abre el panel de moderacion en una ventana propia de Chrome con
REM  --kiosk-printing: el boton "Imprimir" manda la foto directo a la impresora
REM  PREDETERMINADA de Windows, sin abrir el dialogo de impresion.
REM
REM  Antes de usarlo, una sola vez en este computador:
REM    1. La DNP tiene que ser la impresora predeterminada de Windows.
REM    2. En las preferencias de la DNP: papel 4x6 (PC 4x6) y sin bordes.
REM
REM  Usa un perfil de Chrome aparte (KuvaConnectPrint) para que funcione aunque
REM  el Chrome normal ya este abierto.
REM ============================================================================

set "URL=https://kuvaconnect.vercel.app/admin"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo No se encontro Google Chrome en este computador.
  pause
  exit /b 1
)

start "" "%CHROME%" --kiosk-printing --user-data-dir="%LocalAppData%\KuvaConnectPrint" --app=%URL%
