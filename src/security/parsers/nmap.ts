/**
 * nmap `-oX` XML, parsed tolerantly.
 *
 * A recon log is whatever the scan managed to write: a killed run, a broken
 * pipe, a file someone copied out of a rotating directory. Every step here
 * skips what it cannot read instead of throwing, so a truncated log still
 * yields the hosts it did contain — and a file that is not nmap XML at all
 * yields nothing, which is how the caller tells one format from another.
 *
 * `Bun.XMLParser` does not exist in this Bun (checked against 1.4.0), so this
 * is a small tag scan. It only has to know the handful of elements nmap emits.
 */

/**
 * The transport nmap scanned. Kept open past the three nmap ships because an
 * unfamiliar protocol in a real log should be reported as itself, not dropped
 * or quietly relabelled as tcp.
 */
export type NmapProtocol = 'tcp' | 'udp' | 'sctp' | string

export interface NmapPort {
  port: number
  protocol: NmapProtocol
  state: string
  service: string
  /** Product and version flattened together — `OpenSSH 8.9p1`. `extrainfo` stays in `extra`: it is a grab-bag that can be an OS, a protocol note, or a banner. */
  version: string
  /** Every other `<service>` attribute nmap reported, verbatim. */
  extra: Record<string, string>
}

export interface NmapHost {
  address: string
  hostname: string
  /** Every port the scan resolved, whatever its state. */
  ports: NmapPort[]
  /** Convenience view of the open ones; the closed and filtered ports still matter when reading a sweep. */
  openPorts: NmapPort[]
  osMatches: string[]
}

interface XmlTag {
  name: string
  attrs: Record<string, string>
  closing: boolean
}

interface HostDraft {
  /** Address keyed by addrtype; nmap reports the MAC alongside the IPv4 and an OS portused address can repeat either. */
  addresses: Record<string, string>
  hostname: string
  ports: NmapPort[]
  osMatches: string[]
}

/** A quoted attribute value may legally hold `>`, so the quoted alternative is tried first. */
const TAG_PATTERN = /<(\/)?\s*([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/)?\s*>/g
const ATTR_PATTERN = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(ATTR_PATTERN)) {
    const name = match[1]
    if (!name) continue
    attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function scanTags(xml: string): XmlTag[] {
  // Comments and the XML declaration are not elements, and leaving them in
  // would let a sample block quoted inside a log register as a real host.
  const source = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  const tags: XmlTag[] = []
  for (const match of source.matchAll(TAG_PATTERN)) {
    const name = match[2]
    if (!name) continue
    tags.push({ name: name.toLowerCase(), attrs: parseAttrs(match[3] ?? ''), closing: match[1] === '/' })
  }
  return tags
}

/** `OpenSSH 8.9p1` + `Ubuntu Linux` reads as one version string, gaps included. */
function joinVersion(...parts: Array<string | undefined>): string {
  return parts.map((part) => (part ?? '').trim()).filter(Boolean).join(' ')
}

function finishHost(draft: HostDraft): NmapHost {
  return {
    address: draft.addresses.ipv4 ?? draft.addresses.ipv6 ?? draft.addresses.mac ?? '',
    hostname: draft.hostname,
    ports: draft.ports,
    openPorts: draft.ports.filter((port) => port.state === 'open'),
    osMatches: draft.osMatches,
  }
}

/**
 * Every host in an nmap `-oX` document. A log that is truncated mid-`<host>`
 * still reports that host, and a document with no `<nmaprun>` root at all
 * parses to an empty list rather than throwing.
 */
export function parseNmapXml(xml: string): NmapHost[] {
  const hosts: NmapHost[] = []
  let host: HostDraft | undefined
  let port: NmapPort | undefined
  // `<os>` nests its own `<address>` inside `<portused>`; only the host-level
  // address identifies the target.
  let osDepth = 0

  for (const tag of scanTags(xml)) {
    if (tag.closing) {
      if (tag.name === 'host' && host) {
        hosts.push(finishHost(host))
        host = undefined
      } else if (tag.name === 'port' && port) {
        host?.ports.push(port)
        port = undefined
      } else if (tag.name === 'os' && osDepth > 0) {
        osDepth -= 1
      }
      continue
    }

    switch (tag.name) {
      case 'host':
        host = { addresses: {}, hostname: '', ports: [], osMatches: [] }
        break
      case 'os':
        if (tag.attrs['portused']) break
        osDepth += 1
        break
      case 'address': {
        if (!host || osDepth > 0) break
        const type = (tag.attrs.addrtype ?? '').toLowerCase()
        const value = tag.attrs.addr ?? ''
        if (value && !host.addresses[type]) host.addresses[type] = value
        break
      }
      case 'hostname': {
        const name = tag.attrs.name
        if (host && name && !host.hostname) host.hostname = name
        break
      }
      case 'port': {
        const portid = Number.parseInt(tag.attrs.portid ?? '', 10)
        if (!Number.isInteger(portid)) break
        port = {
          port: portid,
          protocol: (tag.attrs.protocol ?? '').toLowerCase(),
          state: (tag.attrs.state ?? '').toLowerCase(),
          service: '',
          version: '',
          extra: {},
        }
        break
      }
      case 'state': {
        if (port) port.state = (tag.attrs.state ?? port.state).toLowerCase()
        break
      }
      case 'service': {
        if (!port) break
        port.service = tag.attrs.name ?? ''
        port.version = joinVersion(tag.attrs.product, tag.attrs.version)
        for (const [key, value] of Object.entries(tag.attrs)) {
          if (key !== 'name' && value) port.extra[key] = value
        }
        break
      }
      case 'osmatch': {
        const name = tag.attrs.name
        if (host && name) host.osMatches.push(name)
        break
      }
      default:
        break
    }
  }

  // A document that ends mid-host still described that host.
  if (host) hosts.push(finishHost(host))
  return hosts
}

/**
 * One port as a human reads it in a report: `22/tcp open ssh OpenSSH 8.9p1`.
 *
 * `extrainfo` is appended when the scan set one — it is where nmap puts the OS
 * string an `-O` run resolved, which is the other half of the disclosure worth
 * reading, and dropping it would lose that fact from the report line.
 */
export function describePort(port: NmapPort): string {
  return [
    `${port.port}/${port.protocol}`,
    port.state,
    port.service,
    port.version,
    port.extra.extrainfo,
  ]
    .filter(Boolean)
    .join(' ')
}
