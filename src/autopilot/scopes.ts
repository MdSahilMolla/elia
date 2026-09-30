import { assessAction } from '../autonomy/governor.ts'
import { capabilityContractFor, type CapabilityScope } from '../autonomy/capabilityContract.ts'
import type { ToolHook } from '../autonomy/devHooks.ts'

/**
 * `elia autopilot --scopes …`: what the autopilot's goal runs may do, by
 * capability scope. Without it the pilot runs as it always has (every tool,
 * under the unattended governor); with it, a tool call that needs a scope it
 * was not given is blocked before it runs. The limit can only take away: the
 * governor still judges everything it lets through.
 */

export const ALL_SCOPES: readonly CapabilityScope[] = ['workspace-read', 'workspace-write', 'process', 'network-read', 'external-write', 'security']

export function parseScopes(text: string): CapabilityScope[] {
  const scopes = text.split(',').map((scope) => scope.trim()).filter(Boolean)
  const unknown = scopes.filter((scope) => !ALL_SCOPES.includes(scope as CapabilityScope))
  if (unknown.length > 0) throw new Error(`unknown scope ${unknown.join(', ')}: use ${ALL_SCOPES.join(', ')}`)
  return scopes as CapabilityScope[]
}

/**
 * The pipeline's own reporting and coordination tools. They have no capability
 * contract because they never touch the world (a proposal, a verdict, a list),
 * and a run that could not use them could not run at all.
 */
const INTERNAL_TOOL = /^(?:submit_|report_)|^(?:task|delegate_tasks|load_tools|todo_write|board_post|board_read)$/

/**
 * The scopes a tool call needs. A built-in tool's come from its capability
 * contract; a shell command the governor rates critical needs `external-write`
 * too (`git push` reads as plain "shell", `curl -X POST -d @file` as a
 * sensitive read: the rating, not the label, decides); a tool with no contract
 * that is not internal (an MCP tool, a synthesized skill) is someone else's
 * system, so it needs `external-write`.
 */
export function scopesNeeded(request: { name: string; input: Record<string, unknown> }): CapabilityScope[] {
  if (INTERNAL_TOOL.test(request.name)) return []
  const needed = new Set<CapabilityScope>(capabilityContractFor(request.name)?.scopes ?? ['external-write'])
  if (request.name === 'run_command' || request.name === 'run_program' || request.name === 'process') {
    if (assessAction(request).risk === 'critical') needed.add('external-write')
  }
  return [...needed]
}

/**
 * A call that would change what the autopilot watches or may do: its own
 * state, its watch list, its service, or its scopes. Seen live (2026-09-30), a
 * limited agent that was blocked from a tool ran the command that grants
 * itself more. Only a person changes these.
 */
const PILOT_CONTROL = /\.elia[\\/]+autopilot\b|\bautopilot\s+(?:watch|install|uninstall)\b|--scopes\b/i

export function touchesPilotControl(request: { input: Record<string, unknown> }): boolean {
  return PILOT_CONTROL.test(JSON.stringify(request.input))
}

export function scopeHook(scopes: readonly CapabilityScope[]): ToolHook {
  const granted = new Set(scopes)
  const hookId = 'autopilot-scope'
  return {
    id: hookId,
    message: "outside the autopilot's scopes",
    evaluate({ request }) {
      if (touchesPilotControl(request)) {
        return { allowed: false, hookId, message: "The autopilot may not change its own state, what it watches, or what it is allowed to do; only a person can. If you need more access, say which in your report and stop there." }
      }
      const missing = scopesNeeded(request).filter((scope) => !granted.has(scope))
      if (missing.length === 0) return undefined
      return {
        allowed: false,
        hookId,
        message: `${request.name} needs ${missing.join(', ')}, which this autopilot was not given (it has ${scopes.join(', ')}). Only a person can grant that. Do the work another way, or say in your report that it needs ${missing.join(', ')} and why.`,
      }
    },
  }
}
