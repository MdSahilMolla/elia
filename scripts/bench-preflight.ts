/**
 * Does the structural pre-flight actually earn its keep?
 *
 * It exists to catch a broken `edit_file` result *before* the model pays for a
 * failed build / test round-trip. This measures that claim against a corpus of
 * edit pairs modelled on how LLM edits actually fail:
 *
 *   - `newly-broken`  the edit unbalances a bracket / quote / comment. The
 *                     pre-flight SHOULD block these (each one is a saved
 *                     round-trip).
 *   - `clean`         a correct edit. The pre-flight MUST NOT block these
 *                     (a false block is a wasted turn and erodes trust).
 *   - `already-broken` the file was broken before the edit too. MUST NOT block
 *                     (blocking a repair-in-progress is the worst failure).
 *   - `semantic-only` the edit is a type error / undefined name but lexically
 *                     balanced. Out of scope — reported so the ceiling is honest.
 *
 * Run: `cargo build -p elia-native --release && bun run scripts/bench-preflight.ts`
 * Add `--daemon` to also time the socket path (needs `ELIA_DAEMON=auto` + eliad).
 */

import { preflightStructuralCheck, lastStructuralBackend } from '../src/native/parseCheck.ts'
import { nativeAvailable, nativeVersion } from '../src/native/ffi.ts'

type Kind = 'newly-broken' | 'clean' | 'already-broken' | 'semantic-only'
interface Case {
  name: string
  path: string
  kind: Kind
  before: string
  after: string
}

