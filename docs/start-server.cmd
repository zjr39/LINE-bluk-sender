@echo off
chcp 65001 >nul
title LINE 批量粘貼 — 本機服務
cd /d "%~dp0"

echo ================================================
echo    LINE 聯絡人批量粘貼 — 本機服務
echo ================================================
echo.
echo    這個黑色視窗要一直開著。
echo    關掉它 = 面板會失效（再點書籤就沒反應）。
echo.
echo    要結束服務：直接關閉這個視窗，或按 Ctrl+C。
echo.
echo ------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 goto :install_node

:run
echo [1/1] 啟動服務中…
echo.
node "%~dp0server\server.js"
echo.
echo 服務已結束。
pause
exit /b 0

:install_node
echo [!] 這台電腦沒有偵測到 Node.js，這是面板需要的執行環境。
echo.
echo     接下來會嘗試用 winget 自動安裝（需要網路，約 1 分鐘）。
echo     如果不想自動安裝，請按 Ctrl+C 取消，改到 https://nodejs.org 下載安裝。
echo.
pause

where winget >nul 2>nul
if errorlevel 1 goto :no_winget

echo 正在安裝 Node.js…
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo 安裝完成後，請關閉這個視窗，再重新雙擊一次 start-server.cmd。
pause
exit /b 0

:no_winget
echo [X] 這台電腦也沒有 winget，無法自動安裝。
echo.
echo     請手動到 https://nodejs.org/ 下載「LTS」版本安裝，
echo     安裝時一路按「Next」即可，完成後重新雙擊 start-server.cmd。
echo.
pause
exit /b 1
