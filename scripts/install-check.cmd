@echo off
rem 双击即可跑装机前置检查（绕执行策略，不改系统设置）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-check.ps1"
pause
