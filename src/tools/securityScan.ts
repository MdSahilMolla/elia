import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { clampOutput, formatShellResult, runShell } from '../shell.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { engagementDir } from './engagement.ts'

const SCAN_TIMEOUT_MS = 5 * 60_000

export const runSecurityToolTool: Tool = {
  name: 'run_security_tool',
  description:
    "Run a security tool (nmap, curl, openssl, nuclei, sqlmap, gobuster, whatever's installed) for an authorized engagement and save the raw output under that engagement's recon/ folder, so evidence stays organized instead of scrolling past in the terminal. Requires new_engagement to have been run first for this engagement slug. Times out after 5 minutes — scope a long scan down (fewer ports, smaller wordlist) rather than relying on this to wait forever.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      label: { type: 'string', description: 'Short label for this run, e.g. "nmap-full-tcp" — used in the saved filename' },
      command: { type: 'string', description: 'The shell command to run' },
    },
    required: ['engagement', 'label', 'command'],
  },
  async execute(input) {
    const engagement = input.engagement as string
    const label = (input.label as string).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'run'
    const command = input.command as string
    const dir = engagementDir(engagement)

    if (!existsSync(join(dir, 'SCOPE.md'))) {
      return `No engagement "${engagement}" found (missing ${join(dir, 'SCOPE.md')}). Run new_engagement first — it records what you're authorized to test before any scan runs.`
    }

    const result = await runShell(command, SCAN_TIMEOUT_MS)
    const logPath = join(dir, 'recon', `${Date.now()}-${label}.log`)
    await captureBeforeWrite(logPath)
    await Bun.write(logPath, `$ ${command}\n\n${formatShellResult(result)}`)

    return `Saved full output to ${logPath}\n\n${clampOutput(formatShellResult(result), 2000)}`
  },
}
