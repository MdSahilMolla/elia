/**
 * In-process structural check, via `bun:ffi` and the `elia-native` shared
 * library (`crates/elia-native` → `elia_native.{dll,dylib,so}`).
 *
 * Why FFI and not the daemon: the C++ bracket/quote/comment check is
 * sub-millisecond, and its entire reason to exist is to save a round-trip. A
 * socket connect — let alone spawning `eliad` — costs more than it saves, and
 * the daemon is `off` by default anyway, so today the pre-flight almost never
 * runs. Loading a ~300 KB library once per process and calling straight into it
 * makes the check real for every `edit_file` / `write_file`, daemon or not.
 *
 * The JVM type-check stays daemon-only — it genuinely needs a resident process.
 *
 * Everything here fails soft: no library, wrong ABI, a load error, a call that
 * throws — any of them just means {@link nativeParseCheck} returns `undefined`
 * and the caller moves on to the daemon and then the pure-TS path.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Pointer } from 'bun:ffi'
import { ELIA_ROOT } from '../statePaths.ts'
import type { ParseCheckResult } from '../daemon/types.ts'

/** Lexical-rule tags — must match `elia_parse_lang` (C header),
 * `Language` (crates/elia-parse), and `language_from_tag` (crates/elia-native). */
export const LANG = { generic: 0, jsTs: 1, python: 2, rust: 3, go: 4 } as const

/** Bump in lockstep with `ABI_REVISION` in `crates/elia-native/src/lib.rs`. A
 * mismatch (usually a stale `target/` build) disables the fast path rather than
 * risk calling a changed signature. */
const EXPECTED_ABI = 1

const EXT_TO_TAG: Record<string, number> = {
  ts: LANG.jsTs, tsx: LANG.jsTs, mts: LANG.jsTs, cts: LANG.jsTs,
  js: LANG.jsTs, jsx: LANG.jsTs, mjs: LANG.jsTs, cjs: LANG.jsTs,
  py: LANG.python, pyi: LANG.python,
  rs: LANG.rust,
  go: LANG.go,
  c: LANG.generic, h: LANG.generic,
  cc: LANG.generic, cpp: LANG.generic, cxx: LANG.generic,
  hpp: LANG.generic, hh: LANG.generic, hxx: LANG.generic,
}

const HINT_TO_TAG: Record<string, number> = {
  js: LANG.jsTs, jsx: LANG.jsTs, ts: LANG.jsTs, tsx: LANG.jsTs,
  javascript: LANG.jsTs, typescript: LANG.jsTs,
  py: LANG.python, python: LANG.python,
  rs: LANG.rust, rust: LANG.rust,
  go: LANG.go, golang: LANG.go,
  generic: LANG.generic, c: LANG.generic, cpp: LANG.generic, 'c++': LANG.generic, java: LANG.generic,
}

/** Resolve a `{ path?, language? }` to a lexer tag, or `undefined` if this file
 * type has no lexer worth trusting (prose, config, data). */
export function langTagFor(path?: string, language?: string): number | undefined {
  if (language) {
    const hint = HINT_TO_TAG[language.trim().toLowerCase()]
    if (hint !== undefined) return hint
  }
  if (path) {
    const base = path.replace(/^.*[/\\]/, '')
    const dot = base.lastIndexOf('.')
    if (dot > 0) {
      const tag = EXT_TO_TAG[base.slice(dot + 1).toLowerCase()]
      if (tag !== undefined) return tag
    }
  }
  return undefined
}

function libFileName(): string {
  if (process.platform === 'win32') return 'elia_native.dll'
  if (process.platform === 'darwin') return 'libelia_native.dylib'
  return 'libelia_native.so'
}

/** Same search order as `resolveEliadPath`: explicit override, then a published
 * platform package, then the newest local cargo build (release before debug). */
function resolveLibPath(): string | undefined {
  const file = libFileName()
  const override = process.env.ELIA_NATIVE_PATH
  if (override && existsSync(override)) return override

  const published = join(
    ELIA_ROOT,
    'node_modules',
    `@elia/native-${process.platform}-${process.arch}`,
    file,
  )
  if (existsSync(published)) return published

  const targetRoot = join(ELIA_ROOT, 'target')
  const dirs = ['', ...safeReaddir(targetRoot)]
  const profiles = process.env.ELIA_NATIVE_PROFILE === 'debug' ? ['debug', 'release'] : ['release', 'debug']
  for (const profile of profiles) {
    let newest: { path: string; mtimeMs: number } | undefined
    for (const dir of dirs) {
      const candidate = join(targetRoot, dir, profile, file)
      try {
        const { mtimeMs } = statSync(candidate)
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs }
      } catch {
        // not built for this profile / target triple
      }
    }
    if (newest) return newest.path
  }
  return undefined
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

interface NativeLib {
  path: string
  /** source bytes + byte length + lexer tag -> pointer to malloc'd JSON. */
  check(source: Uint8Array, len: number, lang: number): Pointer | null
  /** Read a `char*` the library returned, then free it. */
  take(pointer: Pointer | null): string
  /** `char*` semver of the loaded library. */
  version(): Pointer | null
}

type LoadState = { lib: NativeLib } | { lib: null; reason: string }
let loaded: LoadState | undefined

