import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { CodexAppServerClient } from './codexAppServer.ts'
import type { ChatMessage, Provider } from './types.ts'

export interface CodexSubscriptionModel {
  id: string
  name: string
  description?: string
  isDefault?: boolean
}

const SUBSCRIPTION_INSTRUCTIONS = `You are Codex, executing work for Elia in the current workspace. Use your full ability: read the repository first and follow its existing conventions, prefer editing existing code over adding parallel implementations, make the change the request actually needs, then verify it with the project's own tools — run its tests, its build, its type-checker — and report what passed and what did not, honestly. If you could not verify something, say so rather than implying it works.

Constraints: keep every file operation inside the workspace. Your sandbox has no network access, so do not attempt anything that needs it (package installs from a registry, remote fetches) — if the task genuinely requires network, stop and say exactly what is needed. Do not read credentials or secret files, bypass authentication or security controls, contact external parties, publish, purchase, deploy, or make other consequential external changes; if such an action is required, stop and state the exact approval or user takeover needed.`

let sharedClientPromise: Promise<CodexAppServerClient> | undefined
let unregisterShutdown: (() => void) | undefined
let loginConfirmed = false
let loginPrimePromise: Promise<boolean> | undefined
let subscriptionApprovedThisSession = false

/**
 * Whether the user has already approved running Codex in this workspace during
 * this session. Selecting the ChatGPT subscription as the model is a deliberate
 * choice; it is confirmed once, on the first turn, not re-approved on every
 * message.
 */
