import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSecurityTriage, securityTriageTool, detectScanFormat, resolveReconLogPath, triageLogContent, type TriageContext } from './securityTriage.ts'
import { parseNmapXml } from '../security/parsers/nmap.ts'
import { parseNmapGrep } from '../security/parsers/nmapGrep.ts'
import { parseNucleiJsonl } from '../security/parsers/nuclei.ts'

const SLUG = 'acme-webapp-2026'
const SECRET = 'SUPERSECRETSESSIONVALUE1234'

const NMAP_XML_LOG = `$ nmap -sV -oX - app.acme.test
scope-check: app.acme.test verified in SCOPE.md

<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" args="nmap -sV -oX - app.acme.test" start="1699999999" version="7.94">
  <host>
    <status state="up" reason="echo-reply"/>
    <address addr="10.0.0.5" addrtype="ipv4"/>
    <hostnames><hostname name="app.acme.test" type="user"/></hostnames>
    <ports>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack" reason_ttl="64"/>
        <service name="ssh" product="OpenSSH" version="8.9p1" extrainfo="Ubuntu Linux" method="probed" conf="10"/>
      </port>
      <port protocol="tcp" portid="443">
        <state state="open" reason="syn-ack" reason_ttl="64"/>
        <service name="https" product="nginx" version="1.18.0" tunnel="ssl" method="probed" conf="3"/>
      </port>
      <port protocol="tcp" portid="8080">
        <state state="closed" reason="conn-refused" reason_ttl="0"/>
        <service name="http-proxy" method="table" conf="3"/>
      </port>
    </ports>
    <os><osmatch name="Linux 4.15 - 5.6" accuracy="95"/></os>
  </host>
  <host>
    <status state="up" reason="arp-response"/>
    <address addr="10.0.0.6" addrtype="ipv4"/>
    <ports>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack"/>
        <service name="ssh" product="OpenSSH" version="9.6p1" extrainfo="Debian Linux 12" method="probed" conf="10"/>
      </port>
    </ports>
  </host>
</nmaprun>
`

const NMAP_TEXT_LOG = `$ nmap -sV app.acme.test
scope-check: app.acme.test verified in SCOPE.md

Nmap scan report for app.acme.test (10.0.0.5)
Host is up (0.000s latency).
22/tcp open ssh OpenSSH 8.9p1 Ubuntu Linux
443/tcp open ssl/http nginx 1.18.0
8443/tcp closed https
Nmap done at Mon Sep 11 07:53:34 2023
`

const NUCLEI_LOG = `$ nuclei -jsonl -u https://app.acme.test
scope-check: app.acme.test verified in SCOPE.md
{"template-id":"CVE-2021-41773","info":{"name":"Apache path traversal","severity":"critical","tags":["cve"]},"type":"http","host":"https://app.acme.test","matched-at":"https://app.acme.test/cgi-bin/x?session=${SECRET}","extracted-results":["session=${SECRET}","root:x:0:0"],"matcher-name":"apache-path-traversal","timestamp":"2026-08-20T10:00:00Z"}
{"template-id":"CVE-2021-41773","info":{"name":"Apache path traversal","severity":"critical"},"type":"http","host":"https://10.0.0.6","matched-at":"https://10.0.0.6/cgi-bin/x","extracted-results":[],"matcher-name":"apache-path-traversal"}
{"template-id":"tech-detect","info":{"name":"Technology Detection","severity":"info"},"type":"http","host":"https://app.acme.test","matched":"https://app.acme.test/"}
{"template-id":"truncated-by-an-interrupted","info":{"name":"Half written
{"template-id":"missing-severity","info":{"name":"No severity recorded"},"type":"http","host":"https://app.acme.test","matched-at":"https://app.acme.test/x"}
`

const UNKNOWN_LOG = `$ file app.exe
scope-check: no network target detected in the command - nothing was verified against SCOPE.md
ELF 64-bit LSB executable, x86-64, dynamically linked, stripped
`

let workspace: string
let ctx: TriageContext

function writeRecon(name: string, body: string) {
  const dir = join(workspace, 'engagements', SLUG, 'recon')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'sec-triage-'))
  ctx = { engagementRoot: workspace }
  mkdirSync(join(workspace, 'engagements', SLUG, 'recon'), { recursive: true })
  writeFileSync(join(workspace, 'engagements', SLUG, 'SCOPE.md'), '# Scope\napp.acme.test\n10.0.0.6\n')
  writeFileSync(join(workspace, 'engagements', SLUG, 'recon', '.gitkeep'), '')
  writeRecon('1699-nmap-full.log', NMAP_XML_LOG)
  writeRecon('1700-nmap-text.log', NMAP_TEXT_LOG)
  writeRecon('1701-nuclei.json.log', NUCLEI_LOG)
  writeRecon('1702-strings.log', UNKNOWN_LOG)
})

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('detectScanFormat', () => {
  it('decides by content, not by the filename', () => {
    expect(detectScanFormat(NMAP_XML_LOG)).toBe('nmap-xml')
    expect(detectScanFormat(NUCLEI_LOG)).toBe('nuclei-jsonl')
    expect(detectScanFormat(NMAP_TEXT_LOG)).toBe('nmap-grep')
    expect(detectScanFormat(UNKNOWN_LOG)).toBe('unknown')
  })

  it('refuses to read a JSON log that nuclei did not write', () => {
    expect(detectScanFormat('{"har":"log","entries":[]}')).toBe('unknown')
    expect(detectScanFormat('{"unterminated": ')).toBe('unknown')
  })
})