/** Load `elia_native` once. Records why it could not load so `elia doctor` has
 * an answer instead of silence. */
function load(): LoadState {
  if (loaded) return loaded

  if (process.env.ELIA_NO_NATIVE === '1' || process.env.ELIA_NO_NATIVE === 'true') {
    return (loaded = { lib: null, reason: 'ELIA_NO_NATIVE is set' })
  }

  const path = resolveLibPath()
  if (!path) {
    return (loaded = {
      lib: null,
      reason: 'elia_native not built (run: cargo build -p elia-native --release)',
    })
  }

  try {
    // `bun:ffi` only exists under Bun; require it lazily so importing this
    // module from another tool can't throw at load.
    const { dlopen, FFIType, CString } = require('bun:ffi') as typeof import('bun:ffi')
    const { symbols } = dlopen(path, {
      elia_native_check: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.ptr },
      elia_native_version: { args: [], returns: FFIType.ptr },
      elia_native_abi: { args: [], returns: FFIType.u32 },
      elia_native_free: { args: [FFIType.ptr], returns: FFIType.void },
    })

    const take = (pointer: Pointer | null): string => {
      if (!pointer) return '{"ok":true,"errors":[]}'
      try {
        return new CString(pointer).toString()
      } finally {
        symbols.elia_native_free(pointer)
      }
    }

    const abi = Number(symbols.elia_native_abi())
    if (abi !== EXPECTED_ABI) {
      return (loaded = {
        lib: null,
        reason: `elia_native ABI ${abi} != ${EXPECTED_ABI}; rebuild: cargo build -p elia-native --release`,
      })
    }

    const lib: NativeLib = {
      path,
      check: (source, len, lang) => symbols.elia_native_check(source, len, lang),
      take,
      version: () => symbols.elia_native_version(),
    }
    // Prove the full round-trip (call, string read, free, JSON parse) before
    // committing to this path — a half-working dlopen must not reach an edit.
    const probe = JSON.parse(take(lib.check(new Uint8Array([0x7b, 0x7d]), 2, LANG.generic))) as ParseCheckResult
    if (probe.ok !== true) throw new Error('self-check returned unexpected result')
    return (loaded = { lib })
  } catch (err) {
    return (loaded = {
      lib: null,
      reason: `dlopen failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/** True when the in-process check is available and verified this process. */
export function nativeAvailable(): boolean {
  return load().lib !== null
}

/** Why the in-process check is not being used, or `undefined` when it is. */
export function nativeUnavailableReason(): string | undefined {
  const state = load()
  return state.lib === null ? state.reason : undefined
}

/** Path of the loaded library, for `elia doctor`. */
export function nativeLibPath(): string | undefined {
  const state = load()
  return state.lib ? state.lib.path : undefined
}

/** Semantic version of the loaded library, or `undefined` when not loaded. */
export function nativeVersion(): string | undefined {
  const state = load()
  if (!state.lib) return undefined
  try {
    return state.lib.take(state.lib.version())
  } catch {
    return undefined
  }
}

/**
 * Run the structural check in-process. Returns `undefined` (not an error) when
 * the native library is unavailable or the file type has no lexer — the caller
 * then tries the daemon, then allows the write.
 */
export function nativeParseCheck(
  source: string,
  opts: { path?: string; language?: string },
): ParseCheckResult | undefined {
  const state = load()
  if (!state.lib) return undefined
  const tag = langTagFor(opts.path, opts.language)
  if (tag === undefined) return undefined

  try {
    const bytes = new TextEncoder().encode(source)
    const parsed = JSON.parse(state.lib.take(state.lib.check(bytes, bytes.byteLength, tag))) as ParseCheckResult
    if (typeof parsed?.ok !== 'boolean' || !Array.isArray(parsed?.errors)) return undefined
    return remapColumnsToUtf16(source, parsed)
  } catch {
    return undefined
  }
}

/**
 * The C++ validator (`native/elia-parse/src/validator.cpp`, `Pos::col`) counts
 * `column` in UTF-8 bytes, but every caller here works with JS's UTF-16
 * string — for any line with a multi-byte UTF-8 character before the error
 * column, the raw value is wrong against the JS string. Remap each error's
 * `column` by re-encoding just its line and measuring how many UTF-16 code
 * units the byte-prefix up to the reported column decodes back to. `line` is
 * left untouched: it is not byte-based.
 */
function remapColumnsToUtf16(source: string, result: ParseCheckResult): ParseCheckResult {
  if (result.errors.length === 0) return result
  const lines = source.split('\n')
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const errors = result.errors.map((e) => {
    const lineText = lines[e.line - 1]
    if (lineText === undefined) return e
    try {
      const lineBytes = encoder.encode(lineText)
      const byteCol = Math.max(1, e.column)
      const prefixLen = Math.min(byteCol - 1, lineBytes.byteLength)
      const prefix = decoder.decode(lineBytes.subarray(0, prefixLen))
      return { ...e, column: prefix.length + 1 }
    } catch {
      return e
    }
  })
  return { ...result, errors }
}

/** Test seam: forget the cached load so the next call re-resolves. */
export function resetNativeForTests(): void {
  loaded = undefined
}
