# elia-native

A `cdylib` the TypeScript conductor loads in-process through `bun:ffi`
(`src/native/ffi.ts`). Today it exposes one thing: the C++ structural edit-check
from [`native/elia-parse`](../../native/elia-parse), so `edit_file` / `write_file`
can reject a syntactically broken result in tens of microseconds without a
daemon, a socket, or anything that can be turned `off`.

Why in-process and not the `eliad` socket: the check is sub-millisecond and its
whole point is saving a round-trip — paying a connect (let alone a daemon spawn)
for it defeats the purpose. The daemon's `parse.check` stays only as a fallback
for a machine that has a daemon but not this library.

## Does it earn its keep?

`scripts/bench-preflight.ts` runs a 20-case corpus modelled on how LLM edits
actually fail. Latest run (2026-09-09, Windows x64):

| | in-process (bun:ffi) | daemon (socket) |
| --- | --- | --- |
| newly-broken edits caught | 10 / 10 | 10 / 10 |
| clean edits allowed | 6 / 6 | 6 / 6 |
| already-broken files allowed | 2 / 2 | 2 / 2 |
| latency p50 / p95 | **0.04 ms / 4 ms** | 0.5 ms / 291 ms |
| external process | none | `eliad` (spawn + dial) |

Same detection quality — it is the same C++ scanner — but the in-process path is
~13× faster at p50, has no cold-start spike, and no process to spawn or socket to
go flaky. It is strictly a *structural* check: it will never catch a type error
or a bad import (those still need the build), and that is fine — it is a
microsecond filter in front of the slow check. Re-run the bench after any change
to the scanner or the wiring.

## C ABI

Four symbols, mirrored in `src/native/ffi.ts` and version-gated by
`elia_native_abi()`:

| symbol | signature |
| --- | --- |
| `elia_native_check` | `(const char *src, size_t len, int lang) -> char *` — malloc'd JSON `{"ok":bool,"errors":[{line,column,message}]}` |
| `elia_native_version` | `() -> char *` — malloc'd semver |
| `elia_native_abi` | `() -> uint32_t` — bumped on any signature/shape change |
| `elia_native_free` | `(char *) -> void` — release a pointer from the two calls above |

`lang` matches `elia_parse_lang` in the C header: `0` generic · `1` js/ts · `2`
python · `3` rust · `4` go. Every entry point is panic-safe and fails open
(`{"ok":true,"errors":[]}`), so a bug here can never block an edit.

## Build

```
cargo build -p elia-native --release      # or: just build-native
```

Produces `target/release/{libelia_native.so | libelia_native.dylib | elia_native.dll}`.
`src/native/ffi.ts` searches `target/{release,debug}/`, a published
`@elia/native-<platform>-<arch>` package, and `$ELIA_NATIVE_PATH`. If it finds
nothing, or the load fails, the pre-flight silently falls back to the daemon and
then to allowing the write — never a hard error.

Windows note: the `.dll` links libc++ (the validator uses `std::string` /
`std::vector`) so it needs `libc++.dll` + `libunwind.dll` beside it — on PATH via
the LLVM-MinGW toolchain in dev, shipped in the platform package otherwise. No
such constraint on Linux/macOS.
