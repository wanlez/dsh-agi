@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Uninstall dsh-agi from this DSH profile. The experience library stays.
rem Needs Node.js on PATH; otherwise use the plugin manager inside DeepSeek Harness.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [dsh-agi] 找不到 Node.js，无法运行卸载脚本。
  echo 请在 DeepSeek Harness 的插件管理里卸载 dsh-agi，或装好 Node.js 后再双击本文件。
  echo.
  pause
  exit /b 1
)

node "%~dp0uninstall.mjs" %*
echo.
pause
