@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Enable dsh-agi in this DSH profile: adds the loader entry that `dsh plugin add` leaves out.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [dsh-agi] 找不到 Node.js，无法自动启用。
  echo 请在 DeepSeek Harness 的插件管理里安装/启用 dsh-agi。
  echo.
  pause
  exit /b 1
)

node "%~dp0install.mjs" %*
echo.
pause
