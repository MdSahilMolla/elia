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

`crates/eliad` links the Rust crate and forwards `parse.check` RPCs to it. Later
it will also be compiled into the in-process `elia-native` napi addon so
`edit_file` can call it without a socket hop.

## Languages

`GENERIC` (C-family) · `JS_TS` (+ backtick templates with `${}`) · `PYTHON`
(hash comments, triple strings, no braces) · `RUST` (nested block comments, raw
strings, lifetime-vs-char) · `GO` (+ backtick raw strings). Unknown file
extensions fall back to `GENERIC`, a safe superset for brace languages.

## Build

Built automatically by `cargo build` / `cargo test` via
`crates/elia-parse/build.rs`. Needs a C++17 compiler (`c++` / `clang++`); on
Windows that is the LLVM-MinGW `clang++` (see `../../.cargo/config.toml`).
