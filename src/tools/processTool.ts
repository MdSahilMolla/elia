import { randomBytes } from 'node:crypto'
import type { Tool } from './types.ts'
import { shellInvocation, terminateProcessGroup } from '../shell.ts'
import { currentAgent, resolveProjectPath } from '../autonomy/context.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'

/**
 * Long-running processes — the thing elia could never do.
 *
 * `run_command` is request/response with a timeout, and its own description
 * tells the model not to start dev servers because they never exit. There was
 * no other option, so elia never watched anything run: no dev server, no
 * watcher, no queue worker, no tailing a log while reproducing a bug. `preview`
 * papered over the gap for web pages by building and serving static output,
 * which turns the loop into *build, then assume* instead of *run, observe, fix*.
 *
 * This holds processes open instead. `start` spawns one and returns
 * immediately; output is drained continuously into a bounded ring buffer, so
 * `logs` can be read at any point without the pipes ever filling and blocking
 * the child. Everything started is killed on shutdown — a dev server outliving
 * the session that started it is how ports end up mysteriously occupied.
 *
 * `send` is the other half of that: stdin is a retained pipe, not `ignore`, so
 * a process that reads commands — a debugger, a REPL, an interactive prompt —
 * can actually be driven. `gdb ./app` is a long-running process in the sense
 * above (it never exits on its own), and without a way to type into it elia
 * could start one and do nothing with it. Batched, scripted debugging
 * (`gdb -batch -x script ./app`) needs no typing at all and still runs
 * correctly; `send` is for the session-shaped case.
 */

/** Log lines kept per process. A dev server's startup banner plus a good stretch of request log. */
const MAX_LOG_LINES = 1_000
/** Hard ceiling on concurrently running processes, so a loop that keeps calling `start` cannot fork-bomb the machine. */
const MAX_PROCESSES = 10
/** How long to wait after a terminate before reporting the outcome. */
const STOP_GRACE_MS = 300

interface ManagedProcess {
  id: string
  command: string
  cwd: string
  proc: Bun.Subprocess
  /** The retained write end of the child's stdin, so `send` can drive a REPL or debugger. Undefined if the pipe is already gone. */
  stdin?: { write(chunk: string): void; flush?(): void }
  startedAt: number
  lines: string[]
  /** Set once the process has exited; undefined while it is still running. */
  exitCode?: number
  exitedAt?: number
  /** Cleared when the process exits so a long session does not accumulate abort listeners. */
  detach?: () => void
}

const processes = new Map<string, ManagedProcess>()
let shutdownRegistered = false

function registerShutdown(): void {
  if (shutdownRegistered) return
  shutdownRegistered = true
  registerShutdownCleanup(() => {
    for (const managed of processes.values()) {
      if (managed.exitCode === undefined) terminateProcessGroup(managed.proc)
    }
  })
}

function push(managed: ManagedProcess, chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (line.length === 0) continue
    managed.lines.push(line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line)
  }
  if (managed.lines.length > MAX_LOG_LINES) managed.lines.splice(0, managed.lines.length - MAX_LOG_LINES)
}

/**
 * Drain a pipe for the life of the process.
 *
 * Not optional: a child whose stdout pipe fills and is never read blocks on
 * write and appears hung. A dev server printing a request log would wedge
 * within minutes if output were only collected when `logs` was called.
 */
async function drain(managed: ManagedProcess, stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      push(managed, decoder.decode(value, { stream: true }))
    }
  } catch {
    // The process died or the pipe closed; the exit watcher records the outcome.
  } finally {
    reader.releaseLock()
  }
}

function describe(managed: ManagedProcess): string {
  const elapsed = Math.round(((managed.exitedAt ?? Date.now()) - managed.startedAt) / 1000)
  const state = managed.exitCode === undefined ? `running for ${elapsed}s` : `exited ${managed.exitCode} after ${elapsed}s`
  return `${managed.id}  ${state}  ${managed.command}`
}

function tail(managed: ManagedProcess, limit: number, filter?: string): string {
  const matching = filter ? managed.lines.filter((line) => line.toLowerCase().includes(filter.toLowerCase())) : managed.lines
  const selected = matching.slice(-limit)
  if (selected.length === 0) {
    return filter
      ? `(no lines matching ${JSON.stringify(filter)} out of ${managed.lines.length} captured)`
      : managed.exitCode === undefined
        ? '(no output yet — the process is running but has printed nothing)'
        : '(the process produced no output)'
  }
  const omitted = matching.length - selected.length
  return `${omitted > 0 ? `[${omitted} earlier line${omitted === 1 ? '' : 's'} not shown]\n` : ''}${selected.join('\n')}`
}

