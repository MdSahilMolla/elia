# Findings for 115.187.36.69

## 1. IP Information
- **IP:** 115.187.36.69
- **Hostname:** node-115-187-36-69.alliancebroadband.in
- **Location:** Kolkata, West Bengal, India (postal 700001)
- **Organization:** AS23860 Alliance Broadband Services Pvt. Ltd.
- **Timezone:** Asia/Kolkata

## 2. Web Service (Port 80)
- **Port:** 80 (open)
- **Service:** HTTP (Server header: freenginx/1.28.0)
- **Response:** HTTP/1.1 200 OK, content length 807 bytes, cache‑control: no‑cache, no‑store, must‑revalidate.
- **Evidence:** `workspace/engagements/ip-analysis-2026-08-18/recon/` (no raw file saved, but the response was captured via `curl -I`).

## 3. HTTPS (Port 443)
- **Port:** 443 (closed / no response)
- **Evidence:** `curl -I https://115.187.36.69` timed out (curl error 28).

## 4. Other Common Ports (21,22,25,8080,3306,3389)
- No evidence of open services; attempts to probe via `Test-NetConnection` did not return results (environment limitations).

## Recommendations
- Verify the HTTP service; the unusual server header (`freenginx`) may indicate a custom or mis‑configured web server.
- Conduct a full, authorized port scan (e.g., nmap) when tools are available to confirm the status of other ports.
- Review the web application for common vulnerabilities (e.g., directory listing, default pages, outdated software).
