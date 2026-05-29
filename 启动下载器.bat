@echo off
chcp 65001 > nul
cd /d "%~dp0"
title YouTube 下载器服务 (关闭窗口以停止)
color 0A

echo ===================================================
echo      正在启动 YouTube 下载器服务...
echo      请勿关闭此黑色窗口，否则服务将停止！
echo ===================================================

rem 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

rem 安装依赖（如果需要）
if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    npm install
)

rem 启动浏览器访问
timeout /t 2 > nul
start "" "http://localhost:19999"

rem 启动后端服务
node src/server.js

rem 服务结束
pause
