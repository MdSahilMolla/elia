import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, type Key } from 'ink'
import { palette, glyphs } from '../theme.ts'
import {
  applyKey,
  filteredCommands,
  initialState,
  type PromptState,
  type SlashCommand,
  type KeyEvent,
} from '../../slashPrompt.ts'
import { appendHistory, loadHistory, searchHistory } from '../history.ts'
import { activeMention, completeFile, fileIndexReady, primeFileIndex } from '../fileComplete.ts'
// fileIndexReady seeds the initial state; primeFileIndex + the poll drive the rest.
import type { ReplMode } from './StatusBar.tsx'

/** Ink's key object → the small structural KeyEvent slashPrompt's pure reducer expects. */
function toKeyEvent(input: string, key: Key): { str: string | undefined; event: KeyEvent } {
  const name = key.return
    ? 'return'
    : key.backspace
      ? 'backspace'
      : key.delete
        ? 'backspace'
        : key.leftArrow
          ? 'left'
          : key.rightArrow
            ? 'right'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.tab
                  ? 'tab'
                  : key.escape
                    ? 'escape'
                    : key.ctrl && input === 'a'
                      ? 'home'
                      : key.ctrl && input === 'e'
                        ? 'end'
                        : undefined
  return { str: name ? undefined : input, event: { name, ctrl: key.ctrl, meta: key.meta } }
}

const MODE_CHIP: Record<ReplMode, string> = { manual: 'manual', auto: 'auto', plan: 'plan' }

export interface InputBoxProps {
  commands: SlashCommand[]
  disabled: boolean
  placeholder: string
  /** Drawn as a coloured `[mode]` chip left of the prompt glyph. */
  mode?: ReplMode
  onSubmit(line: string): void
  onInterrupt(): void
  onEof(): void
  /** Tab on an empty line (no completion menu) — used to toggle plan/build mode. */
  onTabEmpty(): void
  /** `?` on an empty line — opens the keybinding help. */
  onHelp?(): void
}

/**
 * Renders the input buffer with a block caret sitting at `cursor` rather than
 * always pinned to the end of the line. The character under the cursor is drawn
 * inverse; when the cursor is past the last character (or the line is empty) an
 * inverse space stands in for it. See issue #11 — the caret used to be a fixed
 * trailing glyph, so its position never tracked left/right/home/end moves.
 */
function BufferView(props: { buffer: string; cursor: number; placeholder: string; showCursor: boolean }) {
  const { buffer, cursor, placeholder, showCursor } = props

  if (buffer.length === 0) {
    return (
      <Text>
        {showCursor && <Text inverse> </Text>}
        <Text color={palette.muted}>{placeholder}</Text>
      </Text>
    )
  }

  if (!showCursor) return <Text>{buffer}</Text>

  const clamped = Math.max(0, Math.min(cursor, buffer.length))
  return (
    <Text>
      {buffer.slice(0, clamped)}
      <Text inverse>{buffer.slice(clamped, clamped + 1) || ' '}</Text>
      {buffer.slice(clamped + 1)}
    </Text>
  )
}

