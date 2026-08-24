import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { clampOutput, formatShellResult, runShell } from '../shell.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { engagementDir } from './engagement.ts'
import { currentAgent } from '../autonomy/context.ts'
import { redactSecrets } from '../ui/redact.ts'

const SCAN_TIMEOUT_MS = 5 * 60_000
const MAX_SCAN_INPUT_LENGTH = 100_000

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
    if (typeof input.engagement !== 'string' || input.engagement.trim().length === 0) throw new Error('engagement must be a non-empty string')
    if (typeof input.label !== 'string' || input.label.trim().length === 0) throw new Error('label must be a non-empty string')
    if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('command must be a non-empty string')
    if (input.command.length > MAX_SCAN_INPUT_LENGTH) throw new Error(`command exceeds ${MAX_SCAN_INPUT_LENGTH} characters`)
    const engagement = input.engagement
    const label = input.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 120) || 'run'
    const command = input.command
    const dir = engagementDir(engagement)

    if (!existsSync(join(dir, 'SCOPE.md'))) {
      return `No engagement "${engagement}" found (missing ${join(dir, 'SCOPE.md')}). Run new_engagement first — it records what you're authorized to test before any scan runs.`
    }

    const result = await runShell(command, SCAN_TIMEOUT_MS, currentAgent().cwd, currentAgent().signal)
    const logPath = join(dir, 'recon', `${Date.now()}-${label}.log`)
    await captureBeforeWrite(logPath)
    const evidence = redactSecrets(formatShellResult(result))
    await Bun.write(logPath, `$ ${redactSecrets(command)}\n\n${evidence}`)

    return `Saved full output to ${logPath}\n\n${clampOutput(evidence, 2000)}`
  },
}
