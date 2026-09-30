import { describe, expect, it } from 'bun:test'
import { describePort, parseNmapXml } from './nmap.ts'
import { parseNmapGrep } from './nmapGrep.ts'
import { parseNucleiJsonl } from './nuclei.ts'

const NMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="nmap -sV -oX - acme.test" start="1699999999" version="7.94">
  <host starttime="1699999999" endtime="1700000005">
    <status state="up" reason="echo-reply"/>
    <address addr="10.0.0.5" addrtype="ipv4"/>
    <address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="Acme"/>
    <hostnames>
      <hostname name="app.acme.test" type="user"/>
    </hostnames>
    <ports>
      <extraports state="closed" count="998">
        <extrareasons>
          <reason type="resets" count="998"/>
        </extrareasons>
      </extraports>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack" reason_ttl="64"/>
        <service name="ssh" product="OpenSSH" version="8.9p1" extrainfo="Ubuntu Linux" ostype="Linux" method="probed" conf="10">
          <cpe>cpe:/a:openbsd:openssh:8.9p1</cpe>
        </service>
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
    <os>
      <portused state="open" proto="tcp" portid="22">
        <address addr="10.0.0.5" addrtype="ipv4"/>
      </portused>
      <osmatch name="Linux 4.15 - 5.6" accuracy="95" line="62311"/>
      <osmatch name="Linux 3.10 - 4.11" accuracy="88" line="56320"/>
    </os>
  </host>
  <host>
    <status state="up" reason="arp-response"/>
    <address addr="10.0.0.6" addrtype="ipv4"/>
    <ports>
      <port protocol="udp" portid="53">
        <state state="open|filtered" reason="no-response" reason_ttl="0"/>
        <service name="domain" method="table" conf="3"/>
      </port>
    </ports>
  </host>
  <runstats>
    <finished time="1700000006" elapsed="7.00"/>
  </runstats>
</nmaprun>
`

describe('parseNmapXml', () => {
  it('splits open ports from closed and filtered ones and keeps every port', () => {
    const hosts = parseNmapXml(NMAP_XML)
    expect(hosts).toHaveLength(2)

    const app = hosts[0]!
    expect(app.ports.map((port) => port.port)).toEqual([22, 443, 8080])
    expect(app.openPorts.map((port) => port.port)).toEqual([22, 443])
    expect(app.ports.find((port) => port.port === 8080)!.state).toBe('closed')
  })

  it('reads the address, hostname and OS matches, ignoring the MAC and the OS portused address', () => {
    const app = parseNmapXml(NMAP_XML)[0]!
    expect(app.address).toBe('10.0.0.5')
    expect(app.hostname).toBe('app.acme.test')
    expect(app.osMatches).toEqual(['Linux 4.15 - 5.6', 'Linux 3.10 - 4.11'])
    expect(parseNmapXml(NMAP_XML)[1]!.hostname).toBe('')
  })

  it('flattens product and version into one version string and keeps every other service attribute as an extra', () => {
    const ssh = parseNmapXml(NMAP_XML)[0]!.ports[0]!
    expect(ssh.service).toBe('ssh')
    expect(ssh.version).toBe('OpenSSH 8.9p1')
    expect(ssh.extra.product).toBe('OpenSSH')
    expect(ssh.extra.extrainfo).toBe('Ubuntu Linux')
    expect(ssh.extra.method).toBe('probed')
    expect(ssh.extra.name).toBeUndefined()
    expect(ssh.extra.cpe).toBeUndefined()
  })

  it('keeps a compound open|filtered state verbatim', () => {
    const dns = parseNmapXml(NMAP_XML)[1]!
    expect(dns.openPorts).toHaveLength(0)
    expect(dns.ports[0]!.state).toBe('open|filtered')
    expect(dns.ports[0]!.protocol).toBe('udp')
  })

  it('returns the host of a document that is truncated before it closes', () => {
    const truncated = NMAP_XML.slice(0, NMAP_XML.indexOf('</host>') + 3)
    const hosts = parseNmapXml(truncated)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.openPorts.map((port) => port.port)).toEqual([22, 443])
  })

  it('returns nothing rather than throwing for input that is not nmap XML', () => {
    expect(parseNmapXml('not xml at all')).toEqual([])
    expect(parseNmapXml('<nmaprun><host><ports><port protocol="tcp" portid="oops">')).toEqual([{ address: '', hostname: '', ports: [], openPorts: [], osMatches: [] }])
  })

  it('renders a port the way a report reads it, extrainfo included', () => {
    expect(describePort(parseNmapXml(NMAP_XML)[0]!.ports[0]!)).toBe('22/tcp open ssh OpenSSH 8.9p1 Ubuntu Linux')
    expect(describePort(parseNmapXml(NMAP_XML)[0]!.ports[1]!)).toBe('443/tcp open https nginx 1.18.0')
  })
})

const NMAP_GREP = `$ nmap -sV scanme.example.com
scope-check: scanme.example.com verified in SCOPE.md

