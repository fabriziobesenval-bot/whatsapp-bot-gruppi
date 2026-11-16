@echo off
title Bot WhatsApp gruppi
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js non trovato: installalo da https://nodejs.org & pause & exit /b)
if not exist node_modules (
  echo Prima installazione, attendi qualche minuto...
  call npm install
)
start "" http://localhost:3001
node bot.js
pause
