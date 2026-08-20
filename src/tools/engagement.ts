import { join } from 'node:path'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { paths } from '../config.ts'

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'engagement'
}

/** Where an engagement's scope, findings, and recon output live — shared with run_security_tool. */
export function engagementDir(slug: string): string {
  return join(paths.workspace, 'engagements', slugify(slug))
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
    const slug = slugify(input.slug as string)
    const dir = engagementDir(slug)
    const target = input.target as string
    const authorizedBy = input.authorizedBy as string
    const scope = input.scope as string
    const recordedAt = new Date().toISOString()

    const scopePath = join(dir, 'SCOPE.md')
    const findingsPath = join(dir, 'findings.md')
    const reportPath = join(dir, 'report.md')
    const reconKeep = join(dir, 'recon', '.gitkeep')

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

    return `Scaffolded engagement "${slug}" at ${dir}
- SCOPE.md — authorization record; stay inside it
- findings.md — log findings here as you go
- report.md — final write-up (delegate to the scribe role via task once testing is done)
- recon/ — raw tool output lands here via run_security_tool`
  },
}
