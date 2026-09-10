# elia-index (Go pilot)

Elia's Go workspace-search sidecar: a short-lived stdio process speaking one
line of NDJSON in, one line out. It backs the preferred tier of the `grep`
tool when `ELIA_GO_INDEX=auto` (or `require`) and a binary is present — with
automatic fallback to ripgrep and then the pure-JS scan on any transport
problem. Nothing depends on it for correctness.

## Contract

Methods over stdin/stdout NDJSON (`{id, method, params}` →
`{id, protocol, result?, error?}`), mirroring `src/goindex/types.ts`:

| Method | Params | Result |
| --- | --- | --- |
| `index.info` | – | `{ version, protocol }` |
| `index.query` | `{ pattern, dir, glob?, context? }` | `{ matches: [{ rel, line, sep, text }], truncated, skippedLarge, skippedBinary }` |

- `protocol` is `GO_PROTOCOL_VERSION` (1). Mismatch → client falls back.
- Error `-32602` (bad pattern, bad bounds) surfaces as a plain error, exactly
  like the other backends. Any other failure → fallback tier.
- `dir` must exist and be a directory; symlinks are never followed; paths
  escaping the root are refused. Skip lists mirror `src/tools/ignoreDirs.ts`;
  sensitive-path filtering is re-applied by the TypeScript formatter.

## Build / test

```
cd go && go build -o bin/elia-index.exe ./cmd/elia-index  # .exe on Windows, plain name elsewhere
go test ./...
gofmt -l . && go vet ./...
```

Or via just: `just build-go`, `just test-go`. Requires a Go toolchain ≥ 1.23
(pinned by `go.mod`); CI installs it from `go-version-file`.

## Known divergences from the pure-JS backend

- Patterns use RE2: lookaheads/lookbehinds/backreferences fail to compile and
  report `invalid regular expression:` (same surface, narrower grammar).
- Trailing `\r` is stripped per line (matches the ripgrep tier; the pure-JS
  tier keeps it).
- Symlinked files/directories are skipped; dotfiles are skipped
  (`Bun.Glob scan({dot:false})` parity for the common cases).
- NUL-containing files count as `skippedBinary` (ripgrep skips binaries too;
  the pure-JS tier does not special-case them).
- Walk order is lexical; past the 200-match cap the surviving set can differ
  between backends on huge trees.

## Release checklist (before this ships in the npm package)

- [ ] `scripts/bench-go-index.ts` shows ≥2× p95 win over the best existing
      backend on a large-repo fixture, with no token-cost regression
- [ ] `src/goindex/client.test.ts` happy path green on ubuntu + windows CI
- [ ] `package.json` `files` + platform-package lookup (`resolveGoIndexPath`)
      extended to published `@elia/native-*` binaries
- [ ] This checklist reviewed; a second Go service needs its own gate
