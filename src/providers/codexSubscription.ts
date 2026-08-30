import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { CodexAppServerClient } from './codexAppServer.ts'
import type { ChatMessage, Provider } from './types.ts'

export interface CodexSubscriptionModel {
  id: string
  name: string
  description?: string
  isDefault?: boolean
}

const SUBSCRIPTION_INSTRUCTIONS = `You are Codex, executing work for Elia in the current workspace. Complete the user's request directly: inspect the repository, edit files when needed, and run relevant local verification. Keep every file operation inside the workspace. Do not read credentials or secret files, bypass authentication or security controls, contact external parties, publish, purchase, deploy, or make other consequential external changes. If such an action is required, stop and state the exact approval or user takeover needed.`

let sharedClientPromise: Promise<CodexAppServerClient> | undefined
let unregisterShutdown: (() => void) | undefined
let loginConfirmed = false

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

  return `Selected Codex model: ${model}\n\nConversation:\n${transcript}\n\nWork on the latest user request now and report changes and verification honestly.`
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

export function codexSubscriptionConfigured(): boolean {
  if (loginConfirmed) return true
  try {
    loginConfirmed = Bun.spawnSync(['codex', 'login', 'status'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    return loginConfirmed
  } catch {
    return false
  }
}

export function createCodexSubscriptionProvider(model = 'default'): Provider {
  let threadId: string | undefined
  let threadInstructions: string | undefined
  let completedTurns = 0

  return {
    async streamTurn({ system, systemDynamic, messages, onText, onThinking, onActivity, signal }) {
      if (!codexSubscriptionConfigured()) {
        throw new Error('Codex is not signed in. Select Settings > Provider connections > ChatGPT subscription (Codex) and complete sign-in first.')
      }

      onActivity?.({ kind: 'status', title: 'Connecting to Codex', status: 'started' })
      const client = await codexClient()
      const sessionInstructions = systemDynamic && systemDynamic.trim() ? `${system}\n\n${systemDynamic}` : system
      const instructions = `${SUBSCRIPTION_INSTRUCTIONS}\n\n## Elia session instructions\n${sessionInstructions}`
      if (!threadId || threadInstructions !== instructions) {
        onActivity?.({ kind: 'status', title: 'Starting Codex workspace thread', status: 'started' })
        const started = await client.request('thread/start', {
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          developerInstructions: instructions,
          ephemeral: true,
          serviceName: 'elia',
          ...(model === 'default' ? {} : { model }),
        })
        if (!isObject(started) || !isObject(started.thread) || typeof started.thread.id !== 'string') {
          throw new Error('Codex app server returned no thread id')
        }
        threadId = started.thread.id
        threadInstructions = instructions
        completedTurns = 0
      }

      const text = completedTurns === 0 ? buildCodexSubscriptionPrompt(messages, model) : latestUserText(messages)
      const result = await client.runTurn({
        threadId,
        text,
        cwd: process.cwd(),
        model,
        onText,
        onThinking,
        onActivity,
        signal,
      })
      completedTurns++
      return { content: [{ type: 'text' as const, text: result.text }], usage: result.usage }
    },
  }
}