const cases: Case[] = [
  // --- newly-broken: the model truncated or mis-anchored an edit -------------
  {
    name: 'ts: dropped a closing brace (truncated output)',
    path: 'src/a.ts',
    kind: 'newly-broken',
    before: 'export function f(x: number) {\n  return x * 2\n}\n',
    after: 'export function f(x: number) {\n  if (x > 0) {\n    return x * 2\n  }\n',
  },
  {
    name: 'ts: unbalanced paren in a call the model rewrote',
    path: 'src/b.ts',
    kind: 'newly-broken',
    before: 'const y = compute(a, b)\n',
    after: 'const y = compute(a, transform(b)\n',
  },
  {
    name: 'ts: unterminated string after a bad find/replace',
    path: 'src/c.ts',
    kind: 'newly-broken',
    before: 'const msg = "hello"\n',
    after: 'const msg = "hello world\nconst n = 1\n',
  },
  {
    name: 'tsx: JSX-adjacent brace mismatch',
    path: 'src/C.tsx',
    kind: 'newly-broken',
    before: 'const el = <div>{items.map((i) => <span key={i}>{i}</span>)}</div>\n',
    after: 'const el = <div>{items.map((i) => <span key={i}>{i}</span>)</div>\n',
  },
  {
    name: 'py: dedent lost a bracket',
    path: 'src/d.py',
    kind: 'newly-broken',
    before: 'def f(xs):\n    return [x for x in xs]\n',
    after: 'def f(xs):\n    return [x for x in xs\n',
  },
  {
    name: 'rs: match arm missing its closing brace',
    path: 'src/e.rs',
    kind: 'newly-broken',
    before: 'fn f(x: i32) -> i32 {\n    match x {\n        0 => 1,\n        _ => 2,\n    }\n}\n',
    after: 'fn f(x: i32) -> i32 {\n    match x {\n        0 => 1,\n        _ => 2,\n}\n',
  },
  {
    name: 'go: struct literal left open',
    path: 'src/f.go',
    kind: 'newly-broken',
    before: 'v := Config{Name: "x", Port: 80}\n',
    after: 'v := Config{Name: "x", Port: 80\n',
  },
  {
    name: 'ts: block comment never closed',
    path: 'src/g.ts',
    kind: 'newly-broken',
    before: 'const a = 1\n// note\nconst b = 2\n',
    after: 'const a = 1\n/* note\nconst b = 2\n',
  },
  {
    name: 'c: header guard brace imbalance',
    path: 'src/h.c',
    kind: 'newly-broken',
    before: 'int main(void) {\n  return 0;\n}\n',
    after: 'int main(void) {\n  if (argc > 1) {\n    return 1;\n  return 0;\n}\n',
  },
  {
    name: 'ts: extra closing brace pasted in',
    path: 'src/i.ts',
    kind: 'newly-broken',
    before: 'function f() {\n  return 1\n}\n',
    after: 'function f() {\n  return 1\n}\n}\n',
  },

  // --- clean: correct edits, must pass --------------------------------------
  {
    name: 'ts: add a guard clause',
    path: 'src/j.ts',
    kind: 'clean',
    before: 'export function f(x: number) {\n  return x * 2\n}\n',
    after: 'export function f(x: number) {\n  if (x < 0) return 0\n  return x * 2\n}\n',
  },
  {
    name: 'ts: template literal with nested braces',
    path: 'src/k.ts',
    kind: 'clean',
    before: 'const s = `a`\n',
    after: 'const s = `a ${obj.get({ k: 1 })} b`\n',
  },
  {
    name: 'py: add a triple-quoted docstring with brackets inside',
    path: 'src/l.py',
    kind: 'clean',
    before: 'def f():\n    return 1\n',
    after: 'def f():\n    """Returns 1. Not [a list], not (a tuple)."""\n    return 1\n',
  },
  {
    name: 'rs: add a raw string with quotes and braces',
    path: 'src/m.rs',
    kind: 'clean',
    before: 'let s = "x";\n',
    after: 'let s = r#"{ "json": "with \\"quotes\\"" }"#;\n',
  },
  {
    name: 'ts: reformat across lines, structure preserved',
    path: 'src/n.ts',
    kind: 'clean',
    before: 'const x = { a: 1, b: 2, c: 3 }\n',
    after: 'const x = {\n  a: 1,\n  b: 2,\n  c: 3,\n}\n',
  },
  {
    name: 'go: add a backtick raw string',
    path: 'src/o.go',
    kind: 'clean',
    before: 'const q = "select 1"\n',
    after: 'const q = `select {id} from t where name = "x"`\n',
  },

  // --- already-broken: a repair in progress, must pass --------------------
  {
    name: 'ts: file already missing a brace, edit is unrelated',
    path: 'src/p.ts',
    kind: 'already-broken',
    before: 'function f() {\n  return 1\n',
    after: 'function f() {\n  return 2\n',
  },
  {
    name: 'py: already-open bracket, model tweaks a line above it',
    path: 'src/q.py',
    kind: 'already-broken',
    before: 'x = [\n  1,\n  2,\n',
    after: 'x = [\n  10,\n  2,\n',
  },

  // --- semantic-only: lexically fine, so out of scope (ceiling check) -----
  {
    name: 'ts: references an undefined name',
    path: 'src/r.ts',
    kind: 'semantic-only',
    before: 'const a = 1\nexport const b = a + 1\n',
    after: 'const a = 1\nexport const b = a + undefinedThing\n',
  },
  {
    name: 'ts: type error but balanced',
    path: 'src/s.ts',
    kind: 'semantic-only',
    before: 'export const n: number = 1\n',
    after: 'export const n: number = "not a number"\n',
  },
]

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(3)}%`
}

async function main(): Promise<void> {
  console.log(`elia-native: ${nativeAvailable() ? `loaded v${nativeVersion()}` : 'NOT LOADED — build it first'}`)
  console.log(`ELIA_DAEMON=${process.env.ELIA_DAEMON ?? 'off'}\n`)

  const byKind = new Map<Kind, { total: number; blocked: number }>()
  const latencies: number[] = []
  let backendSeen = ''

  for (const c of cases) {
    const t0 = performance.now()
    const message = await preflightStructuralCheck(c.path, c.before, c.after)
    latencies.push(performance.now() - t0)
    if (lastStructuralBackend() !== 'none') backendSeen = lastStructuralBackend()

    const blocked = message !== undefined
    const stats = byKind.get(c.kind) ?? { total: 0, blocked: 0 }
    stats.total += 1
    if (blocked) stats.blocked += 1
    byKind.set(c.kind, stats)

    const want =
      c.kind === 'newly-broken' ? blocked : c.kind === 'clean' || c.kind === 'already-broken' ? !blocked : true
    const mark = want ? 'ok  ' : 'MISS'
    console.log(`  ${mark} [${c.kind.padEnd(14)}] ${c.name}${blocked ? `\n         -> ${message!.split('\n')[0]}` : ''}`)
  }

  console.log(`\nbackend exercised: ${backendSeen || 'none'}`)
  console.log('\n  kind             blocked / total   read as')
  for (const kind of ['newly-broken', 'clean', 'already-broken', 'semantic-only'] as Kind[]) {
    const s = byKind.get(kind)
    if (!s) continue
    const label =
      kind === 'newly-broken'
        ? `${pct(s.blocked, s.total)} caught (higher is better)`
        : kind === 'semantic-only'
          ? `${pct(s.blocked, s.total)} caught (expected ~0 — out of scope)`
          : `${pct(s.total - s.blocked, s.total)} allowed (must be 100%)`
    console.log(`  ${kind.padEnd(15)}  ${String(s.blocked).padStart(4)} / ${String(s.total).padStart(3)}      ${label}`)
  }

  const sorted = [...latencies].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  console.log(`\n  latency per check: p50 ${p50.toFixed(3)}ms · p95 ${p95.toFixed(3)}ms · n=${latencies.length}`)
}

await main()
