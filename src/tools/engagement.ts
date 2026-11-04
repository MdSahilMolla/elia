import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { paths } from '../config.ts'

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'engagement'
}

/** Where an engagement's scope, findings, and recon output live — shared with run_security_tool. */
export function engagementDir(slug: string, root = paths.workspace): string {
  return join(root, 'engagements', slugify(slug))
}

/** Directory that holds `<slug>/` folders under the workspace. */
export function engagementRootDir(): string {
  return join(paths.workspace, 'engagements')
}

export interface EngagementRecord {
  slug: string
  target: string
  authorizedBy: string
  scope: string
}

/**
 * Write the four scaffold files for an engagement and return its directory.
 *
 * Extracted from the tool body so `run_security_tool` can scaffold a local-file
 * engagement on the caller's behalf. The scope text it records in that case is
 * deliberately machine-checkable rather than a real authorization claim, and
 * says so on its face — see `localEngagementRecord`.
 */
export async function writeEngagementScaffold(values: EngagementRecord, root = paths.workspace): Promise<string> {
  const slug = slugify(values.slug)
  const dir = engagementDir(slug, root)
  const { target, authorizedBy, scope } = values
  const recordedAt = new Date().toISOString()

  const scopePath = join(dir, 'SCOPE.md')
  const findingsPath = join(dir, 'findings.md')
  const reportPath = join(dir, 'report.md')
  const reconKeep = join(dir, 'recon', '.gitkeep')
  if (existsSync(scopePath)) throw new Error(`engagement "${slug}" already exists; refusing to overwrite its authorization record`)

  const scopeContent = `# Engagement scope: ${slug}

**Target:** ${target}
**Authorized by:** ${authorizedBy}
**Recorded:** ${recordedAt}

## Rules of engagement
${scope}

---
Every action in this engagement must stay inside this scope. If a target, host, or
technique isn't covered above, stop and ask before touching it.
`
  const findingsContent = `# Findings: ${slug}

<!-- Append one entry per finding as you go: title, severity, description, evidence, remediation. -->
`
  const reportContent = `# Security assessment report: ${slug}

**Target:** ${target}
**Date:** ${recordedAt.slice(0, 10)}

## Scope
${scope}

## Executive summary
_TODO_

## Findings
_Summarize and prioritize findings.md by severity here once testing is complete._

## Recommendations
_TODO_
`

  for (const path of [scopePath, findingsPath, reportPath, reconKeep]) await captureBeforeWrite(path)
  await Bun.write(scopePath, scopeContent)
  await Bun.write(findingsPath, findingsContent)
  await Bun.write(reportPath, reportContent)
  await Bun.write(reconKeep, '')

  return dir
}

/**
 * The record written when a run names a local artifact and no engagement exists.
 *
 * The authorization line is the honest part: an auto-scaffolded engagement is
 * NOT a claim that a person granted anything, and it does not pretend otherwise.
 * It records that the only thing in scope is a file on this machine, which is
 * the one case where no network target is touched and therefore nothing outside
 * the workspace is at stake. A command that names any host still has to go
 * through new_engagement, where a person states who authorized it.
 */
export function localEngagementRecord(slug: string, artifact: string): EngagementRecord {
  return {
    slug,
    target: `local artifact ${artifact}`,
    authorizedBy: 'not applicable — no network target; analysis is confined to a file on this machine',
    scope: `Only the local artifact \`${artifact}\` is in scope. No host, network, or third-party system is authorized by this record. If the work needs to reach a live target, stop and run new_engagement with a real authorization.`,
  }
}

export const newEngagementTool: Tool = {
  name: 'new_engagement',
  description:
    "Scaffold a new authorized security engagement under workspace/engagements/<slug>/. Run this before any recon or testing — it records what you're authorized to do, and run_security_tool refuses to run for an engagement that hasn't been scaffolded. Creates SCOPE.md (the authorization record every action must stay inside), findings.md, report.md, and a recon/ folder for raw tool output.",
  input_schema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Short filesystem-safe id for this engagement, e.g. "acme-webapp-2026-08"' },
      target: { type: 'string', description: 'What is in scope — hosts, domains, IP ranges, or repo/app name' },
      authorizedBy: {
        type: 'string',
        description: 'Who authorized this and how, e.g. "signed SOW with Acme Corp", "own lab VM", "HackTheBox account"',
      },
      scope: {
        type: 'string',
        description: 'Rules of engagement: what is explicitly in scope and out of scope, testing window, any constraints',
      },
    },
    required: ['slug', 'target', 'authorizedBy', 'scope'],
  },
  async execute(input) {
    const values: Record<'slug' | 'target' | 'authorizedBy' | 'scope', string> = {
      slug: '',
      target: '',
      authorizedBy: '',
      scope: '',
    }
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      const value = input[key]
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
      if (value.length > 20_000) throw new Error(`${key} exceeds 20000 characters`)
      values[key] = value.trim()
    }
    const slug = slugify(values.slug)
    const recordedAt = new Date().toISOString()
    const dir = await writeEngagementScaffold({ ...values, slug }, paths.workspace)

    return `Scaffolded engagement "${slug}" at ${dir}
- SCOPE.md — authorization record; stay inside it
- findings.md — log findings here as you go
- report.md — final write-up (delegate to the scribe role via task once testing is done)
- recon/ — raw tool output lands here via run_security_tool`
  },
}
