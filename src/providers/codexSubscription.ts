import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampOutput, readBoundedOutput, terminateProcessGroup } from '../shell.ts'
import type { ChatMessage, Provider, StreamTurnParams } from './types.ts'

const MAX_OUTPUT_LENGTH = 100_000
const APP_SERVER_TIMEOUT_MS = 10_000

export interface CodexSubscriptionModel {
  id: string
  name: string
  description?: string
  isDefault?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Converts the Codex app-server model catalogue to Elia picker entries. */
export function parseCodexSubscriptionModels(result: unknown): CodexSubscriptionModel[] {
  if (!isObject(result) || !Array.isArray(result.data)) return []
  return result.data
    .flatMap((entry): CodexSubscriptionModel[] => {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Asks the authenticated Codex client for its current picker catalogue. The
 * catalogue is account and plan specific, so it must not be guessed from API
 * model names or copied into Elia's configuration.
 */
export async function listCodexSubscriptionModels(): Promise<{ models: CodexSubscriptionModel[]; error?: string }> {
  if (!codexSubscriptionConfigured()) return { models: [], error: 'Codex is not signed in' }

  const proc = Bun.spawn(['codex', 'app-server', '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const request = async (id: number, method: string, params: unknown): Promise<unknown> => {
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    proc.stdin.flush()
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        const { value, done } = await reader.read()
        if (done) throw new Error('Codex app server closed before replying')
        buffer += decoder.decode(value, { stream: true })
        continue
      }
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObject(message) || message.id !== id) continue
      if (isObject(message.error)) throw new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex app server rejected the request')
      return message.result
    }
  }

  try {
    await withTimeout(
      request(1, 'initialize', { clientInfo: { name: 'elia', version: '0.1.0' }, capabilities: {} }),
      APP_SERVER_TIMEOUT_MS,
      'Codex did not initialize in time',
    )
    const response = await withTimeout(request(2, 'model/list', { includeHidden: false }), APP_SERVER_TIMEOUT_MS, 'Codex did not return its model list in time')
    const models = parseCodexSubscriptionModels(response)
    return models.length > 0 ? { models } : { models: [], error: 'Codex returned no selectable subscription models' }
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      proc.kill()
    } catch {
      // The app server may have already exited after the response.
    }
    await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
  }
}

/**
 * Builds the single-turn request passed to the user-authenticated Codex CLI.
 * Codex owns its ChatGPT credentials; this adapter never reads them or tries
 * to turn them into an OpenAI API key.
 */
export function buildCodexSubscriptionPrompt(system: string, messages: ChatMessage[], model = 'default'): string {
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

  return `${system}\n\n## Selected model\nElia requested Codex model: ${model}. If asked which model is selected, state this exact model ID and distinguish it from any service-side routing you cannot verify.\n\n## Conversation\n${transcript}\n\nReply directly to the latest user request. Do not modify files or execute commands; Elia keeps its own governed tool and approval workflow.`
}

export function codexSubscriptionConfigured(): boolean {
  try {
    return Bun.spawnSync(['codex', 'login', 'status'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  } catch {
    return false
  }
}

export function createCodexSubscriptionProvider(model = 'default'): Provider {
  return {
    async streamTurn({ system, messages, onText, signal }: StreamTurnParams) {
      if (!codexSubscriptionConfigured()) {
        throw new Error('Codex is not signed in. Select Settings > Provider connections > ChatGPT subscription (Codex) and complete sign-in first.')
      }

      const outDir = mkdtempSync(join(tmpdir(), 'elia-codex-provider-'))
      const outFile = join(outDir, 'last-message.txt')
      const args = [
        'codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', outFile,
        ...(model === 'default' ? [] : ['--model', model]),
        '-',
      ]
      const prompt = buildCodexSubscriptionPrompt(system, messages, model)
      const proc = Bun.spawn(args, {
        stdin: new TextEncoder().encode(prompt),
        stdout: 'pipe',
        stderr: 'pipe',
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
      const onAbort = () => terminateProcessGroup(proc)
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readBoundedOutput(proc.stdout, MAX_OUTPUT_LENGTH),
          readBoundedOutput(proc.stderr, MAX_OUTPUT_LENGTH),
          proc.exited,
        ])
        if (signal?.aborted) throw new Error('Codex request cancelled')
        if (exitCode !== 0) throw new Error(`Codex subscription request failed (exit ${exitCode}): ${clampOutput(stderr || stdout, 4_000)}`)

        let text = ''
        try {
          text = readFileSync(outFile, 'utf8').trim()
        } catch {
          // Some Codex failures do not create the requested final-message file.
          // stdout is still useful for reporting or accepting a direct response.
        }
        text ||= clampOutput(stdout, MAX_OUTPUT_LENGTH)
        if (!text) throw new Error('Codex returned no response')
        onText(text)
        return { content: [{ type: 'text' as const, text }], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        try {
          rmSync(outDir, { recursive: true, force: true })
        } catch {
          // Best-effort cleanup of the provider's temporary final-message file.
        }
      }
    },
  }
}
