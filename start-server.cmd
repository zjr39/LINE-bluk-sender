@echo off
chcp 65001 >nul
title LINE 批量粘貼 — 本機服務
cd /d "%~dp0"

echo ============================================
echo   LINE 聯絡人批量粘貼 — 本機服務
echo ============================================
echo.
echo   面板腳本： http://127.0.0.1:8765/snippet.js
echo   狀態查詢： http://127.0.0.1:8765/state
echo.
echo   這個視窗要一直開著；關掉視窗 = 面板會失效。
echo   要停止服務，直接關閉這個視窗或按 Ctrl+C。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 node，請先安裝 Node.js 後再執行。
  pause
  exit /b 1
)

node "server\server.js"

echo.
echo 服務已結束。
pause
