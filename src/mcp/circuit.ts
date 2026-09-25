/**
 * Circuit breaker for one MCP server.
 *
 * A dead-but-alive server (process up, stdout open, JSON-RPC never answered)
 * otherwise pins every tool call for the full `CALL_TIMEOUT_MS` — an
 * `elia run` would burn 120s per call against a frozen connector, forever.
 * After `threshold` consecutive failures the breaker opens and subsequent calls
 * **fail fast** instead of touching the wire; it closes again after `resetMs`,
 * at which point one call probes the server and either heals the breaker
 * (success) or re-opens it (another failure).
 */
export class CircuitBreaker {
  private consecutive = 0
  /** -1 = never tripped; otherwise the instant (per the injected clock) it last tripped. */
  private trippedAt = -1

  constructor(
    readonly name: string,
    private readonly threshold = 3,
    private readonly resetMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether a new call to the server is allowed through. */
  isOpen(now = this.now()): boolean {
    return this.trippedAt !== -1 && now - this.trippedAt < this.resetMs
  }

  /** A round-trip that completed (even an application-level error) heals the breaker. */
  recordSuccess(): void {
    this.consecutive = 0
    this.trippedAt = -1
  }

  /** A timeout or transport failure counts against the server and may trip it. */
  recordFailure(): void {
    this.consecutive += 1
    if (this.consecutive >= this.threshold) this.trippedAt = this.now()
  }
}