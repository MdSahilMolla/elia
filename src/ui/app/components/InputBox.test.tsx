import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { useInput } from 'ink'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputBox } from './InputBox.tsx'
import { waitForFrame } from '../testFixtures.ts'
import { loadHistory } from '../history.ts'
import { paths } from '../../../statePaths.ts'
import type { SlashCommand } from '../../slashPrompt.ts'

const noop = () => {}
const many: SlashCommand[] = Array.from({ length: 25 }, (_, i) => ({
  name: `/cmd${String(i).padStart(2, '0')}`,
  description: `command number ${i}`,
}))

function mount(commands: SlashCommand[]) {
  return render(
    <InputBox
      commands={commands}
      disabled={false}
      placeholder="type here"
      onSubmit={noop}
      onInterrupt={noop}
      onEof={noop}
      onTabEmpty={noop}
    />,
  )
}

test('typing "/" opens the completion menu with a scroll hint instead of clipping the list', async () => {
  const { stdin, lastFrame } = mount(many)
  stdin.write('/')
  const frame = await waitForFrame(lastFrame, /↓ \d+ more/)

  // First page of entries is visible...
  expect(frame).toContain('/cmd00')
  // ...and the rest is reachable, flagged rather than silently dropped.
  expect(frame).not.toContain('/cmd24') // not on the first page, but the hint says it exists
})

test('a short command list shows every entry with no scroll hints', async () => {
  const { stdin, lastFrame } = mount(many.slice(0, 4))
  stdin.write('/')
  const frame = await waitForFrame(lastFrame, '/cmd03')
  expect(frame).toContain('/cmd00')
  expect(frame).not.toContain('more')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

/** ink-testing-library can coalesce back-to-back writes into one parse; feed keys one at a time. */
async function typeKeys(stdin: { write(data: string): void }, keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k)
    await tick()
  }
}

const LEFT = '\x1B[D'

test('typing after moving the caret left inserts at the caret, not the end (issue #11)', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('ac')
  await waitForFrame(lastFrame, 'ac')
  stdin.write('\x1B[D') // left arrow: caret now sits between "a" and "c"
  await tick()
  stdin.write('b')
  const frame = await waitForFrame(lastFrame, 'abc')
  expect(frame).toContain('abc')
  expect(frame).not.toContain('acb')
})

test('home/end move the caret across the whole buffer', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('world')
  await waitForFrame(lastFrame, 'world')
  stdin.write('\x01') // Ctrl+A → home
  await tick()
  stdin.write('hello ')
  const frame = await waitForFrame(lastFrame, 'hello world')
  expect(frame).toContain('hello world')
})

test('backspace deletes at the caret, not the end', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('axbc')
  await waitForFrame(lastFrame, 'axbc')
  await typeKeys(stdin, [LEFT, LEFT]) // caret between "x" and "b"
  stdin.write('\x7f') // backspace → removes "x"
  const frame = await waitForFrame(lastFrame, /❯ abc\b/)
  expect(frame).toContain('abc')
  expect(frame).not.toContain('axbc')
})

test('the delete key removes the char at the caret, not before it', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('abxc')
  await waitForFrame(lastFrame, 'abxc')
  await typeKeys(stdin, [LEFT, LEFT]) // caret between "b" and "x"
  stdin.write('\u001b[3~') // delete → removes "x", not "b"
  const frame = await waitForFrame(lastFrame, /❯ abc\b/)
  expect(frame).toContain('abc')
  expect(frame).not.toContain('abxc')
})

test('the prompt carries no [mode] chip — the status row names the mode', async () => {
  const { lastFrame } = render(
    <InputBox commands={[]} disabled={false} placeholder="describe it" mode="plan" onSubmit={noop} onInterrupt={noop} onEof={noop} onTabEmpty={noop} />,
  )
  const frame = await waitForFrame(lastFrame, 'describe it')
  expect(frame).toContain('❯')
  expect(frame).not.toContain('[plan]')
})

test('the / menu marks the highlighted command with a pointer and lines descriptions up', async () => {
  const { stdin, lastFrame } = mount([
    { name: '/model', description: 'switch model' },
    { name: '/compact', description: 'summarise the chat' },
  ])
  stdin.write('/')
  const frame = await waitForFrame(lastFrame, '/compact')
  expect(frame).toMatch(/❯ \/model\s+switch model/)
  expect(frame).toMatch(/ {2}\/compact\s+summarise the chat/)
})

test('Ctrl+R opens the reverse-search overlay', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('\x12') // Ctrl+R
  const frame = await waitForFrame(lastFrame, /reverse-search|⌕/)
  expect(frame).toMatch(/⌕|reverse-search/)
})

test('a large multi-line paste collapses to a token but submits the full text', async () => {
  let submitted = ''
  const { stdin } = render(
    <InputBox
      commands={[]}
      disabled={false}
      placeholder="x"
      onSubmit={(line) => {
        submitted = line
      }}
      onInterrupt={noop}
      onEof={noop}
      onTabEmpty={noop}
    />,
  )
  const pasted = ['line one', 'line two', 'line three', 'line four'].join('\n')
  stdin.write(pasted)
  await tick()
  stdin.write('\r')
  await tick()
  expect(submitted).toBe(pasted)
})

