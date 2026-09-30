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
 *   - it is the first time here: the autopilot's first act is to run the
 *     project's own check commands (its package.json scripts, make, pytest…),
 *     which is repository code. On a folder elia has not worked in on this
 *     machine, that needs one explicit yes — `/autopilot`, or `elia trust` —
 *     and after that (the pilot leaves a state file this machine vouches for)
 *     a bare `elia` starts it again on its own. The yes is kept in the user's
 *     config, never in the repo, so a cloned repository cannot grant it.
 */

import { realpathSync } from 'node:fs'
import { openGoals } from './backlog.ts'
import { currentBranchName, dirtyPaths, headSha, isGitWorkTree } from './git.ts'
import { isFolderTrusted } from '../autonomy/projectTrust.ts'
import { hasUntrustedPilotState, loadPilotState } from './store.ts'

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
  // Only a state this machine's own pilot wrote counts (store.ts), so "has a
  // saved pilot" doubles as "elia has already worked in this folder".
  const saved = loadPilotState(input.root)
  if (!saved && !isFolderTrusted(input.root)) {
    const shipped = hasUntrustedPilotState(input.root) ? ' A saved autopilot state found here was not written by this machine and is ignored.' : ''
    return {
      start: false,
      notice: `First time in this folder, so the autopilot did not start on its own: it begins by running this project's own check commands (its package.json scripts, make, pytest…), which is code from the repository.${shipped} Look them over, then run /autopilot (or elia trust) once to allow it here; after that a bare elia starts it by itself. Or just tell me what to do.`,
    }
  }
  const resume = Boolean(saved?.branch && currentBranchName(input.root) === saved.branch && openGoals(saved.backlog).length > 0)
  return { start: true, resume }
}
