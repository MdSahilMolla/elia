@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scan_vm.ps1"
echo Scan finished. Results saved to scan_results.txt
