@echo off
chcp 65001 > nul
cd /d "%~dp0"
title YouTube 下载器服务 (关闭窗口以停止)
color 0A

echo ===================================================
echo      正在启动 YouTube 下载器服务...
echo      请勿关闭此黑色窗口，否则服务将停止！
echo ===================================================

rem 启动浏览器访问
timeout /t 2 > nul
start "" "http://localhost:19999"

rem 启动后端服务
python backend/main.py

rem 服务结束
pause
