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
import { runCompounding, runDistill, runEvolve, runGap, runJev, runValues, runWorld } from './cli/selfImprove.ts'
import { runConfig, runControl, runSkills, runTrust } from './cli/settings.ts'
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
// `workspace`, `battmann`, and `ds` have their own usage; the rest get their lines
// cut from the global help.
const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h')
if (wantsHelp && subcommand !== 'workspace' && subcommand !== 'battmann' && subcommand !== 'ds' && subcommand !== 'datascience' && subcommand !== 'si' && subcommand !== 'sysintel') {
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

const mcpRequested = rawArgs.includes('--mcp') || rawArgs[0] === 'mcp'

/**
 * An error that gets past every handler is recorded and reported, and the
 * process leaves through the normal shutdown path — see recovery/crashGuard.ts.
 * Installed before any command runs, the MCP server included. That one speaks
 * its protocol on stdout, so its warnings go to stderr as plain text.
 */
async function guardProcess(command: string): Promise<void> {
  const { installCrashGuard } = await import('./recovery/crashGuard.ts')
  const { gracefulShutdown } = await import('./ui/shutdown.ts')
  installCrashGuard({
    command,
    sessionId: () => taskSessions.getActiveSession(),
    ...(command === 'mcp' ? {} : { warn: writeError }),
    exit: (code, message) => void gracefulShutdown(code, () => process.stderr.write(`${message}\n`)),
  })
}

async function main() {
  installShutdownHandlers()
  emitEvent('cli_started', { version: JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version, uiMode: machineReadable ? 'json' : plainOutput ? 'plain' : 'normal' })
  const { flushUsageStats } = await import('./skills/detector.ts')
  // Process-exit handlers must be synchronous, so the flush is registered here,
  // after the module is already loaded.
  process.on('exit', flushUsageStats)

  // A session a person starts is bounded in money by default ($1 unless
  // ELIA_MAX_SPEND_USD says otherwise); bench, evolve and the like are not.
  const { applyDefaultSpendLimit } = await import('./spendLimit.ts')
  applyDefaultSpendLimit(subcommand)

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
    case 'world':
      return runWorld()
    case 'jev':
      return runJev()
    case 'bench':
      return runBench()
    case 'bench-latency':
      return runBenchLatency()
    case 'skills':
      return runSkills()
    case 'trust':
      return runTrust()
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
    case 'ds':
    case 'datascience': {
      const { runDataScience } = await import('./datascience/cli.ts')
      return runDataScience()
    }
    case 'si':
    case 'sysintel': {
      const { runSysintel } = await import('./sysintel/cli.ts')
      return runSysintel()
    }
    case 'trials': {
      const { runTrials } = await import('./trials/cli.ts')
      return runTrials()
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
        // The network bridge is authenticated by default: a `--token` (or
        // ELIA_BRIDGE_TOKEN) is required; without one a random token is
        // generated and printed in the startup notice. ELIA_BRIDGE_ALLOWED_ORIGINS
        // (comma-separated) admits browsers; everything else is refused.
        const token = flagValue('--token') ?? process.env.ELIA_BRIDGE_TOKEN
        const allowedOrigins = (process.env.ELIA_BRIDGE_ALLOWED_ORIGINS ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0)
        const { runHttpBridge } = await import('./bridgeHttp.ts')
        return runHttpBridge({ port, hostname, requireToken: true, token, allowedOrigins })
      }
      const { runVscodeBridge } = await import('./vscodeBridge.ts')
      return runVscodeBridge()
    }
    default:
      return runInteractive()
  }
}

if (mcpRequested) {
  await guardProcess('mcp')
  if (rawArgs[0] === 'mcp') process.argv.splice(2, 1)
  const mcpFlagIndex = process.argv.indexOf('--mcp')
  if (mcpFlagIndex >= 2) process.argv.splice(mcpFlagIndex, 1)
  const { runMcpServerFromCli } = await import('./mcp/server.ts')
  await runMcpServerFromCli()
} else {
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

  await guardProcess(subcommand ?? 'repl')
  // Signal handlers are installed by installShutdownHandlers() so every terminal
  // component follows one cleanup path and returns a conventional interrupt code.
  await main().catch(async (err: unknown) => {
    const { describeCliError } = await import('./cli/errors.ts')
    writeError(describeCliError(err, { command: subcommand }))
    // Only a programming error in elia's own source is kept (recovery/faults.ts):
    // a bad key or an unreachable provider is the environment, not a bug.
    const { recordFault } = await import('./recovery/faults.ts')
    recordFault(err, { source: 'command', command: subcommand ?? 'repl', sessionId: taskSessions.getActiveSession() })
    process.exitCode = 1
  }).finally(async () => {
    const { shutdownMcpTools } = await import('./mcp/registry.ts')
    await shutdownMcpTools()
  })
}
