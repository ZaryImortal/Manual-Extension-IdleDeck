@echo off
chcp 65001 >nul
title Instalando Extensão no IdleDeck...
echo ========================================================
echo  Instalando Extensão nas contas do IdleDeck...
echo ========================================================
node "%~dp0instalar-no-idledeck.js"
echo.
pause
