@echo off
chcp 65001 > nul
cd /d "%~dp0"

set "TARGET=%~dp0启动下载器.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\油管下载器.lnk"
set "WORKDIR=%~dp0"
set "ICON=%~dp0frontend\favicon.ico" 

echo 正在创建桌面快捷方式...
echo 目标: %TARGET%

powershell "$s=(New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT%');$s.TargetPath='%TARGET%';$s.WorkingDirectory='%WORKDIR%';$s.IconLocation='shell32.dll,14';$s.Save()"

echo.
echo ==========================================
echo    ✅ 快捷方式已创建！
echo    请查看桌面上的 [油管下载器] 图标
echo ==========================================
echo.
pause
