/**
 * The one canonical list of control-flow reporting tools.
 *
 * These are the tools that write to the goal graph rather than to the outside
 * world, so replaying one is harmless — there is no duplicate side effect for
 * idempotency to protect against, and never asking a reviewer to "repeat
 * itself" is what keeps `requireCriticVerdict` satisfiable.
 *
 * The consequence of getting it wrong was severe and silent. A reviewer that
 * approves twice with the same wording produces an identical call, so the
 * second review round replays it: the tool body never runs, nothing is
 * captured, and `requireCriticVerdict` correctly fails closed with
 * "submit_verdict was never called". Every subsequent round does the same, so
 * once a run enters its repair loop the review gate can no longer be satisfied
 * by any reviewer, and the run exhausts its repair budget and ends
 * `needs-attention`. Observed in the recorded history as `reviewPassed: false`
 * on ten of eleven runs, and reproduced end to end: round 1 `replayed=false`
 * (verdict captured), rounds 2 and 3 `replayed=true` (all three reviewers
 * reported as never having spoken).
 *
 * A leaf module on purpose. Two consumers need it — the governor (to allow
 * "safe" reporting tools through unattended policy) and the goal graph (to
 * exclude them from replay deduplication) — and goalGraph.ts sits above
 * governor.ts in the import graph, so neither could import the other's literal
 * without a cycle. Putting the list here lets both read the same source, so
 * the two can no longer drift.
 */
export const REPORTING_TOOLS: ReadonlySet<string> = new Set([
  'submit_proposal',
  'submit_verdict',
  'submit_acceptance',
  'submit_assumptions',
  'submit_lessons',
  'submit_route',
  'submit_fragment',
  'submit_hypothesis',
  'submit_strategy',
  'revise_plan',
])

export function isReportingTool(name: string): boolean {
  return REPORTING_TOOLS.has(name)
}