/** Visible for tests: drop every record and kill anything still running. */
export function resetProcessesForTests(): void {
  for (const managed of processes.values()) {
    if (managed.exitCode === undefined) terminateProcessGroup(managed.proc)
  }
  processes.clear()
}

export const processTool: Tool = {
  name: 'process',
  description: `Start and supervise a long-running process — a dev server, a file watcher, a queue worker, a debugger, anything that does not exit on its own. This is what run_command cannot do: run_command waits for the command to finish, so a server there only ever times out.

start runs a command in the background and returns immediately with an id; output is captured continuously from that moment. logs returns what it has printed (pass filter to search it, lines to change how much). send writes one line to the process's stdin, which is what drives a debugger or an interactive prompt (e.g. "continue", "bt", "step"). stop terminates it. list shows everything still running.

The normal loop is: start the server, wait or act, then read logs to see what it actually did. When something behaves wrongly at runtime, read its logs before guessing from the source — a stack trace in the log is the answer, and nothing else you have will show it. Everything started here is killed when the session ends.

Debugging works in two shapes. Scripted: start "gdb -batch -x cmds.gdb ./app", then read logs — it finishes on its own. Interactive: start "gdb ./app", then send "run", send "bt", read logs after each. The interactive form has no real terminal, so a full-screen curses UI (some ncurses tools, less, a bare Python REPL's editing) will not render properly; line-oriented tools (gdb, lldb, pdb) work fine.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'logs', 'stop', 'list', 'send'], description: 'What to do' },
      command: { type: 'string', description: 'For start: the shell command to run, e.g. "npm run dev"' },
      cwd: { type: 'string', description: 'For start: working directory, relative to the workspace. Defaults to the workspace root.' },
      id: { type: 'string', description: 'For logs, stop and send: the id returned by start' },
      lines: { type: 'number', description: `For logs: how many trailing lines to return (default 100, max ${MAX_LOG_LINES})` },
      filter: { type: 'string', description: 'For logs: return only lines containing this text, case-insensitive' },
      payload: { type: 'string', description: 'For send: exactly one line of input to write to the process stdin, e.g. "bt". A newline is appended for you; embedded newlines, carriage returns and NUL bytes are refused because they would turn one input into several shell commands.' },
    },
    required: ['action'],
  },

  async execute(input) {
    const action = input.action
    if (action !== 'start' && action !== 'logs' && action !== 'stop' && action !== 'list' && action !== 'send') {
      throw new Error('action must be one of start, logs, stop, list, or send')
    }

    if (action === 'list') {
      const running = [...processes.values()]
      if (running.length === 0) return 'No processes have been started in this session.'
      return running.map(describe).join('\n')
    }

    if (action === 'start') {
      if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('start requires a non-empty command')
      const live = [...processes.values()].filter((managed) => managed.exitCode === undefined)
      if (live.length >= MAX_PROCESSES) {
        throw new Error(`${MAX_PROCESSES} processes are already running. Stop one before starting another:\n${live.map(describe).join('\n')}`)
      }
      const command = input.command.trim()
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? resolveProjectPath(input.cwd.trim()) : resolveProjectPath('.')
      const shell = shellInvocation(command)
      registerShutdown()

      let proc: Bun.Subprocess
      try {
        proc = Bun.spawn(shell.argv, {
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
          // A pipe, not 'ignore', so `send` can write to a process that reads
          // commands. Nothing has to read it: a process that never touches
          // stdin behaves the same as before, and the OS buffer is the only
          // thing that fills.
          stdin: 'pipe',
          ...(shell.verbatim ? { windowsVerbatimArguments: true } : {}),
        })
      } catch (error) {
        throw new Error(`Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`)
      }

      const managed: ManagedProcess = {
        id: `proc_${randomBytes(3).toString('hex')}`,
        command,
        cwd,
        proc,
        stdin: proc.stdin as ManagedProcess['stdin'],
        startedAt: Date.now(),
        lines: [],
      }
      processes.set(managed.id, managed)

      // Cancellation, mirroring runShell: an aborted autonomous run must not
      // leave debug children running until shutdown. The listener is removed
      // on exit, so a long session that starts and stops many processes does
      // not accumulate them on the agent's signal.
      const signal = currentAgent().signal
      const onAbort = () => terminateProcessGroup(proc)
      signal?.addEventListener('abort', onAbort, { once: true })
      managed.detach = () => signal?.removeEventListener('abort', onAbort)

      void drain(managed, proc.stdout as ReadableStream<Uint8Array> | null)
      void drain(managed, proc.stderr as ReadableStream<Uint8Array> | null)
      void proc.exited.then((code) => {
        managed.exitCode = code
        managed.exitedAt = Date.now()
        managed.detach?.()
      })

      // A command that is going to fail usually fails immediately — a missing
      // binary, a bad flag, a port already taken. Reporting "started" for one
      // that is already dead is the same lie `preview` used to tell about a URL
      // nothing was serving, so give it a moment and report what really happened.
      await Bun.sleep(400)
      if (managed.exitCode !== undefined) {
        return `${managed.id} exited immediately with code ${managed.exitCode} — it is not running.\n$ ${command}\n${tail(managed, 30)}`
      }
      const early = tail(managed, 15)
      return `${managed.id} started: ${command}\nRunning in ${cwd}. Read its output with process logs id: "${managed.id}", stop it with process stop.${managed.lines.length > 0 ? `\n\nFirst output:\n${early}` : ''}`
    }

    if (typeof input.id !== 'string' || input.id.trim().length === 0) throw new Error(`${action} requires the id returned by start`)
    const managed = processes.get(input.id.trim())
    if (!managed) {
      const known = [...processes.keys()]
      throw new Error(`No process with id ${input.id}.${known.length > 0 ? ` Known ids: ${known.join(', ')}` : ' Nothing has been started in this session.'}`)
    }

    if (action === 'logs') {
      if (input.lines !== undefined && (typeof input.lines !== 'number' || !Number.isFinite(input.lines))) throw new Error('lines must be a number')
      if (input.filter !== undefined && typeof input.filter !== 'string') throw new Error('filter must be a string')
      const limit = Math.max(1, Math.min(MAX_LOG_LINES, typeof input.lines === 'number' ? Math.round(input.lines) : 100))
      return `${describe(managed)}\n\n${tail(managed, limit, input.filter)}`
    }

    if (action === 'send') {
      if (typeof input.payload !== 'string') throw new Error('send requires a payload string')
      // One payload is one input line. A newline inside it would be a second
      // command line to the child's shell — the same escalation governor.ts
      // guards against for a run_command string (COMMAND_NEWLINE) — and NUL
      // truncates the write at the C-string level. Refuse rather than
      // reinterpret: a caller wanting several commands means several calls.
      if (/[\n\r\0]/.test(input.payload)) {
        throw new Error('payload must be a single line: newlines, carriage returns and NUL bytes are refused because they would split one input into several commands. Send one line per call.')
      }
      // Reported, not thrown: a process that has already exited is a fact about
      // the run, and the exit code is the useful part.
      if (managed.exitCode !== undefined) return `${managed.id} had already exited with code ${managed.exitCode}, so nothing was written.`
      if (!managed.stdin) return `${managed.id} is running but its stdin pipe is already closed, so nothing was written.`
      try {
        managed.stdin.write(`${input.payload}\n`)
        managed.stdin.flush?.()
      } catch (error) {
        // The child closed stdin between the check above and this write; the
        // error is an EPIPE, not a bug worth surfacing as a stack trace.
        return `${managed.id} did not accept input — it closed its stdin (${error instanceof Error ? error.message : String(error)}). Read its logs to see where it stopped.`
      }
      return `Sent to ${managed.id}: ${input.payload}\nRead what it did with process logs id: "${managed.id}".`
    }

    // stop
    if (managed.exitCode !== undefined) return `${managed.id} had already exited with code ${managed.exitCode}.`
    terminateProcessGroup(managed.proc)
    await Bun.sleep(STOP_GRACE_MS)
    return managed.exitCode === undefined
      ? `${managed.id} was sent a terminate signal; it has not exited yet.`
      : `${managed.id} stopped (exit code ${managed.exitCode}).`
  },
}
