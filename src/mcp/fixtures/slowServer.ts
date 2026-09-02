/**
 * An MCP server over stdio that never answers `initialize` — used by
 * registry.test.ts to prove that a hung server doesn't block startup past the
 * soft deadline. It replies to nothing; it self-exits after a few seconds so the
 * test never leaves a process lingering for the full 30s connect timeout.
 */

export {}

setTimeout(() => process.exit(0), 4_000).unref?.()

for await (const _chunk of process.stdin) {
  // Swallow everything; never respond.
}
