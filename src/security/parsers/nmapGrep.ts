/**
 * Plain nmap output — what `run_security_tool` captures when the command was
 * `nmap …` without `-oX`.
 *
 * The row is `22/tcp open ssh 2.4.7p1 Ubuntu`: the port and protocol, the
 * state, the service name, then everything the fingerprint reported. Splitting
 * it that way keeps `service` comparable with the XML parser and keeps the
 * trailing tokens as one version string rather than pretending the second word
 * is the whole of it.
 */

export interface NmapGrepRow {
  port: number
  protocol: string
  state: string
  service: string
  version: string
}

const ROW_PATTERN = /^(\d{1,5})\/([A-Za-z][\w-]*)\s+(\S+)(?:\s+(\S+))?(?:\s+(.*))?$/

/**
 * Every service row in nmap's plain output. Lines that are not rows — the
 * `$ nmap …` command header, the scope note, banner lines, `Nmap done at …` —
 * are skipped, and a port range (`1-1024/tcp`, which only appears in `-oG`
 * summary mode) is not expanded: inventing 1024 rows nmap did not print would
 * be worse than reporting none.
 */
export function parseNmapGrep(text: string): NmapGrepRow[] {
  const rows: NmapGrepRow[] = []
  for (const line of text.split('\n')) {
    const match = ROW_PATTERN.exec(line.trim())
    if (!match) continue
    const port = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    rows.push({
      port,
      protocol: (match[2] ?? '').toLowerCase(),
      state: match[3] ?? '',
      service: match[4] ?? '',
      version: (match[5] ?? '').trim(),
    })
  }
  return rows
}
