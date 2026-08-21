# PowerShell port scanner for 192.168.56.10
# Scans ports 1-1024 and logs open ports to scan_results.txt

$target = "192.168.56.10"
$logFile = "scan_results.txt"

# Ensure log file is empty
"Port Scan Results for $target" | Out-File -FilePath $logFile -Encoding utf8
"Timestamp: $(Get-Date)" | Out-File -FilePath $logFile -Append -Encoding utf8
"---" | Out-File -FilePath $logFile -Append -Encoding utf8

foreach ($port in 1..1024) {
    $result = Test-NetConnection -ComputerName $target -Port $port -InformationLevel Quiet
    if ($result) {
        "Port $port is OPEN" | Out-File -FilePath $logFile -Append -Encoding utf8
    }
}

"---" | Out-File -FilePath $logFile -Append -Encoding utf8
"Scan completed at $(Get-Date)" | Out-File -FilePath $logFile -Append -Encoding utf8
