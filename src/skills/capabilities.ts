/**
 * What a loaded skill is allowed to be trusted to do.
 *
 * A skill is an ordinary TypeScript module, so the governor cannot know what one
 * does the way it knows what `run_command` does — and its fallthrough treats a
 * tool it does not recognise as critical. That is the right default for a tool
 * that might reach a real system, and it made every skill unusable: a read-only
 * scanner was refused outright in an unattended run ("unknown tool ... has no
 * declared safety contract") and prompted on every call in a supervised one. A
 * whole subsystem — loader, trust gate, relevance ranking, synthesis — could be
 * built and still never be used, because nothing could call what it produced.
 *
 * So each skill is classified once, when it loads, by reading its own source:
 *   - `read-only` — nothing in it can reach outside the process except to read.
 *   - `effectful` — it shells out, writes, or opens the network, so it keeps the
 *     unknown-tool treatment and a person authorises it.
 *
 * This is a denylist over source text and it **fails closed**: a file that cannot
 * be read, or that does anything the scan is not sure about, is `effectful`. It
 * is not a sandbox and does not pretend to be one — a skill that reaches for
 * `eval` or a computed import is classified effectful precisely because its
 * behaviour is no longer readable from its text. The boundary it enforces is
 * "elia may call a skill it has read and found inert without asking", not
 * "a hostile module cannot escape", which no static scan could promise.
 *
 * Deliberately dependency-free: `governor.ts` reads this, and anything it
 * imported would be pulled into the governor's import graph.
 */

export type SkillCapability = 'read-only' | 'effectful'

/**
 * Source patterns that mean a skill can affect something outside itself, each
 * with the phrase the governor shows when it matches. Written against the module
 * text, so both the `node:fs` and bare `fs` spellings are covered, as are the
 * globals that need no import at all. One list, so closing a new escape hatch is
 * one line.
 */
const EFFECTFUL: Array<[RegExp, string]> = [
  [/['"`](?:node:)?child_process['"`]/, 'imports child_process'],
  [/\bBun\s*\.\s*(?:spawn|spawnSync|\$)/, 'runs a shell through Bun'],
  [/\bprocess\s*\.\s*(?:binding|dlopen)\b/, 'reaches into the runtime'],
  [/['"`](?:node:)?(?:net|http|https|dgram|tls|dns)['"`]/, 'opens the network'],
  [/\bfetch\s*\(/, 'makes network requests'],
  [/\bnew\s+WebSocket\b/, 'opens a socket'],
  [/['"`](?:node:)?worker_threads['"`]/, 'starts worker threads'],
  [/['"`](?:node:)?vm['"`]/, 'evaluates code'],
  [/\beval\s*\(/, 'evaluates code'],
  [/\bnew\s+Function\s*\(/, 'builds code at runtime'],
  // A computed import can load anything, so the text stops being evidence.
  [/\bimport\s*\(\s*(?!['"`])/, 'imports something chosen at runtime'],
  [/\brequire\s*\(\s*(?!['"`])/, 'requires something chosen at runtime'],
  // Writing. Reads (readFile, readdir, stat, existsSync…) are what read-only allows.
  [/\b(?:write|append|unlink|rm|rmdir|mkdir|copy|rename|truncate|chmod|chown|symlink|link|open|createWrite|watch|mkdtemp|utimes)[A-Za-z]*\s*\(/i, 'writes to the filesystem'],
  [/\bprocess\s*\.\s*env\s*\[/, 'reads environment by computed key'],
]

/**
 * What a skill's own source says it can do. `effectful` on anything unreadable
 * or unrecognised — the caller has already decided the file is a skill, so the
 * only question here is whether it may be called without asking.
 */
export function classifySkillSource(source: string): { capability: SkillCapability; why?: string } {
  if (!source.trim()) return { capability: 'effectful', why: 'empty or unreadable source' }
  for (const [pattern, why] of EFFECTFUL) {
    if (pattern.test(source)) return { capability: 'effectful', why }
  }
  return { capability: 'read-only' }
}

const capabilities = new Map<string, SkillCapability>()

/** Recorded by the loader once per skill, as it loads. */
export function recordSkillCapability(name: string, capability: SkillCapability): void {
  capabilities.set(name, capability)
}

/**
 * The capability recorded for a loaded skill, or undefined if this name is not a
 * loaded skill at all. Undefined must be treated as "not a skill" by callers —
 * never as permission.
 */
export function skillCapability(name: string): SkillCapability | undefined {
  return capabilities.get(name)
}

/** Test seam: forget everything loaded so far. */
export function resetSkillCapabilities(): void {
  capabilities.clear()
}