describe('triageLogContent', () => {
  it('reports the open/closed split, hostname and version from nmap XML', () => {
    const result = triageLogContent(NMAP_XML_LOG, 'recon/1699-nmap-full.log')
    expect(result.format).toBe('nmap-xml')
    expect(result.observed).toBe('2 host(s), 3 open of 4 probed port(s)')
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]!.title).toBe('2 open ports on app.acme.test')
    expect(result.findings[0]!.description).toContain('2 of 3 probed port(s) open, 1 closed or filtered')
    expect(result.findings[0]!.description).toContain('22/tcp open ssh OpenSSH 8.9p1 Ubuntu Linux')
    expect(result.findings[0]!.description).toContain('443/tcp open https nginx 1.18.0')
    expect(result.findings[1]!.title).toBe('1 open port on 10.0.0.6')
    expect(result.findings[0]!.evidence[0]!.kind).toBe('runtime_output')
    expect(result.findings[0]!.evidence[0]!.location).toBe('recon/1699-nmap-full.log')
    expect(result.findings[0]!.evidence[0]!.confidence).toBe(0.95)
  })

  it('never scores an open port as a high-severity finding', () => {
    for (const result of [triageLogContent(NMAP_XML_LOG, 'a.log'), triageLogContent(NMAP_TEXT_LOG, 'b.log')]) {
      for (const finding of result.findings) {
        expect(['low', 'medium']).toContain(finding.risk.level)
        expect(finding.severity).toBe(finding.risk.level)
        expect(finding.description).toContain('No vulnerability was verified by this scan')
      }
    }
  })

  it('reads plain nmap text into one surface and says so', () => {
    const result = triageLogContent(NMAP_TEXT_LOG, 'recon/1700-nmap-text.log')
    expect(result.format).toBe('nmap-grep')
    expect(result.observed).toBe('3 port row(s), 2 open')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.title).toContain('hosts not named in plain nmap output')
  })

  it('maps nuclei severity through and skips the malformed line without losing the good matches', () => {
    const result = triageLogContent(NUCLEI_LOG, 'recon/1701-nuclei.json.log')
    expect(result.observed).toBe('4 template match(es) across 3 template(s)')
    expect(result.findings).toHaveLength(3)
    expect(result.findings[0]!.title).toBe('Apache path traversal [critical]')
    expect(result.findings[0]!.description).toContain('2 match(es) of CVE-2021-41773 across 2 host(s)')
    expect(result.findings[0]!.severity).toBe('critical')
    expect(result.findings[0]!.risk.level).toBe('critical')
    expect(result.findings[0]!.evidence[0]!.description).toContain('matched 2 time(s) across 2 host(s)')
    expect(result.findings.map((finding) => finding.severity)).toEqual(['critical', 'info', 'unknown'])
    expect(parseNucleiJsonl(NUCLEI_LOG)).toHaveLength(4)
  })

  it('says a log it cannot recognise is unrecognised instead of inventing findings', () => {
    const result = triageLogContent(UNKNOWN_LOG, 'recon/1702-strings.log')
    expect(result.format).toBe('unknown')
    expect(result.findings).toEqual([])
    expect(result.note).toContain('not a recognised scan format')
    expect(result.note).toContain('read_file')
  })

  it('says a truncated nmap document parsed to nothing rather than reporting an empty host', () => {
    const result = triageLogContent('<?xml version="1.0"?><nmaprun><host><address addr="10.0.0.5"', 'recon/half.log')
    expect(result.format).toBe('nmap-xml')
    expect(result.findings).toEqual([])
    expect(result.note).toContain('truncated')
  })
})

