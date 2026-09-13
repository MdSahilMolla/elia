/**
 * Credentials with a recognisable, issuer-defined shape — the one list both
 * secret sweepers use: `scripts/security-scan.ts` (tracked files, in CI) and
 * `src/autonomy/hygiene.ts` (what an autonomous run is about to deliver).
 *
 * They used to keep separate copies that had drifted: the repo scan's Slack
 * pattern expected `xoxb_…` (real tokens are `xoxb-…`) so it could never fire,
 * and it had no Google, Stripe, AWS-STS or `gho_/ghs_/ghr_` GitHub formats at
 * all. A match here is a real key, not a guess: a false positive would have to
 * be a deliberately constructed lookalike.
 */
export const KNOWN_KEY_FORMATS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'an OpenAI API key', pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: 'a private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
]
