# Build orchestration for Elia's multi-language stack.
#
# The TypeScript conductor in `src/` needs none of this — it runs straight from
# source with `bun`. These recipes build the native layer:
#   - crates/eliad        Rust: the resident daemon (warm shells, MCP supervisor)
#   - crates/elia-parse   Rust: safe bindings for the C++ structural validator
#   - crates/elia-native  Rust: cdylib the TS side dlopen's via bun:ffi
#   - native/elia-parse   C++: the structural edit-check scanner
#   - jvm/elia-jvm-bridge Java: JDK-compiler type-check for .java edits
#   - go/elia-index       Go: workspace-search sidecar (pilot, opt-in)
#
# `just` is optional. `cargo`, `bun`, etc. work directly; this just wires the
# cross-language steps together and pins the targets CI uses.

bun := env_var_or_default("ELIA_BUN", "bun")

# Everything: native layer + a typecheck.
build: build-rust build-jvm
    {{bun}} run typecheck

# The Rust workspace (debug). Release: `just build-rust-release`.
# Building the whole workspace also builds `elia-native`; the TS side finds the
# cdylib in target/{release,debug}/ on its own (see src/native/ffi.ts).
build-rust:
    cargo build --workspace

build-rust-release:
    cargo build --workspace --release

# Just the in-process structural-check library (release), for `src/native/ffi.ts`.
build-native:
    cargo build -p elia-native --release

# elia-index — Go workspace-search sidecar (pilot). Local-build only; nothing
# in the npm package depends on it. Needs a Go toolchain >= 1.23.
build-go:
    cd go && go build -o bin/elia-index{{ if os() == "windows" { ".exe" } else { "" } }} ./cmd/elia-index

test-go:
    cd go && go vet ./... && go test ./...

# elia-jvm-bridge — plain javac + jar (no Gradle needed yet).
build-jvm:
    cd jvm/elia-jvm-bridge && \
      mkdir -p build/classes && \
      javac -d build/classes $(find src -name '*.java') && \
      jar --create --file build/elia-jvm-bridge.jar \
        --main-class com.elia.jvmbridge.Bridge -C build/classes .

# All tests: Rust unit + integration, then the full TypeScript suite.
test: test-rust test-ts

test-rust:
    cargo test --workspace

test-ts:
    {{bun}} test src/

# The suite must stay green with the native layer forced off.
test-ts-nonative:
    ELIA_NO_NATIVE=1 ELIA_DAEMON=off {{bun}} test src/

# Lint + format checks, matching CI.
check:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    {{bun}} run typecheck

fmt:
    cargo fmt --all

# Stop a running daemon (useful after manual testing).
daemon-stop:
    cargo run -q -p eliad -- stop