describe('resolveReconLogPath', () => {
  it('accepts a bare filename and a recon/-prefixed one alike', () => {
    expect(resolveReconLogPath(join(workspace, 'engagements', SLUG), '1699-nmap-full.log')).toContain(join('recon', '1699-nmap-full.log'))
    expect(resolveReconLogPath(join(workspace, 'engagements', SLUG), 'recon/1699-nmap-full.log')).toContain(join('recon', '1699-nmap-full.log'))
    expect(resolveReconLogPath(join(workspace, 'engagements', SLUG), 'recon\\1699-nmap-full.log')).toContain(join('recon', '1699-nmap-full.log'))
  })

  it('refuses anything that resolves outside recon/', () => {
    const dir = join(workspace, 'engagements', SLUG)
    for (const attempt of ['../../etc/passwd', '../SCOPE.md', 'recon/../../SCOPE.md', join(workspace, 'engagements', 'other', 'SCOPE.md'), 'C:\\Windows\\win.ini', '/etc/passwd', '..', '.']) {
      expect(() => resolveReconLogPath(dir, attempt)).toThrow(/outside the engagement's recon\/ folder/)
    }
  })
})

describe('security_triage', () => {
  it('is registered under the name the registry will import it as', () => {
    expect(securityTriageTool.name).toBe('security_triage')
    expect(securityTriageTool.input_schema.required).toEqual(['engagement'])
  })

  it('turns an nmap XML log into structured facts rather than raw text', async () => {
    const out = await runSecurityTriage({ engagement: SLUG, log: '1699-nmap-full.log' }, ctx)
    expect(out).toContain('=== Security triage (read-only) ===')
    expect(out).toContain('Format detected: nmap-xml (nmap -oX)')
    expect(out).toContain('Observed: 2 host(s), 3 open of 4 probed port(s)')
    expect(out).toContain('2 open ports on app.acme.test')
    expect(out).toContain('[runtime_output]')
    expect(out).toContain('--- Summary (machine-readable) ---')
    expect(out).toContain('"format":"nmap-xml"')
    expect(out).not.toContain('<nmaprun')
  })

  it('triages every saved log when no log is named, and names what it skipped', async () => {
    const out = await runSecurityTriage({ engagement: SLUG }, ctx)
    expect(out).toContain('Logs read: 4')
    expect(out).toContain('Format detected: nmap-grep')
    expect(out).toContain('Format detected: nuclei-jsonl')
    expect(out).toContain('Format detected: unknown')
  })

  it('parses a nuclei log and keeps its own severity rather than re-deriving one', async () => {
    const out = await runSecurityTriage({ engagement: SLUG, log: '1701-nuclei.json.log' }, ctx)
    expect(out).toContain('Apache path traversal [critical]')
    expect(out).toContain('risk 79/100 (critical, confidence 95%)')
    expect(out).toContain('nuclei reported this template as "critical"')
    expect(out).not.toContain('truncated-by-an-interrupted')
  })

  it('returns the honest unknown-format message and invents nothing', async () => {
    const out = await runSecurityTriage({ engagement: SLUG, log: '1702-strings.log' }, ctx)
    expect(out).toContain('not a recognised scan format')
    expect(out).toContain('read_file')
    expect(out).toContain('"findingCount":0')
    expect(out).not.toMatch(/\[(HIGH|CRITICAL)\]/)
  })

  it('lists what is in recon/ when the requested log is missing', async () => {
    const out = await runSecurityTriage({ engagement: SLUG, log: '9999-does-not-exist.log' }, ctx)
    expect(out).toContain('recon/9999-does-not-exist.log does not exist')
    expect(out).toContain('1699-nmap-full.log')
    expect(out).toContain('1701-nuclei.json.log')
    expect(out).not.toContain('ENOENT')
  })

  it('refuses a log name that escapes the recon folder', async () => {
    for (const attempt of ['../../etc/passwd', '../SCOPE.md', 'recon/../SCOPE.md', join(workspace, 'engagements', SLUG, 'SCOPE.md'), '/etc/passwd', 'C:\\Windows\\win.ini']) {
      await expect(runSecurityTriage({ engagement: SLUG, log: attempt }, ctx)).rejects.toThrow(/outside the engagement's recon\/ folder/)
    }
  })

  it('never echoes a secret-shaped value out of a parsed log', async () => {
    const out = await runSecurityTriage({ engagement: SLUG, log: '1701-nuclei.json.log' }, ctx)
    expect(out).not.toContain(SECRET)
    expect(out).toContain('[REDACTED]')
    // The URL around the redacted value is still there, so the model can see
    // which request the match came from.
    expect(out).toContain('https://app.acme.test/cgi-bin/x')
  })

  it('reports a missing engagement instead of reading anything', async () => {
    const out = await runSecurityTriage({ engagement: 'no-such-engagement' }, ctx)
    expect(out).toContain('No engagement "no-such-engagement" found')
    expect(out).toContain('SCOPE.md')
  })

  it('reports an engagement with no saved recon output', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sec-triage-empty-'))
    try {
      mkdirSync(join(empty, 'engagements', 'bare'), { recursive: true })
      writeFileSync(join(empty, 'engagements', 'bare', 'SCOPE.md'), '# Scope\n')
      const out = await runSecurityTriage({ engagement: 'bare' }, { engagementRoot: empty })
      expect(out).toContain('No recon output saved for "bare"')
      expect(out).toContain('run_security_tool')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('rejects an empty engagement rather than triaging the workspace root', async () => {
    await expect(runSecurityTriage({ engagement: '  ' }, ctx)).rejects.toThrow(/engagement must be a non-empty string/)
  })
})

describe('parsers feeding triage', () => {
  it('agrees with the standalone parsers on what the fixtures contain', () => {
    expect(parseNmapXml(NMAP_XML_LOG).reduce((sum, host) => sum + host.openPorts.length, 0)).toBe(3)
    expect(parseNmapGrep(NMAP_TEXT_LOG)).toHaveLength(3)
    expect(parseNucleiJsonl(NUCLEI_LOG).filter((finding) => finding.templateId === 'CVE-2021-41773')).toHaveLength(2)
  })
})
