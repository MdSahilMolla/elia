# Lab VM Engagement

**Target VM:** `192.168.56.10`

This scaffold provides a simple PowerShell script to perform a port scan of the target and log the discovered open ports.

- `scan_vm.ps1` – Scans ports 1‑1024 (common ports) using `Test-NetConnection`.
- `run_scan.bat` – Convenience batch file to execute the scan and store results in `scan_results.txt`.

The script logs each open port to `scan_results.txt` in the same directory.
