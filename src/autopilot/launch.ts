/**
 * Whether a bare `elia` starts working on its own.
 *
 * Opening elia in a project is enough: the session starts the autopilot as
 * its first turn (you can talk to it while it works; Esc stops it), or picks
 * up the pilot you left if you are still on its branch. It stays a plain
 * session that waits for you whenever starting would be wrong or unwanted:
 *
 *   - you asked for something specific: a prompt, --continue/--resume,
 *     another mode or persona, --chat, or ELIA_AUTOPILOT=off
 *   - there is no terminal to talk to it from
 *   - the folder is not a git repository with a commit to branch from
 *   - there is uncommitted work (the pilot starts from a clean tree, so its
 *     rollbacks can never touch yours) — said in one line, not silently
 *   - it is elia's own checkout, where the people building elia run it all
 *     day and autonomous self-edits need an explicit yes anyway
 */

import { realpathSync } from 'node:fs'
import { openGoals } from './backlog.ts'
import { currentBranchName, dirtyPaths, headSha, isGitWorkTree } from './git.ts'
import { loadPilotState } from './store.ts'

export type LaunchDecision = { start: true; resume: boolean } | { start: false; notice?: string }

export interface LaunchInput {
  root: string
  eliaRoot: string
  env: NodeJS.ProcessEnv
  interactive: boolean
  chat: boolean
  prompt: boolean
  continuing: boolean
  devMode: boolean
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

export function autopilotDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return /^(?:0|off|false|no)$/i.test(env.ELIA_AUTOPILOT?.trim() ?? '')
}

export function decideLaunch(input: LaunchInput): LaunchDecision {
  if (!input.interactive || input.chat || input.prompt || input.continuing || !input.devMode) return { start: false }
  if (autopilotDisabledByEnv(input.env)) return { start: false }
  if (samePath(input.root, input.eliaRoot)) return { start: false }
  if (!isGitWorkTree(input.root)) {
    return { start: false, notice: 'Not a git repository, so the autopilot did not start (it works on a branch of its own and rolls back what breaks). Tell me what to do — or run git init, commit, and /autopilot.' }
  }
  if (!headSha(input.root)) {
    return { start: false, notice: 'This repository has no commits yet, so the autopilot has nothing to branch from. Commit once and run /autopilot, or tell me what to do.' }
  }
  const dirty = dirtyPaths(input.root)
  if (dirty.length > 0) {
    return {
      start: false,
      notice: `You have uncommitted changes (${dirty.length} file${dirty.length === 1 ? '' : 's'}), so the autopilot did not start — it works from a clean tree so its rollbacks can never touch your work. Commit or stash them and run /autopilot, or tell me what to do.`,
    }
  }
  const saved = loadPilotState(input.root)
  const resume = Boolean(saved?.branch && currentBranchName(input.root) === saved.branch && openGoals(saved.backlog).length > 0)
  return { start: true, resume }
}
