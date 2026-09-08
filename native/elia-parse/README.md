# elia-parse (C++)

A fast structural check for source edits. **Not a parser** — it does one linear
pass over a buffer, aware of each language family's string / char / comment
syntax, and answers one question: *would this text fail to tokenize?*

- unbalanced `()` `[]` `{}`
- unterminated `"..."` / `'...'` / `` `...` `` / `'''...'''` / `"""..."""`
- unterminated block comments (nested, for Rust)

The point is latency: Elia can reject a syntactically broken `edit_file` result
in well under a millisecond, instead of finding out after a failed build — one
saved model round-trip per broken edit.

## Layout

| Path | What |
| --- | --- |
| `include/elia_parse.h` | C ABI — `elia_parse_check_json(source, len, lang)` returns malloc'd JSON |
| `src/validator.cpp` | the scanner (C++17, `-fno-exceptions -fno-rtti`) |
| `../../crates/elia-parse/` | Rust wrapper — compiles this with the `cc` crate, exposes a safe `check()` |

Two things link the Rust crate:

- **`crates/elia-native`** — a `cdylib` the TypeScript side `dlopen`s through
  `bun:ffi` (`src/native/ffi.ts`). This is the default path: `edit_file` /
  `write_file` call straight into this scanner, no daemon, no socket, in tens of
  microseconds. See [`../../crates/elia-native/README.md`](../../crates/elia-native/README.md)
  for the measured catch-rate and latency.
- **`crates/eliad`** — forwards `parse.check` RPCs to the same crate, as a
  fallback for when the cdylib is missing but a daemon is already running.

## Languages

`GENERIC` (C-family) · `JS_TS` (+ backtick templates with `${}`) · `PYTHON`
(hash comments, triple strings, no braces) · `RUST` (nested block comments, raw
strings, lifetime-vs-char) · `GO` (+ backtick raw strings). Unknown file
extensions fall back to `GENERIC`, a safe superset for brace languages.

## Build

Built automatically by `cargo build` / `cargo test` via
`crates/elia-parse/build.rs`. Needs a C++17 compiler (`c++` / `clang++`); on
Windows that is the LLVM-MinGW `clang++` (see `../../.cargo/config.toml`).

For the in-process path, build the cdylib: `cargo build -p elia-native --release`
(or `just build-native`). `src/native/ffi.ts` then finds it in `target/release/`
on its own.
