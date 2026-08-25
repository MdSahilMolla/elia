import { render, useKeyboard } from '@opentui/solid'
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from '@opentui/core'
import { createSignal, createEffect, createMemo, For } from 'solid-js'
import { runTurn, type AgentMode, type ConversationMessage } from '../agent.ts'
import { lastAssistantText } from '../agentLoop.ts'
import { config } from '../config.ts'

/**
 * elia's terminal UI, built on @opentui/solid — the same rendering framework
 * opencode uses (real, standalone, MIT-licensed; not opencode's own app code,
 * which is deeply coupled to Effect-TS and their internal SDK/plugin packages
 * and isn't portable as-is). This is a first, deliberately small screen: one
 * scrollable conversation, one input line, real streaming from elia's actual
 * agent loop (agent.ts's runTurn) — not a mock of one. Slash commands,
 * checkpoints, task dashboards, and the rest of the plain-REPL feature set
 * (index.ts's runInteractive) stay on the existing readline path for now.
 */

const COLORS = {
  bg: '#0a0a0a',
  border: '#3c3c3c',
  text: '#eeeeee',
  muted: '#808080',
  user: '#7fd8ff',
  assistant: '#eeeeee',
  thinking: '#808080',
  error: '#e06c75',
  accent: '#fab283',
}

interface DisplayLine {
  role: 'user' | 'assistant' | 'thinking' | 'system'
  text: string
}

export function App(props: { mode: AgentMode }) {
  const [lines, setLines] = createSignal<DisplayLine[]>([
    { role: 'system', text: `elia — ${config.providerName} (${config.model}) — mode: ${props.mode}` },
  ])
  const [input, setInput] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [streamText, setStreamText] = createSignal('')
  const [streamThinking, setStreamThinking] = createSignal('')
  const [statusLine, setStatusLine] = createSignal('Ctrl+C to quit · Enter to send')

  const conversation: ConversationMessage[] = []
  let scroll: ScrollBoxRenderable | undefined
  let inputRef: InputRenderable | undefined

  function focusInput(): void {
    // Deferred because focus must happen after the renderer has actually
    // mounted the node — matching opentui's own components (e.g. the input in
    // its dialog-select), which do the same setTimeout(…, 1) dance.
    setTimeout(() => {
      if (inputRef && !inputRef.isDestroyed) inputRef.focus()
    }, 1)
  }

  // A single flat list so <scrollbox> only ever has <For>-rendered <text>
  // children — a <Show> placed directly under <scrollbox> for the in-progress
  // streaming lines throws opentui's "orphan text" error the moment it
  // switches between rendering nothing and rendering a <text>, since its
  // empty-case placeholder isn't itself a <text> node.
  const visibleLines = createMemo<DisplayLine[]>(() => {
    const current = [...lines()]
    if (streamThinking()) current.push({ role: 'thinking', text: streamThinking() })
    if (streamText()) current.push({ role: 'assistant', text: streamText() })
    return current
  })

  createEffect(() => {
    visibleLines() // re-run on every change so the view tracks the latest output
    queueMicrotask(() => scroll?.scrollTo(scroll.scrollHeight))
  })

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === 'c') process.exit(0)
  })

  async function submit(): Promise<void> {
    const text = input().trim()
    if (!text || busy()) return
    setInput('')
    setLines((current) => [...current, { role: 'user', text }])
    conversation.push({ role: 'user', content: [{ type: 'text', text }] })
    setBusy(true)
    setStatusLine('Working…')
    setStreamText('')
    setStreamThinking('')

    try {
      const result = await runTurn(conversation, {
        mode: props.mode,
        silent: true,
        onText: (delta) => setStreamText((s) => s + delta),
        onThinking: (delta) => setStreamThinking((s) => s + delta),
      })
      // onText deltas can legitimately be empty (a non-streaming provider, or a
      // response with no incremental callback) — fall back to reading the real
      // final answer straight off the conversation, same as vscodeBridge.ts's
      // handleChat does for the exact same reason.
      const finalText = streamText() || lastAssistantText(conversation, '')
      if (finalText) setLines((current) => [...current, { role: 'assistant', text: finalText }])
      setStatusLine(`${result.usage.inputTokens + result.usage.outputTokens} tokens this turn · Ctrl+C to quit · Enter to send`)
    } catch (error) {
      setLines((current) => [...current, { role: 'system', text: `Error: ${error instanceof Error ? error.message : String(error)}` }])
      setStatusLine('Ctrl+C to quit · Enter to send')
    } finally {
      setStreamText('')
      setStreamThinking('')
      setBusy(false)
      focusInput()
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={COLORS.bg}>
      <box paddingLeft={1} flexShrink={0}>
        <text fg={COLORS.accent} attributes={TextAttributes.BOLD}>
          elia
        </text>
      </box>
      <box border borderStyle="rounded" borderColor={COLORS.border} flexGrow={1} paddingLeft={1} paddingRight={1}>
        <scrollbox ref={(el: ScrollBoxRenderable) => (scroll = el)} flexGrow={1}>
          <For each={visibleLines()}>
            {(line) => (
              <text fg={line.role === 'user' ? COLORS.user : line.role === 'system' ? COLORS.muted : line.role === 'thinking' ? COLORS.thinking : COLORS.assistant}>
                {line.role === 'user' ? `> ${line.text}` : line.text}
              </text>
            )}
          </For>
        </scrollbox>
      </box>
      <box border borderStyle="rounded" borderColor={busy() ? COLORS.muted : COLORS.accent} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <input
          ref={(el: InputRenderable) => {
            inputRef = el
            focusInput()
          }}
          value={input()}
          onInput={setInput}
          onSubmit={submit}
          placeholder={busy() ? 'Working…' : 'Ask elia…'}
          focusedTextColor={COLORS.text}
          cursorColor={COLORS.accent}
        />
      </box>
      <box paddingLeft={1} flexShrink={0}>
        <text fg={COLORS.muted}>{statusLine()}</text>
      </box>
    </box>
  )
}

export async function runTui(mode: AgentMode = 'dev'): Promise<void> {
  await render(() => <App mode={mode} />, { exitOnCtrlC: true })
}
