#!/usr/bin/env bun
import { writeError } from './ui/stream.ts'

import { updateTerminalTaskTitle } from './ui/taskDashboard.ts'
import { taskSessions } from './taskSessions.ts'
import { emitEvent, machineReadable, plainOutput } from './ui/runtime.ts'
import { installShutdownHandlers } from './ui/shutdown.ts'
import { loadUserConfig } from './userConfig.ts'
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
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  printHelp()
  process.exit(0)
}

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
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
    case 'vde': {
      const { runVde } = await import('./cli/vde.ts')
      return runVde()
    }
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

// Load ~/.elia/config.env before any command imports provider configuration. Explicit
// project/process environment values already present in process.env take precedence.
loadUserConfig()

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

await main().catch((err: unknown) => {
  writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}).finally(async () => {
  const { shutdownMcpTools } = await import('./mcp/registry.ts')
  await shutdownMcpTools()
})