export function InputBox(props: InputBoxProps) {
  const [state, setState] = useState<PromptState>(() => {
    const history = loadHistory()
    return { ...initialState(), history, historyIndex: history.length }
  })
  // Ctrl+R reverse-search overlay — its own query, independent of the buffer.
  const [search, setSearch] = useState<{ query: string; index: number } | null>(null)
  // A large multi-line paste is collapsed to a token in the buffer; the real
  // text is kept here and spliced back in at submit time.
  const pastes = useRef(new Map<string, string>()).current

  const mention = activeMention(state.buffer, state.cursor)
  const [mentionSel, setMentionSel] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState('')
  const mentionOpen = mention !== null && mentionDismissed !== mention.query
  // Build the repo file index the first time an @-mention appears, and re-render
  // once it lands so the "indexing…" hint gives way to real matches.
  const [indexReady, setIndexReady] = useState(fileIndexReady())
  useEffect(() => {
    if (!mention || indexReady) return
    primeFileIndex()
    const timer = setInterval(() => {
      if (fileIndexReady()) {
        setIndexReady(true)
        clearInterval(timer)
      }
    }, 60)
    return () => clearInterval(timer)
  }, [mention !== null, indexReady])
  const fileMatches = useMemo(
    () => (mentionOpen ? completeFile(mention!.query) : []),
    [mentionOpen, mention?.query, indexReady],
  )

  const searchResults = search ? searchHistory(search.query, state.history) : []

  const expandPastes = (line: string): string => {
    let out = line
    for (const [token, text] of pastes) if (out.includes(token)) out = out.replace(token, text)
    return out
  }

  const submit = (line: string) => {
    const full = expandPastes(line).trim()
    if (!full) return
    appendHistory(full)
    props.onSubmit(full)
  }

  const acceptFile = (path: string) => {
    if (!mention) return
    const before = state.buffer.slice(0, mention.start)
    const after = state.buffer.slice(state.cursor)
    const insert = `@${path} `
    const buffer = before + insert + after
    setState({ ...state, buffer, cursor: (before + insert).length, selectedIndex: 0 })
    setMentionSel(0)
    setMentionDismissed(mention.query)
  }

  useInput((input, key) => {
    if (props.disabled) return
    if (key.ctrl && input === 'c') {
      props.onInterrupt()
      return
    }

    // --- Reverse-search overlay owns all keys while open ---
    if (search) {
      if (key.escape) return setSearch(null)
      if (key.return) {
        const pick = searchResults[search.index] ?? searchResults[0]
        setSearch(null)
        if (pick) setState({ ...state, buffer: pick, cursor: pick.length, selectedIndex: 0 })
        return
      }
      if (key.ctrl && input === 'r') {
        setSearch((s) => (s ? { ...s, index: Math.min(s.index + 1, Math.max(0, searchResults.length - 1)) } : s))
        return
      }
      if (key.upArrow) return setSearch((s) => (s ? { ...s, index: Math.max(0, s.index - 1) } : s))
      if (key.downArrow) return setSearch((s) => (s ? { ...s, index: Math.min(s.index + 1, Math.max(0, searchResults.length - 1)) } : s))
      if (key.backspace || key.delete) return setSearch((s) => (s ? { query: s.query.slice(0, -1), index: 0 } : s))
      if (input && !key.ctrl && !key.meta) return setSearch((s) => (s ? { query: s.query + input, index: 0 } : s))
      return
    }
    if (key.ctrl && input === 'r') {
      setSearch({ query: '', index: 0 })
      return
    }

    // --- @-mention file menu intercepts navigation/accept ---
    if (mentionOpen && fileMatches.length > 0) {
      if (key.tab || key.return) {
        acceptFile(fileMatches[Math.min(mentionSel, fileMatches.length - 1)]!)
        return
      }
      if (key.upArrow) {
        setMentionSel((i) => (i - 1 + fileMatches.length) % fileMatches.length)
        return
      }
      if (key.downArrow) {
        setMentionSel((i) => (i + 1) % fileMatches.length)
        return
      }
      if (key.escape) {
        setMentionDismissed(mention!.query)
        return
      }
    }

    if (key.tab && !key.shift && state.buffer.length === 0 && filteredCommands(state.buffer, props.commands).length === 0) {
      props.onTabEmpty()
      return
    }
    if (input === '?' && !key.ctrl && !key.meta && state.buffer.length === 0) {
      props.onHelp?.()
      return
    }

    // --- Bracketed paste: a chunk with newlines arrives as one `input` ---
    if (input.length > 12 && /\r?\n/.test(input)) {
      const lineCount = input.split(/\r?\n/).length
      const token = `⟦pasted ${lineCount} lines⟧`
      pastes.set(token, input)
      const buffer = state.buffer.slice(0, state.cursor) + token + state.buffer.slice(state.cursor)
      setState({ ...state, buffer, cursor: state.cursor + token.length, selectedIndex: 0 })
      return
    }

    const { str, event } = toKeyEvent(input, key)
    const result = applyKey(state, str, event, props.commands)
    if (result.type === 'eof') {
      props.onEof()
      return
    }
    if (result.type === 'interrupt') {
      props.onInterrupt()
      return
    }
    if (result.type === 'submit') {
      setState(result.state)
      submit(result.line)
      return
    }
    if (mentionDismissed && result.state.buffer !== state.buffer) setMentionDismissed('')
    setState(result.state)
  })

  const menu = mentionOpen ? [] : filteredCommands(state.buffer, props.commands)
  const selected = Math.min(state.selectedIndex, Math.max(0, menu.length - 1))

  // The menu can be longer than we want to draw. Scroll a fixed window so the
  // highlighted row is always visible instead of clipping everything past row 8.
  const MAX_VISIBLE = 10
  const start =
    menu.length <= MAX_VISIBLE
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(MAX_VISIBLE / 2)), menu.length - MAX_VISIBLE)
  const visible = menu.slice(start, start + MAX_VISIBLE)
  const hiddenAbove = start
  const hiddenBelow = menu.length - (start + visible.length)

  return (
    <Box flexDirection="column">
      {/* One dim rule above the prompt — the single structural line in the whole
          UI. Was a top+bottom border box; a lone rule reads lighter and can't
          mis-wrap. */}
      <Box
        borderStyle="single"
        borderColor={props.disabled ? palette.muted : palette.accent}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        {props.mode ? (
          <Text color={props.mode === 'plan' ? palette.warning : props.mode === 'auto' ? palette.success : palette.muted}>
            [{MODE_CHIP[props.mode]}]{' '}
          </Text>
        ) : null}
        <Text color={palette.accent}>{glyphs.user} </Text>
        {search ? (
          <Text>
            <Text color={palette.muted}>⌕ </Text>
            {search.query}
            <Text inverse> </Text>
          </Text>
        ) : (
          <BufferView buffer={state.buffer} cursor={state.cursor} placeholder={props.placeholder} showCursor={!props.disabled} />
        )}
      </Box>

      {search && (
        <Box flexDirection="column" marginLeft={2}>
          {searchResults.length === 0 ? (
            <Text color={palette.muted}>{search.query ? 'no matching history' : 'reverse-search history — type to search'}</Text>
          ) : (
            searchResults.map((entry, i) => (
              <Text key={entry} inverse={i === search.index} wrap="truncate-end">
                {entry}
              </Text>
            ))
          )}
        </Box>
      )}

      {mentionOpen && !search && (
        <Box flexDirection="column" marginLeft={2}>
          {!indexReady ? (
            <Text color={palette.muted}>indexing files…</Text>
          ) : fileMatches.length === 0 ? (
            <Text color={palette.muted}>no files match “{mention!.query}”</Text>
          ) : (
            fileMatches.map((path, i) => (
              <Text key={path} inverse={i === Math.min(mentionSel, fileMatches.length - 1)} wrap="truncate-end">
                {path}
              </Text>
            ))
          )}
        </Box>
      )}

      {menu.length > 0 && !search && (
        <Box flexDirection="column" marginLeft={2}>
          {hiddenAbove > 0 && <Text color={palette.muted}>↑ {hiddenAbove} more</Text>}
          {visible.map((cmd) => (
            <Text key={cmd.name} inverse={menu[selected]?.name === cmd.name}>
              {cmd.name} <Text color={palette.muted}>{cmd.description}</Text>
            </Text>
          ))}
          {hiddenBelow > 0 && <Text color={palette.muted}>↓ {hiddenBelow} more</Text>}
        </Box>
      )}
    </Box>
  )
}