export function codexSubscriptionApprovedThisSession(): boolean {
  return subscriptionApprovedThisSession
}
export function markCodexSubscriptionApproved(): void {
  subscriptionApprovedThisSession = true
}
/** Test-only: forget the session approval. */
export function resetCodexSubscriptionApprovalForTests(): void {
  subscriptionApprovedThisSession = false
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Converts the Codex app-server model catalogue to Elia picker entries. */
export function parseCodexSubscriptionModels(result: unknown): CodexSubscriptionModel[] {
  if (!isObject(result) || !Array.isArray(result.data)) return []
  return result.data.flatMap((entry): CodexSubscriptionModel[] => {
    if (!isObject(entry)) return []
    const id = typeof entry.model === 'string' ? entry.model : undefined
    if (!id) return []
    return [{
      id,
      name: typeof entry.displayName === 'string' ? entry.displayName : id,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      isDefault: entry.isDefault === true,
    }]
  })
}

async function codexClient(): Promise<CodexAppServerClient> {
  if (!sharedClientPromise) {
    const client = new CodexAppServerClient()
    sharedClientPromise = client.connect()
      .then(() => {
        unregisterShutdown = registerShutdownCleanup(() => client.close())
        return client
      })
      .catch((error) => {
        client.close()
        sharedClientPromise = undefined
        throw error
      })
  }

  const client = await sharedClientPromise
  if (!client.isClosed) return client
  unregisterShutdown?.()
  unregisterShutdown = undefined
  sharedClientPromise = undefined
  return codexClient()
}

/** Stops the shared process. Exported so focused tests and embedders can clean up deterministically. */
export async function closeCodexSubscriptionClient(): Promise<void> {
  const promise = sharedClientPromise
  sharedClientPromise = undefined
  unregisterShutdown?.()
  unregisterShutdown = undefined
  if (promise) {
    const client = await promise.catch(() => undefined)
    await client?.closeAndWait()
  }
}

/** Uses the signed-in account's catalogue instead of guessing API model IDs. */
export async function listCodexSubscriptionModels(): Promise<{ models: CodexSubscriptionModel[]; error?: string }> {
  if (!codexSubscriptionConfigured()) return { models: [], error: 'Codex is not signed in' }
  try {
    const response = await (await codexClient()).request('model/list', { includeHidden: false })
    const models = parseCodexSubscriptionModels(response)
    return models.length > 0 ? { models } : { models: [], error: 'Codex returned no selectable subscription models' }
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Builds the initial transcript sent once when a subscription thread starts. */
export function buildCodexSubscriptionPrompt(messages: ChatMessage[], model = 'default'): string {
  const transcript = messages
    .map((message) => {
      const text = message.content
        .filter((block) => block.type === 'text' || block.type === 'tool_result')
        .map((block) => block.type === 'text' ? block.text : block.content)
        .join('\n')
      return text ? `${message.role}:\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  const env = `Working directory: ${process.cwd()}\nPlatform: ${process.platform}\nNetwork: disabled inside this sandbox`
  return `Selected Codex model: ${model}\n\n${env}\n\nConversation:\n${transcript}\n\nWork on the latest user request now and report changes and verification honestly.`
}

function latestUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = message.content
      .filter((block) => block.type === 'text' || block.type === 'tool_result')
      .map((block) => block.type === 'text' ? block.text : block.content)
      .join('\n')
      .trim()
    if (text) return text
  }
  return 'Continue the current task.'
}

/**
 * `codex login status` off the event loop. `codexSubscriptionConfigured()` is
 * called synchronously from provider resolution and from the first turn; on
 * Windows a synchronous `Bun.spawnSync` there stalls the Ink render loop for as
 * long as the probe takes (keystrokes and the just-pressed Enter visibly lag).
 * Prewarm calls this so the result is already cached by the time a turn needs it.
 */
export async function primeCodexSubscriptionLogin(): Promise<boolean> {
  if (loginConfirmed) return true
  if (!loginPrimePromise) {
    loginPrimePromise = (async () => {
      try {
        const proc = Bun.spawn(['codex', 'login', 'status'], { stdout: 'ignore', stderr: 'ignore' })
        loginConfirmed = (await proc.exited) === 0
      } catch {
        loginConfirmed = false
      } finally {
        loginPrimePromise = undefined
      }
      return loginConfirmed
    })()
  }
  return loginPrimePromise
}

export function codexSubscriptionConfigured(): boolean {
  if (loginConfirmed) return true
  try {
    loginConfirmed = Bun.spawnSync(['codex', 'login', 'status'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    return loginConfirmed
  } catch {
    return false
  }
}

/** ~1 minute; a first thread start can involve a model-catalogue fetch and cold process work. */
const THREAD_START_TIMEOUT_MS = 60_000

/**
 * A ChatGPT-subscription run can fail because the plan's own usage cap was hit,
 * not because anything in Elia is wrong. Recognise that and say so plainly, with
 * the reset window when Codex reports one, so the fix ("wait" or "switch model")
 * is obvious rather than looking like an Elia bug.
 */
export function describeCodexFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/usage limit|rate limit|quota|too many requests|\b429\b|resets? (?:in|at)|try again (?:later|in)/i.test(message)) {
    const reset = /resets?\s+(?:in|at)\s+([^.\n]+)/i.exec(message)?.[1]?.trim()
    return new Error(
      `ChatGPT subscription usage limit reached${reset ? ` — resets ${reset}` : ''}. `
        + 'This is your ChatGPT plan\'s cap, not an Elia limit. Wait for the window to reset, '
        + 'or switch to an API-key model with /model. (Codex said: ' + message + ')',
    )
  }
  return error instanceof Error ? error : new Error(message)
}

export function createCodexSubscriptionProvider(model = 'default'): Provider {
  let threadId: string | undefined
  let threadInstructions: string | undefined
  let lastDynamic: string | undefined
  let completedTurns = 0
  let threadStartInFlight: Promise<void> | undefined

  const buildInstructions = (system: string) => `${SUBSCRIPTION_INSTRUCTIONS}\n\n## Elia session instructions\n${system}`

  // The thread is pinned to the STABLE system prompt only. Query-ranked project
  // memory and the wall-clock date change on every user turn; folding them into
  // developerInstructions would tear the thread down and rebuild it each turn.
  // The changed dynamic block rides in the turn input instead, so one thread
  // serves the whole session — and it can be started ahead of the first turn.
  const ensureThread = async (system: string, onActivity?: (activity: import('./types.ts').ProviderActivity) => void): Promise<void> => {
    const instructions = buildInstructions(system)
    if (threadId && threadInstructions === instructions) return
    if (threadStartInFlight) return threadStartInFlight
    threadStartInFlight = (async () => {
      const client = await codexClient()
      onActivity?.({ kind: 'status', title: 'Starting Codex workspace thread', status: 'started' })
      const started = await client.request('thread/start', {
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        developerInstructions: instructions,
        ephemeral: true,
        serviceName: 'elia',
        ...(model === 'default' ? {} : { model }),
      }, THREAD_START_TIMEOUT_MS)
      if (!isObject(started) || !isObject(started.thread) || typeof started.thread.id !== 'string') {
        throw new Error('Codex app server returned no thread id')
      }
      threadId = started.thread.id
      threadInstructions = instructions
      lastDynamic = undefined
      completedTurns = 0
    })().finally(() => { threadStartInFlight = undefined })
    return threadStartInFlight
  }

  return {
    // Bring the app-server process up, through its initialize handshake, and —
    // when the session prompt is known — start the workspace thread too, all
    // while the user is still reading the banner or typing. The first real turn
    // then goes straight to turn/start instead of paying cold start on its
    // critical path. Fire-and-forget; any failure resurfaces on the real call.
    prewarm(hint) {
      void primeCodexSubscriptionLogin().then((ok) => {
        if (!ok) return
        if (hint?.system) return ensureThread(hint.system).catch(() => {})
        return codexClient().then(() => {}).catch(() => {})
      })
    },

    async streamTurn({ system, systemDynamic, messages, onText, onThinking, onActivity, signal }) {
      if (!codexSubscriptionConfigured()) {
        throw new Error('Codex is not signed in. Select Settings > Provider connections > ChatGPT subscription (Codex) and complete sign-in first.')
      }

      onActivity?.({ kind: 'status', title: 'Connecting to Codex', status: 'started' })
      try {
        await ensureThread(system, onActivity)
        const activeThreadId = threadId
        if (!activeThreadId) throw new Error('Codex app server returned no thread id')
        const client = await codexClient()

        const dynamic = systemDynamic?.trim() || undefined
        const preamble = dynamic && dynamic !== lastDynamic ? `## Updated context for this turn\n${dynamic}\n\n` : ''
        const body = completedTurns === 0 ? buildCodexSubscriptionPrompt(messages, model) : latestUserText(messages)
        const result = await client.runTurn({
          threadId: activeThreadId,
          text: `${preamble}${body}`,
          cwd: process.cwd(),
          model,
          onText,
          onThinking,
          onActivity,
          signal,
        })
        lastDynamic = dynamic
        completedTurns++
        return { content: [{ type: 'text' as const, text: result.text }], usage: result.usage }
      } catch (error) {
        throw describeCodexFailure(error)
      }
    },
  }
}