Starting Nmap 7.94 ( https://nmap.org )
Nmap scan report for scanme.example.com (45.33.32.156)
Host is up (0.000s latency).
Not shown: 997 closed tcp ports (reset)
22/tcp open ssh OpenSSH 6.6.1p1 Ubuntu 2.04
80/tcp open http nginx 1.14.0
443/tcp open ssl/http nginx 1.14.0
|SSL certificate: CN=scanme.example.org
53/udp open|filtered domain
Nmap done at Mon Sep 11 07:53:34 2023 -- 1000 ports scanned
`

describe('parseNmapGrep', () => {
  it('reads each service row and leaves prose out', () => {
    expect(parseNmapGrep(NMAP_GREP)).toEqual([
      { port: 22, protocol: 'tcp', state: 'open', service: 'ssh', version: 'OpenSSH 6.6.1p1 Ubuntu 2.04' },
      { port: 80, protocol: 'tcp', state: 'open', service: 'http', version: 'nginx 1.14.0' },
      { port: 443, protocol: 'tcp', state: 'open', service: 'ssl/http', version: 'nginx 1.14.0' },
      { port: 53, protocol: 'udp', state: 'open|filtered', service: 'domain', version: '' },
    ])
  })

  it('returns nothing for a log with no service rows', () => {
    expect(parseNmapGrep('Nmap done at Mon Sep 11 07:53:34 2023')).toEqual([])
  })
})

const NUCLEI_JSONL = `$ nuclei -jsonl -severity high -u https://acme.test
scope-check: acme.test verified in SCOPE.md
{"template-id":"CVE-2021-41773","info":{"name":"Apache path traversal","severity":"critical","tags":["cve"]},"type":"http","host":"https://acme.test","matched-at":"https://acme.test/cgi-bin/.%2e/.%2e/etc/passwd","extracted-results":["root:x:0:0:root:/root:/bin/bash"],"matcher-name":"apache-path-traversal","timestamp":"2026-08-20T10:00:00Z"}
{"template-id":"tech-detect","info":{"name":"Technology Detection","severity":"info"},"type":"http","host":"https://acme.test","matched-at":"https://acme.test"}
{"template-id":"broken-line","info":{"name":"Truncated by an interrupted
{"template-id":"CVE-2021-41773","info":{"name":"Apache path traversal","severity":"critical"},"type":"http","host":"https://other.acme.test","matched-at":"https://other.acme.test/cgi-bin/x","extracted-results":["root:x:0:0"]}
{"note":"this nuclei line has no template id"}
`

describe('parseNucleiJsonl', () => {
  it('reads every complete finding and skips the malformed line without losing the rest', () => {
    const findings = parseNucleiJsonl(NUCLEI_JSONL)
    expect(findings).toHaveLength(3)
    expect(findings.map((finding) => finding.templateId)).toEqual(['CVE-2021-41773', 'tech-detect', 'CVE-2021-41773'])
    expect(findings[0]!.severity).toBe('critical')
    expect(findings[0]!.name).toBe('Apache path traversal')
    expect(findings[0]!.extracted).toEqual(['root:x:0:0:root:/root:/bin/bash'])
    expect(findings[0]!.matcherName).toBe('apache-path-traversal')
    expect(findings[0]!.type).toBe('http')
    expect(findings[0]!.raw['matched-at']).toBe('https://acme.test/cgi-bin/.%2e/.%2e/etc/passwd')
  })

  it('falls back to the newer "matched" spelling and to a missing host', () => {
    const [finding] = parseNucleiJsonl('{"template-id":"ssl-issuer","info":{"name":"SSL issuer","severity":"info"},"matched":"https://acme.test/"}')
    expect(finding!.matchedAt).toBe('https://acme.test/')
    expect(finding!.host).toBe('https://acme.test/')
  })

  it('returns nothing for a log that is not nuclei JSONL', () => {
    expect(parseNucleiJsonl('Nmap done at Mon Sep 11')).toEqual([])
    expect(parseNucleiJsonl('{"unrelated":true}')).toEqual([])
  })
})
