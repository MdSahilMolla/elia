# Build orchestration for Elia's multi-language stack.
#
# The TypeScript conductor in `src/` needs none of this — it runs straight from
# source with `bun`. These recipes build the native layer:
#   - crates/       Rust: the `eliad` daemon (+ later the napi addon)
#   - native/       C/C++: tree-sitter host, embedding host  (WS5+, not yet present)
#   - jvm/          Java: the JVM-project bridge              (WS7+, not yet present)
#
# `just` is optional. `cargo`, `bun`, etc. work directly; this just wires the
# cross-language steps together and pins the targets CI uses.

bun := env_var_or_default("ELIA_BUN", "bun")

# Everything: native layer + a typecheck.
build: build-rust build-jvm
    {{bun}} run typecheck

# The Rust workspace (debug). Release: `just build-rust-release`.
build-rust:
    cargo build --workspace

build-rust-release:
    cargo build --workspace --release

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