test('a paste token that appears twice in the submitted line expands at every occurrence', async () => {
  let submitted = ''
  const { stdin } = render(
    <InputBox
      commands={[]}
      disabled={false}
      placeholder="x"
      onSubmit={(line) => {
        submitted = line
      }}
      onInterrupt={noop}
      onEof={noop}
      onTabEmpty={noop}
    />,
  )
  const pasted = ['line one', 'line two', 'line three', 'line four'].join('\n')
  // Paste the same multi-line block twice back to back — both collapse to the
  // same `⟦pasted N lines⟧` token (keyed by line count), so the buffer ends up
  // with that token appearing twice in a row.
  stdin.write(pasted)
  await tick()
  stdin.write(pasted)
  await tick()
  stdin.write('\r')
  await tick()
  const occurrences = submitted.split(pasted).length - 1
  expect(occurrences).toBe(2)
})

test('submitting a prompt appends it to persistent history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ib-'))
  const original = paths.promptHistory
  ;(paths as { promptHistory: string }).promptHistory = join(dir, 'prompt-history')
  try {
    const { stdin } = mount([])
    stdin.write('remember me')
    await tick()
    stdin.write('\r')
    await tick()
    expect(loadHistory(paths.promptHistory)).toEqual(['remember me'])
  } finally {
    ;(paths as { promptHistory: string }).promptHistory = original
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Ink hands this component every stdin chunk already buffered in one synchronous
 * `readable` loop, so the tests below deliberately write back to back WITHOUT
 * awaiting between writes — that is what a real burst looks like, and it is the
 * shape the older single-`stdin.write` paste tests never exercised.
 */
function mountCapturing(onSubmit: (line: string) => void) {
  return render(
    <InputBox
      commands={[]}
      disabled={false}
      placeholder="x"
      onSubmit={onSubmit}
      onInterrupt={noop}
      onEof={noop}
      onTabEmpty={noop}
    />,
  )
}

test('every backspace byte in one chunk deletes a character (holding the key)', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('abcd')
  await waitForFrame(lastFrame, 'abcd')
  // Ink splits a held backspace into one event per byte, all dispatched before
  // React re-renders: composing each edit on the rendered state deleted one.
  stdin.write('\x7f\x7f\x7f')
  const frame = await waitForFrame(lastFrame, /❯ a\b/)
  expect(frame).toMatch(/❯ a\s/)
  expect(frame).not.toContain('abc')
})

test('the Delete key removes the character under the caret, not behind it', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('abc')
  await waitForFrame(lastFrame, 'abc')
  await typeKeys(stdin, [LEFT, LEFT]) // caret on "b"
  stdin.write('\x1B[3~') // Delete
  const frame = await waitForFrame(lastFrame, /❯ ac\b/)
  expect(frame).toContain('ac')
  expect(frame).not.toContain('abc')
})

test('a paste delivered as several stdin chunks in one tick keeps every chunk', async () => {
  let submitted = ''
  const full = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n')
  const { stdin } = mountCapturing((line) => {
    submitted = line
  })
  const cut = full.indexOf('line four')
  // No await between the writes — Ink drains both chunks in a single loop.
  stdin.write(full.slice(0, cut))
  stdin.write(full.slice(cut))
  await tick()
  stdin.write('\r')
  await tick()
  expect(submitted).toBe(full)
})

test('a bracketed paste arrives whole and its CR line breaks are normalised', async () => {
  let submitted = ''
  const { stdin } = mountCapturing((line) => {
    submitted = line
  })
  // Terminals frame the clipboard with ESC[200~/ESC[201~ and separate lines with
  // CR. The frame can straddle chunk boundaries; Ink reassembles it.
  stdin.write('\x1B[200~alpha\rbeta\r')
  stdin.write('gamma\rdelta\x1B[201~')
  await tick()
  stdin.write('\r')
  await tick()
  expect(submitted).toBe('alpha\nbeta\ngamma\ndelta')
})

test('a large bracketed paste survives being split across many chunks', async () => {
  let submitted = ''
  const { stdin } = mountCapturing((line) => {
    submitted = line
  })
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} of a long pasted block`).join('\n')
  const framed = `\x1B[200~${body}\x1B[201~`
  for (let i = 0; i < framed.length; i += 997) stdin.write(framed.slice(i, i + 997))
  await tick()
  stdin.write('\r')
  await tick()
  expect(submitted).toBe(body)
})

test('a pasted newline does not submit the line the way Enter does', async () => {
  const lines: string[] = []
  const { stdin } = mountCapturing((line) => {
    lines.push(line)
  })
  stdin.write('\x1B[200~first line\rsecond line\r\x1B[201~')
  await tick()
  expect(lines).toEqual([]) // still being composed — nothing sent yet
  stdin.write('\r')
  await tick()
  expect(lines).toEqual(['first line\nsecond line'])
})

test('a disabled prompt hands pastes back to whatever overlay took over input', async () => {
  // Ink routes a paste to the paste channel the moment anything listens there.
  // While the prompt is disabled an overlay (TextPrompt, a searchable Picker)
  // owns the keyboard, so InputBox must stand its paste listener down or the
  // overlay never sees the text.
  let overlayGot = ''
  function Overlay() {
    useInput((input) => {
      overlayGot += input
    })
    return null
  }
  const { stdin } = render(
    <>
      <InputBox
        commands={[]}
        disabled
        placeholder="x"
        onSubmit={noop}
        onInterrupt={noop}
        onEof={noop}
        onTabEmpty={noop}
      />
      <Overlay />
    </>,
  )
  stdin.write('\x1B[200~pasted into the overlay\x1B[201~')
  await tick()
  expect(overlayGot).toContain('pasted into the overlay')
})
