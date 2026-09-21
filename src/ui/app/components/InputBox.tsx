import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, usePaste, type Key } from 'ink'
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
      : // Ink reports 0x08/0x7F as `backspace` and ESC[3~ as `delete`, so these are
        // the two distinct keys — mapping both to 'backspace' left the Delete key
        // eating the character *behind* the caret and forward-delete unreachable.
        key.delete
        ? 'delete'
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

export interface InputBoxProps {
  commands: SlashCommand[]
  disabled: boolean
  placeholder: string
  /** Colours the prompt glyph in plan / auto mode (the status row names the mode). */
  mode?: ReplMode
  onSubmit(line: string): void
  onInterrupt(): void
  onEof(): void
  /** Tab on an empty line (no completion menu) — used to toggle plan/build mode. */
  onTabEmpty(): void
  /** `?` on an empty line — opens the keybinding help. */
  onHelp?(): void
  /** A completion menu (commands, files, history search) opened or closed below the prompt. */
  onMenuChange?(open: boolean): void
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
  // Ink drains every stdin chunk already buffered in ONE synchronous `readable`
  // loop, so a burst — a held backspace (which Ink splits into one event per
  // byte) or a paste the OS delivered in several chunks — runs this component's
  // key handler several times before React re-renders. The `state` captured in
  // that closure is stale for every event after the first, so each edit must be
  // composed on this ref instead: writing `{...state}` per event made a burst
  // collapse to whatever its *last* event computed, which dropped the opening
  // chunks of a long paste and made holding backspace delete a single character.
  // `commit` is the only writer, so the ref never drifts from the rendered state.
  const stateRef = useRef(state)
  const commit = (next: PromptState) => {
    stateRef.current = next
    setState(next)
  }
  // Ctrl+R reverse-search overlay — its own query, independent of the buffer.
  const [search, setSearch] = useState<{ query: string; index: number } | null>(null)
  // A large multi-line paste is collapsed to a token in the buffer; the real
  // text is kept here and spliced back in at submit time.
  const pastes = useRef(new Map<string, string>()).current
  // Tokens must be unique per paste, not just per line-count: two same-length
  // pastes in one line would otherwise collide in `pastes` and, via
  // `replaceAll`, both get overwritten with the same (most recent) text.
  const pasteCounter = useRef(0)

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
    for (const [token, text] of pastes) {
      if (!out.includes(token)) continue
      out = out.replaceAll(token, text)
      // Consumed into this submitted line — drop it so the map doesn't grow
      // unbounded for the life of the session.
      pastes.delete(token)
    }
    return out
  }

  // Takes already-expanded text (paste tokens replaced) — expansion happens
  // once, at the 'submit' result site below, so the same expanded string
  // both gets sent and lands in history. See the comment there for why.
  const finishSubmit = (expanded: string) => {
    const full = expanded.trim()
    if (!full) return
    appendHistory(full)
    props.onSubmit(full)
  }

  const acceptFile = (path: string) => {
    // Re-derive the mention from the live buffer rather than trusting the one
    // computed at render: after a burst the rendered `state` can lag, and
    // splicing at a stale `mention.start` would cut the buffer in the wrong place.
    const current = stateRef.current
    const live = activeMention(current.buffer, current.cursor)
    if (!live) return
    const before = current.buffer.slice(0, live.start)
    const after = current.buffer.slice(current.cursor)
    const insert = `@${path} `
    const buffer = before + insert + after
    commit({ ...current, buffer, cursor: (before + insert).length, selectedIndex: 0 })
    setMentionSel(0)
    setMentionDismissed(live.query)
  }

  /**
   * Splices pasted text into the buffer at the caret. A multi-line paste
   * collapses to a `⟦pasted N lines⟧` token so a 200-line block doesn't bury the
   * prompt — the real text lives in `pastes` and is spliced back at submit.
   * Anything that fits on one line goes in verbatim.
   *
   * Terminals send CR for line breaks inside a bracketed paste, so normalise
   * first: without it a pasted block arrives as one `\r`-joined line and both
   * the line count and the text sent to the model are wrong.
   */
  const insertPaste = (text: string) => {
    const normalised = text.replace(/\r\n?/g, '\n')
    if (!normalised) return
    const current = stateRef.current
    const insert = normalised.includes('\n')
      ? (() => {
          pasteCounter.current += 1
          const token = `⟦pasted ${normalised.split('\n').length} lines #${pasteCounter.current}⟧`
          pastes.set(token, normalised)
          return token
        })()
      : normalised
    const buffer = current.buffer.slice(0, current.cursor) + insert + current.buffer.slice(current.cursor)
    commit({ ...current, buffer, cursor: current.cursor + insert.length, selectedIndex: 0 })
  }

  // Bracketed paste (`\x1b[?2004h`, which this hook enables for as long as it is
  // mounted): the terminal frames the clipboard with ESC[200~/ESC[201~ and Ink
  // reassembles it across stdin chunks, so a paste arrives whole and is never
  // re-read as keystrokes. That is what stops a long paste being truncated and a
  // pasted newline being mistaken for Enter — the fallback in `useInput` below
  // only runs on terminals that ignore the mode.
  // `isActive` matters as much as the handler: Ink routes a paste to the paste
  // channel as soon as *anything* listens on it, so leaving this registered while
  // the prompt is disabled would swallow text meant for whatever overlay took
  // over input (TextPrompt and a searchable Picker both accept typed characters).
  // Standing down hands pastes back to their `useInput` handlers untouched.
  usePaste(
    (text) => {
      if (search) {
        const flat = text.replace(/\s+/g, ' ').trim()
        setSearch((s) => (s ? { query: s.query + flat, index: 0 } : s))
        return
      }
      insertPaste(text)
    },
    { isActive: !props.disabled },
  )

  useInput((input, key) => {
    if (props.disabled) return

    // Interrupt handling (Ctrl+C) is App.tsx's single source of truth — Ink
    // dispatches every keystroke to every mounted useInput hook, so this
    // component must not also react to it or a press would hit both handlers
    // (double abort, and an exit while App's staged two-press quit is pending).

    // --- Reverse-search overlay owns all keys while open ---
    if (search) {
      if (key.escape) return setSearch(null)
      if (key.return) {
        const pick = searchResults[search.index] ?? searchResults[0]
        setSearch(null)
        if (pick) commit({ ...stateRef.current, buffer: pick, cursor: pick.length, selectedIndex: 0 })
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

    // Escape dismisses the mention popup whenever it's open — even with zero
    // matches (no results yet, or the file index still building). Gating this
    // on `fileMatches.length > 0` like the nav/accept keys below would let
    // Escape fall through to normal buffer editing in exactly those cases.
    if (mentionOpen && key.escape) {
      setMentionDismissed(mention!.query)
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
    }

    // The live buffer, not the rendered one — see `stateRef` above.
    const current = stateRef.current

    if (key.tab && !key.shift && current.buffer.length === 0 && filteredCommands(current.buffer, props.commands).length === 0) {
      props.onTabEmpty()
      return
    }
    if (input === '?' && !key.ctrl && !key.meta && current.buffer.length === 0) {
      props.onHelp?.()
      return
    }

    // --- Paste fallback for terminals that ignore bracketed paste mode ---
    // With ESC[200~ framing a paste never reaches here (`usePaste` takes it on a
    // separate channel). Without it the clipboard arrives as ordinary input, so
    // a chunk carrying newlines is the only signal there is.
    if (input.length > 12 && /\r?\n/.test(input)) {
      insertPaste(input)
      return
    }

    const { str, event } = toKeyEvent(input, key)
    const result = applyKey(current, str, event, props.commands)
    if (result.type === 'eof') {
      props.onEof()
      return
    }
    if (result.type === 'interrupt') {
      props.onInterrupt()
      return
    }
    if (result.type === 'submit') {
      // applyKey (a pure reducer with no knowledge of `pastes`) already pushed
      // the raw submitted line — paste tokens intact — onto in-memory history.
      // Expand it here, once, and patch that history entry to the expanded
      // text: otherwise recalling this exact line later (Up-arrow / Ctrl+R)
      // and resubmitting without editing would send the literal placeholder,
      // since `expandPastes` deletes each token from `pastes` the instant it's
      // first consumed below.
      const expanded = expandPastes(result.line)
      let history = result.state.history
      const last = history.length - 1
      if (last >= 0 && history[last] === result.line && expanded !== result.line) {
        history = [...history.slice(0, last), expanded]
      }
      commit({ ...result.state, history, historyIndex: history.length })
      finishSubmit(expanded)
      return
    }
    if (mentionDismissed && result.state.buffer !== current.buffer) setMentionDismissed('')
    commit(result.state)
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
  const nameWidth = Math.min(22, Math.max(0, ...visible.map((cmd) => cmd.name.length)))
  const anyMenu = menu.length > 0 || mentionOpen || search !== null
  const { onMenuChange } = props
  useEffect(() => {
    onMenuChange?.(anyMenu)
  }, [anyMenu, onMenuChange])
  const hiddenAbove = start
  const hiddenBelow = menu.length - (start + visible.length)

  // The rules take the colour of whatever mode the next Enter will act in:
  // a `!` shell line, plan mode, auto-accept — or recede when it is the default.
  const shellLine = !search && state.buffer.startsWith('!')
  const modeColor = shellLine ? palette.bash : props.mode === 'plan' ? palette.plan : props.mode === 'auto' ? palette.auto : undefined
  const ruleColor = props.disabled ? palette.subtle : modeColor ?? palette.subtle

  return (
    <Box flexDirection="column">
      {/* A rule above and below the prompt — the only structural lines in the
          UI. Top and bottom only: side borders are what mis-wrap and flatten
          into `| |` soup when a stray write lands mid-frame. */}
      <Box
        borderStyle="single"
        borderColor={ruleColor}
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
      >
        {/* The glyph keeps its own column: a long line wraps beside it
            instead of squeezing it against the text. */}
        <Box width={2} flexShrink={0}>
          <Text bold color={props.disabled ? palette.muted : modeColor}>
            {glyphs.user}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
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
      </Box>

      {search && (
        <Box flexDirection="column" marginLeft={2}>
          {searchResults.length === 0 ? (
            <Text color={palette.muted}>{search.query ? 'no matching history' : 'reverse-search history — type to search'}</Text>
          ) : (
            searchResults.map((entry, i) => (
              <Text key={entry} bold={i === search.index} color={i === search.index ? palette.selection : palette.muted} wrap="truncate-end">
                {i === search.index ? `${glyphs.user} ` : '  '}
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
            fileMatches.map((path, i) => {
              const active = i === Math.min(mentionSel, fileMatches.length - 1)
              return (
                <Text key={path} bold={active} color={active ? palette.selection : palette.muted} wrap="truncate-end">
                  {active ? `${glyphs.user} ` : '  '}
                  {path}
                </Text>
              )
            })
          )}
        </Box>
      )}

      {menu.length > 0 && !search && (
        <Box flexDirection="column">
          {hiddenAbove > 0 && <Text color={palette.muted}>  ↑ {hiddenAbove} more</Text>}
          {visible.map((cmd) => {
            const active = menu[selected]?.name === cmd.name
            return (
              <Text key={cmd.name} wrap="truncate-end">
                <Text bold={active} color={active ? palette.selection : palette.muted}>
                  {active ? `${glyphs.user} ` : '  '}
                  {cmd.name.padEnd(nameWidth)}
                </Text>
                <Text color={palette.muted}>  {cmd.description}</Text>
              </Text>
            )
          })}
          {hiddenBelow > 0 && <Text color={palette.muted}>  ↓ {hiddenBelow} more</Text>}
        </Box>
      )}
    </Box>
  )
}
