/**
 * Per-category CTF procedure.
 *
 * This is deliberately *not* loaded into a system prompt: five full playbooks
 * would blow the context budget before the challenge is even read. Instead the
 * model pulls one category on demand through the `ctf_playbook` tool, which is
 * why the default render (the index) is short enough to always be safe to call.
 *
 * Self-contained on purpose. Nothing here imports the tool catalog: a playbook
 * names tools as plain strings so the procedure survives edits to the catalog,
 * and so a playbook is never a manifest of what the author remembered to
 * register.
 *
 * The playbook modules import their types from this file, which would be a
 * cycle if the imports were values. They are `import type`, so they are erased
 * and the cycle never exists at runtime.
 */

import { cryptoPlaybook } from './crypto.ts'
import { miscPlaybook } from './misc.ts'
import { pwnPlaybook } from './pwn.ts'
import { revPlaybook } from './rev.ts'
import { stegoPlaybook } from './stego.ts'

export type PlaybookCategory = 'pwn' | 'rev' | 'crypto' | 'stego' | 'misc'

export interface PlaybookStep {
  title: string
  /** Why this step, or what to look for in the output. */
  note?: string
  /** Concrete runnable commands. */
  commands?: string[]
  /** What a suspicious result looks like. */
  signals?: string[]
}

export interface Playbook {
  category: PlaybookCategory
  summary: string
  /** How to recognise this category from the artifacts you are given. */
  detect: string[]
  steps: PlaybookStep[]
  /** Realistic failure modes and time sinks for this category. */
  gotchas: string[]
  /** What "solved" looks like — the flag/answer form to look for. */
  successShape: string
}

/** Fixed order. It is the triage order, the report order, and the render order. */
export const PLAYBOOK_CATEGORIES: PlaybookCategory[] = ['pwn', 'rev', 'crypto', 'stego', 'misc']

export const PLAYBOOKS: Record<PlaybookCategory, Playbook> = {
  pwn: pwnPlaybook,
  rev: revPlaybook,
  crypto: cryptoPlaybook,
  stego: stegoPlaybook,
  misc: miscPlaybook,
}

export function playbookFor(category: PlaybookCategory): Playbook | undefined {
  return PLAYBOOKS[category]
}

export function isPlaybookCategory(value: string): value is PlaybookCategory {
  return (PLAYBOOK_CATEGORIES as string[]).includes(value)
}

/**
 * Category detection is a set of deliberately blunt signals, evaluated in the
 * fixed triage order and resolved to the *first* category whose signals match a
 * given hint. First-match-wins is what keeps `.apk` on rev instead of also
 * firing the archive rules in misc, and what keeps a `chall.elf` on pwn instead
 * of being argued into rev as "a binary".
 *
 * Each regex is anchored or uses a boundary where a short token would otherwise
 * match inside an ordinary word: `elf` inside `shelf`, `aes` inside `aerospace`,
 * `key` inside `monkey` are all avoided. A hint that matches nothing
 * contributes nothing, and a run of nothing returns `[]` — the caller is told
 * "no signal" rather than handed a guess, because a wrong category sends the
 * model down a whole wrong procedure.
 */
interface CategorySignals {
  extensions: RegExp[]
  keywords: RegExp[]
}

