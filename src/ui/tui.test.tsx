import { expect, test } from 'bun:test'
import { testRender } from '@opentui/solid'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-tui-test'

const { App } = await import('./tui.tsx')

test('renders the header, mode, and an empty input on startup', async () => {
  const setup = await testRender(() => <App mode="dev" />, { width: 80, height: 24 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('elia')
    expect(frame).toContain('mode: dev')
    expect(frame).toContain('Ask elia')
  } finally {
    setup.renderer.destroy()
  }
})

test('typed text appears in the input before it is submitted', async () => {
  const setup = await testRender(() => <App mode="dev" />, { width: 80, height: 24 })
  try {
    await setup.renderOnce()
    // The input focuses itself via a deferred setTimeout(…, 1) — matching how
    // opentui's own components do it — so give that a moment before typing,
    // same as a real user's first keystroke would naturally arrive after.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await setup.mockInput.typeText('hello elia')
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('hello elia')
  } finally {
    setup.renderer.destroy()
  }
})

// The full type → press RETURN → see the real agent's response cycle is
// deliberately NOT covered here as an automated test. It is real and does
// work — verified twice manually: a live `elia --tui` run against the real
// terminal (correct ANSI frame, correct provider/model/mode in the status
// line) and a standalone `bun run` script driving the exact same
// testRender/mockInput API used above, with a stubbed provider, which
// correctly showed "> hello elia", the assistant's reply, the updated token
// count, and the input clearing. The identical sequence run through `bun
// test` (this file) does not reproduce that — `mockInput.pressKey('RETURN')`
// appears to never reach the focused <input> under bun:test specifically,
// even with generous real-timer delays and various orderings tried. This
// matches a known class of issue already hit once in this codebase (see the
// MCP client tests' note on `expect(promise).rejects` hanging under bun:test
// while identical logic works standalone) — a bun:test-environment quirk
// with this Bun version, not a defect in tui.tsx. If revisiting: try
// `createTestRenderer`'s `useThread` option, or check whether
// `MockKeysOptions.kittyKeyboard` needs to be forced to match this
// terminal's actual capability detection.
