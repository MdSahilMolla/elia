/**
 * When the user pushes back on the last answer — "you're hallucinating", "that's
 * wrong", "no you didn't" — the failure mode (especially on a weaker model) is
 * to re-run the same shallow checks and restate the same claim more
 * confidently. This detects that pushback and injects a directive to re-verify
 * from scratch and concede if wrong, rather than defend.
 *
 * Deterministic phrase match, folded into the per-turn system suffix.
 */

const DISPUTE = new RegExp(
  [
    /you(?:'re| are| r)?\s+(?:hallucinat\w*|wrong|lying|mistaken|incorrect|making (?:it|that|this) up|confus\w*)/,
    /that(?:'s| is)\s+(?:wrong|incorrect|false|a lie|not (?:right|true|correct))/,
    /no,?\s+you\s+(?:did ?n[o']?t|are ?n[o']?t|have ?n[o']?t)/,
    /stop (?:lying|hallucinat\w*|making (?:it|stuff|things) up)/,
    /(?:it'?s|there'?s|there is) (?:not there|no such|nothing there)/,
    /(?:doesn'?t|did ?n[o']?t|does not) (?:exist|happen|work|show)/,
    /not (?:true|correct|right)\b/,
    /that(?:'s| is)? not what/,
  ].map((r) => r.source).join('|'),
  'i',
)

export function isDispute(message: string): boolean {
  return DISPUTE.test(message)
}

export function disputeNudge(latestUserMessage: string): string {
  if (!isDispute(latestUserMessage)) return ''
  return `\n\n## The user is disputing your last response\nDo not restate your previous claim or just re-run the same checks. Assume you may be wrong. Re-verify from first principles: check the actual working directory with an absolute path, list or read the real files involved, and run the real command rather than reasoning about it. If the evidence shows you were wrong, say so plainly and correct it. If it confirms you were right, show the concrete evidence (exact paths, exact command output), not a re-assertion.`
}
