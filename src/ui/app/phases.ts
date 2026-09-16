// What the autonomous pipeline's phase reports say on the status row.
//
// report.ts phrases phases for the `elia auto` log ("◆ Orienting — run
// 2026-09-15-jcyc-l2bb", "◆ Scaffolding — checking 3 assumption(s) the plan
// rests on"). In the REPL they sit next to a spinner, where the ◆ is a second
// spinner, the run id is noise, and the pipeline's own vocabulary reads as
// jargon. This turns them into what is actually happening, in plain words.

const RUN_ID = /\s+—\s+run\s+\S+$/

const PHASES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Orienting\b/, () => 'Researching the request'],
  [/^Planning\b/, () => 'Drafting a plan'],
  [/^Scaffolding\s+—\s+checking\s+(\d+)\s+assumption\(s\)/, (m) => `Checking the ${m[1]} assumption${m[1] === '1' ? '' : 's'} the plan rests on`],
  [/^Scaffolding\b/, () => 'Setting up the project'],
  [/^Working\s+—\s+(.+)$/, (m) => `Building — ${m[1]}`],
  [/^Working\b/, () => 'Building'],
  [/^Verifying\s+—\s+(.+)$/, (m) => `Checking the result — ${m[1]}`],
  [/^Verifying\b/, () => 'Checking the result'],
  [/^Repairing\s+—\s+(\w+)\s+attempt\s+(\d+)\s+of\s+(\d+)/, (m) => `Fixing what the ${m[1]} check found — try ${m[2]} of ${m[3]}`],
  [/^Repairing\b/, () => 'Fixing what the checks found'],
  [/^Learning\b/, () => 'Saving what this run learned'],
  [/^polish\b/i, () => 'Polishing'],
  [/^publish\b/i, () => 'Publishing to GitHub'],
]

/** "◆ Orienting — run 2026-…" → "Researching the request". Unknown phases pass through without the ◆. */
export function friendlyPhase(text: string): string {
  const bare = text.replace(/^◆\s*/, '').replace(RUN_ID, '').trim()
  for (const [pattern, say] of PHASES) {
    const match = pattern.exec(bare)
    if (match) return say(match)
  }
  return bare
}

/**
 * elia's notes to itself about steering the model ("elia: told the model to
 * stop re-reading files", "elia: run directive applied"). Diagnostics for the
 * line-mode log; on the status row they only replace what is really happening.
 */
export function isInternalNudge(text: string): boolean {
  return /^elia:\s/.test(text.trim())
}
