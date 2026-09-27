#!/usr/bin/env bun
// First, before any import that resolves the provider — see bootstrapEnv.ts.
import './bootstrapEnv.ts'
import { writeError } from './ui/stream.ts'

import { updateTerminalTaskTitle } from './ui/taskDashboard.ts'
import { taskSessions } from './taskSessions.ts'
import { emitEvent, machineReadable, plainOutput } from './ui/runtime.ts'
import { installShutdownHandlers } from './ui/shutdown.ts'
import { args, flagValue, hasFlag, rawArgs, strictInteger, subcommand } from './cli/argv.ts'
import { printHelp } from './cli/help.ts'
import { runCodexLogin } from './cli/providerSetup.ts'
import { runInteractive } from './cli/interactive.ts'
import { runBench, runBenchLatency } from './cli/bench.ts'
import { runCompounding, runDistill, runEvolve, runGap, runJev, runValues } from './cli/selfImprove.ts'
import { runConfig, runControl, runSkills } from './cli/settings.ts'
import { runDaemon, runDoctor, runSchedule } from './cli/ops.ts'
import { runFork, runResume, runRuns, runSessionsList } from './cli/sessions.ts'
import { runAgentCommand, runAuto } from './cli/agent.ts'

// These three run before anything else in the process: they are the only flags
// that must work when no provider is configured and no session exists. They
// live here rather than beside printHelp because `--help` exiting the process
// is a dispatcher decision, not a property of the help text — and because
// `new URL('../package.json', import.meta.url)` below is resolved relative to
// this file, so moving it one directory deeper silently reads a path that does
// not exist.
//
// `--help` after a command is that command's help. It used to be answered
// before the command was even looked at, so `elia workspace --help` — which the
// global help itself tells you to run — printed the global help instead.
// `workspace` and `battmann` have their own usage; the rest get their lines
// cut from the global help.
const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h')
if (wantsHelp && subcommand !== 'workspace' && subcommand !== 'battmann') {
  printHelp(subcommand)
  process.exit(0)
}

// `-v` is the version only on its own: after a command it is that command's
// argument, not a request to print the version and exit.
if (rawArgs[0] === '--version' || rawArgs[0] === '-v' || (subcommand === undefined && rawArgs.includes('--version'))) {
  const pkg = JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text())
  console.log(pkg.version)
  process.exit(0)
}

// `--profile-turns` is a session-wide diagnostic: every model round-trip records
// its cache-read/write split and time-to-first-token, and a table prints at the
// end. Distinct from `elia auto --profile <fast|balanced|thorough>`, which
// selects a run profile. `ELIA_PROFILE=1` in the environment does the same.
if (hasFlag('--profile-turns')) process.env.ELIA_PROFILE = '1'

async function main() {
  installShutdownHandlers()
  emitEvent('cli_started', { version: JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version, uiMode: machineReadable ? 'json' : plainOutput ? 'plain' : 'normal' })
  const { flushUsageStats } = await import('./skills/detector.ts')
  // Process-exit handlers must be synchronous, so the flush is registered here,
  // after the module is already loaded.
  process.on('exit', flushUsageStats)

  await taskSessions.load()
  updateTerminalTaskTitle(taskSessions)
  taskSessions.subscribe(() => updateTerminalTaskTitle(taskSessions))

  switch (subcommand) {
    case 'auto':
      return runAuto()
    case 'autopilot': {
      const { runAutopilotCommand } = await import('./cli/autopilot.ts')
      return runAutopilotCommand()
    }
    case 'agent':
      return runAgentCommand()
    case 'evolve':
      return runEvolve()
    case 'gap':
      return runGap()
    case 'values':
      return runValues()
    case 'distill':
      return runDistill()
    case 'compounding':
      return runCompounding()
    case 'jev':
      return runJev()
    case 'bench':
      return runBench()
    case 'bench-latency':
      return runBenchLatency()
    case 'skills':
      return runSkills()
    case 'runs':
      return runRuns()
    case 'sessions':
      return runSessionsList()
    case 'fork':
      return runFork()
    case 'resume':
      return runResume()
    case 'schedule':
      return runSchedule()
    case 'daemon':
      return runDaemon()
    case 'doctor':
      return runDoctor()
    case 'config':
      return runConfig()
    case 'codex-login':
      await runCodexLogin()
      return
    case 'control':
      return runControl()
    case 'workspace': {
      const { runWorkspace } = await import('./workspace/cli.ts')
      return runWorkspace(args)
    }
    case 'battmann': {
      const { runBattmann } = await import('./battmann/cli.ts')
      return runBattmann()
    }
    case 'bridge': {
      if (hasFlag('--http')) {
        const portRaw = flagValue('--port') ?? '4319'
        const port = strictInteger(portRaw)
        if (port === undefined || port < 1 || port > 65535) {
          writeError('--port must be an integer between 1 and 65535')
          process.exitCode = 1
          return
        }
        const hostname = flagValue('--host')
        const { runHttpBridge } = await import('./bridgeHttp.ts')
        return runHttpBridge({ port, hostname })
      }
      const { runVscodeBridge } = await import('./vscodeBridge.ts')
      return runVscodeBridge()
    }
    default:
      return runInteractive()
  }
}

// Sweep temp files orphaned by earlier crashed writes. Only temps whose owning
// process is gone are removed, so a concurrently running elia is never touched.
// Without this they accumulate silently and are never cleaned up by anything.
try {
  const { sweepStaleTemporaries } = await import('./securePersistence.ts')
  const { isProcessAlive } = await import('./fileLock.ts')
  const { paths: statePaths } = await import('./config.ts')
  sweepStaleTemporaries(statePaths.state, isProcessAlive)
} catch {
  // Housekeeping is never a reason to fail a command.
}

// Signal handlers are installed by installShutdownHandlers() so every terminal
// component follows one cleanup path and returns a conventional interrupt code.

await main().catch(async (err: unknown) => {
  const { describeCliError } = await import('./cli/errors.ts')
  writeError(describeCliError(err, { command: subcommand }))
  process.exitCode = 1
}).finally(async () => {
  const { shutdownMcpTools } = await import('./mcp/registry.ts')
  await shutdownMcpTools()
})