const CATEGORY_SIGNALS: Record<PlaybookCategory, CategorySignals> = {
  pwn: {
    extensions: [/\.elf$/i, /\.pwn$/i],
    keywords: [
      /pwn/i,
      /ret2win|ret2libc|ret2csu|ret2dlresolve|ret2vuln/i,
      /buffer[- ]?overflow/i,
      /stack[- ]?canary|stack[- ]?smash|\bcanary\b/i,
      /\brop\b|ropchain|rop chain/i,
      /format string/i,
      /use[- ]after[- ]free|\buaf\b|heap exploit/i,
      /shellcode/i,
      /checksec|\bpie\b|\bnx bit\b|full relro/i,
      /off[- ]by[- ]one/i,
      /\bvuln\b|\bbof\b|pwnable/i,
      /subvert|execve|\/bin\/sh/i,
    ],
  },
  rev: {
    extensions: [/\.apk$/i, /\.jar$/i, /\.class$/i, /\.pyc$/i, /\.pyd$/i, /\.dex$/i, /\.so$/i, /\.exe$/i, /\.dll$/i],
    keywords: [
      /\brev\b|reverse engineer|reversed/i,
      /jadx|apktool|androidmanifest|android|\bsmali\b|dex\b/i,
      /ghidra|ida pro|radare2|\br2\b|objdump|\bndisasm\b|disassembl/i,
      /decompil|uncompyle|unluac|pycdc|xdis|\bpyc\b|bytecode|ilspy|monodis|dnspy/i,
      /obfuscat|\bupx\b|packed binary|control[- ]flow flatten/i,
      /crackme|keygen|licence check|license check|serial (check|number)/i,
      /stripped binary|static(ally)? linked/i,
      /\bsbox\b|s[- ]?box|anti[- ]?debug|ptrace/i,
    ],
  },
  crypto: {
    extensions: [/\.pem$/i, /\.der$/i, /\.key$/i, /\.(crt|cer|pub)$/i, /\.enc$/i, /\.(gpg|pgp|asc)$/i],
    keywords: [
      /\bcrypto\b|cipher|\bencrypt\b|\bdecrypt\b|plain ?text/i,
      /\brsa\b|\bdhe\b|diffie|hellman|elgamal|\becc\b|elliptic|curve (25519|448)/i,
      /\baes\b|\bdes\b|\b3des\b|blowfish|\brc4\b|chacha|salsa|rabbit cipher/i,
      /\bmodulus\b|\bexponent\b|private key|public key|\bn\s*=\s*\d|e\s*=\s*\d/i,
      /\bnonce\b|padding oracle|\becb\b|\bcbc\b|\bctr\b|\bgcm\b|keystream|iv\b/i,
      /vigen|beaufort|\bxor\b|hill cipher|one[- ]time pad|substitution cipher/i,
      /\bhash\b|md5|\bsha[- ]?1\b|sha[- ]?256|crc32|hmac|length extension/i,
      /small_roots|coppersmith|wiener|pollard|fermat|factordb/i,
    ],
  },
  stego: {
    extensions: [
      /\.(png|jpe?g|bmp|gif|tiff?|webp|ico)$/i,
      /\.(wav|mp3|flac|ogg|m4a|aac|aiff?|au|mp4|mkv|webm|avi|mov|wmv)$/i,
    ],
    keywords: [
      /steg|steghide|zsteg|outguess|openstego|\blsb\b|least significant bit/i,
      /exif|metadata|\bxmp\b|spectrogram/i,
      /binwalk|embedded file|appended (data|after)|hidden (data|file|message)/i,
      /carve|carving|polyglot/i,
    ],
  },
  misc: {
    extensions: [/\.pcap(ng)?$/i, /\.cap$/i, /\.har$/i],
    keywords: [
      /pcap|packet capture|wireshark|\btshark\b|\btcpdump\b/i,
      /socat|ncat|netcat|service (on|port)|connect to (port|host)|\bsocket\b/i,
      /base64|base32|rot13|\bmorse\b|brainfuck|cyberchef|\bencode\b|\bdecode\b|\bencoding\b/i,
      /barcode|qr code|\bzbar\b/i,
      /\bqpdf\b|pdftotext|\bsoffice\b|libreoffice|\bpdf\b/i,
      /wordlist|rockyou|hashcat|john the ripper|\bjohn\b|hydra/i,
      /forensic|disk image|memory dump|volatility|\bscalpel\b|\bforemost\b/i,
    ],
  },
}

/** Bounded so one pathological hint cannot make this a hot loop. */
const MAX_HINTS = 200

/**
 * Best-effort category suggestion from filenames, extensions, or keywords. The
 * result is ordered by {@link PLAYBOOK_CATEGORIES} rather than by hit order, so
 * two callers passing the same hints in a different order get the same answer.
 * Returns `[]` when nothing matched — the caller should say so out loud rather
 * than pick one on the model's behalf.
 */
export function detectCategories(hints: string[]): PlaybookCategory[] {
  const matched = new Set<PlaybookCategory>()
  for (const hint of hints.slice(0, MAX_HINTS)) {
    if (typeof hint !== 'string') continue
    for (const category of PLAYBOOK_CATEGORIES) {
      const signals = CATEGORY_SIGNALS[category]
      const hit =
        signals.extensions.some((pattern) => pattern.test(hint)) || signals.keywords.some((pattern) => pattern.test(hint))
      if (hit) {
        matched.add(category)
        break
      }
    }
  }
  return PLAYBOOK_CATEGORIES.filter((category) => matched.has(category))
}
