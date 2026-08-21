import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runSubAgent } from '../subagent.ts'
import { clampOutput, runShell } from '../shell.ts'
import { registerSynthesizedTool } from '../tools/registry.ts'
import { markResolved, type SkillCandidate } from './detector.ts'
import { loadSkillFile, registerLoadedSkill } from './loader.ts'
import { QUARANTINE_DIR, SKILL_SUFFIX, USER_SKILLS_DIR } from './paths.ts'

/**
 * Writes elia a new tool for something it keeps doing by hand.
 *
 * This is the half of skill synthesis that costs money, so it is deliberately
 * separate from detection and never runs on its own: the detector accumulates
 * evidence for free, and synthesis is invoked when there is a habit worth
 * encoding.
 *
 * A synthesized skill is only kept if it survives the same gate a human
 * contribution would — it has to import cleanly, expose a valid tool schema, and
 * pass a test that the builder wrote and that actually ran. Anything else is
 * quarantined. Without that gate this feature would quietly fill the model's tool
 * list with plausible-looking tools that fail the first time they matter.
 */

const SKILL_TEST_TIMEOUT_MS = 120_000

export interface SynthesisResult {
  ok: boolean
  toolName?: string
  file?: string
  detail: string
}

export async function synthesizeSkill(candidate: SkillCandidate): Promise<SynthesisResult> {
  mkdirSync(USER_SKILLS_DIR, { recursive: true })

  const slug = slugify(candidate.pattern)
  const skillFile = join(USER_SKILLS_DIR, `${slug}${SKILL_SUFFIX}`)
  const testFile = join(USER_SKILLS_DIR, `${slug}.skill.test.ts`)

  if (existsSync(skillFile)) {
    return { ok: false, detail: `a skill for "${candidate.pattern}" already exists at ${skillFile}` }
  }

  const worker = await runSubAgent({
    role: 'builder',
    name: 'builder#skill',
    prompt: buildPrompt(candidate, skillFile, testFile),
  })

  if (!existsSync(skillFile)) {
    return { ok: false, detail: `builder did not create ${skillFile}. Its report: ${worker.report}` }
  }

  // Gate 1: the test the builder wrote has to pass. Run from elia's own root so
  // Bun resolves as it does in normal use.
  if (existsSync(testFile)) {
    const test = await runShell(`bun test "${testFile}"`, SKILL_TEST_TIMEOUT_MS)
    if (test.exitCode !== 0) {
      quarantine(skillFile, testFile)
      return {
        ok: false,
        detail: `the skill's own test failed, so it was quarantined:\n${clampOutput(test.stderr || test.stdout, 1500)}`,
      }
    }
  }

  // Gate 2: it has to import and be a structurally valid tool.
  const loaded = await loadSkillFile(skillFile)
  if ('reason' in loaded) {
    quarantine(skillFile, testFile)
    return { ok: false, detail: `the skill did not load, so it was quarantined: ${loaded.reason}` }
  }

  registerSynthesizedTool(loaded.tool)
  registerLoadedSkill({ name: loaded.tool.name, file: skillFile, source: 'user' })
  markResolved(candidate.pattern)

  return {
    ok: true,
    toolName: loaded.tool.name,
    file: skillFile,
    detail: `${loaded.tool.name} is available now, in this session and every future one.`,
  }
}

function buildPrompt(candidate: SkillCandidate, skillFile: string, testFile: string): string {
  const evidence =
    candidate.kind === 'command'
      ? `elia has run shell commands of the shape \`${candidate.pattern}\` ${candidate.count} times. Real examples:\n${candidate.examples.map((example) => `  $ ${example}`).join('\n')}`
      : `elia has run the tool sequence \`${candidate.pattern}\` ${candidate.count} times as a routine, meaning it takes ${candidate.pattern.split('→').length} model round-trips every time it does this.`

  return `Write elia a new tool that collapses a routine it keeps performing by hand into a single call.

## The evidence
${evidence}

## What to produce
Create exactly two files:

1. \`${skillFile}\` — the tool.
2. \`${testFile}\` — a Bun test for it.

## The tool file's contract, exactly

\`\`\`ts
export default {
  name: 'lower_snake_case_name',
  description: 'What it does and when the model should reach for it, written for a model deciding between tools.',
  input_schema: {
    type: 'object',
    properties: { /* JSON Schema per parameter, each with a description */ },
    required: ['...'],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    // Return a string. Throw an Error on failure.
  },
}
\`\`\`

Hard requirements:
- The file must be **self-contained**. Import only \`node:\` builtins; use the \`Bun\` global for spawning and file I/O. It lives outside elia's source tree, so it CANNOT import anything from elia — no \`../tools/types.ts\`, no relative imports at all.
- Default-export the tool object.
- \`execute\` returns a string and throws a real \`Error\` with a useful message on failure. Never return a string that says "error" while succeeding.
- Validate and narrow \`input\` yourself; it is untyped and the model may pass anything.
- Parameterise what actually varies across the examples above, and give sensible defaults for the rest. The point is one call instead of many, so do not just wrap a shell string the model has to assemble anyway.
- Return output the *model* can act on: parsed, trimmed, and summarised where the raw form is noisy. Cap very long output rather than returning megabytes.
- Do not make it interactive, and do not make it destructive. If the routine involves a destructive step, take a parameter that defaults to a dry run.

## The test file
Use \`import { expect, test } from 'bun:test'\` and import the tool from \`./${skillFile.split(/[/\\]/).pop()}\`.
Test the real behaviour on a temporary directory or fixture you create in the test — not mocks of your own code. Cover at least one success case and one failure case (bad input should throw). The test must pass when run as \`bun test "${testFile}"\` from any directory, so make every path in it absolute or derived from \`import.meta.dir\`.

Write both files, then run the test yourself with run_command and fix it until it passes. Report the tool's name and what it does.`
}

function quarantine(skillFile: string, testFile: string): void {
  try {
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    const stamp = Date.now()
    renameSync(skillFile, join(QUARANTINE_DIR, `${stamp}-${skillFile.split(/[/\\]/).pop()}`))
    if (existsSync(testFile)) {
      renameSync(testFile, join(QUARANTINE_DIR, `${stamp}-${testFile.split(/[/\\]/).pop()}`))
    }
  } catch {
    // Best effort: if it can't be moved, remove it so it can't be loaded next start.
    try {
      rmSync(skillFile, { force: true })
    } catch {
      // Nothing further to do; the loader's own validation is the backstop.
    }
  }
}

function slugify(pattern: string): string {
  return (
    pattern
      .toLowerCase()
      .replace(/→/g, '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  )
}
