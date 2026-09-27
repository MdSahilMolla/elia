import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { createSessionBus } from '../../session/bus.ts'
import { makeSessionName, type SessionBus } from '../../session/types.ts'
import { SessionBar, useSessionBarData } from './SessionBar.tsx'
import { SessionShortcuts } from './SessionShortcuts.tsx'
import { sessionKeyCombo } from './sessionShortcuts.ts'
import { sessionKeyAction } from './sessionActions.ts'
import { waitForFrame } from './testFixtures.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('useSessionBarData exposes handles, glyphs and the rendered bar text', async () => {
  const bus: SessionBus = createSessionBus()
  const shop = bus.create(makeSessionName('shop'))
  const dash = bus.create(makeSessionName('dash'))
  bus.setStatus(shop.id, 'waiting-input')
  bus.setStatus(dash.id, 'idle')

  function Probe() {
    const data = useSessionBarData({ bus, pollMs: 20 })
    return (
      <Text>
        {data.handles.length}|{data.glyph[shop.id] ?? '?'}|{data.glyph[dash.id] ?? '?'}|{data.barText}
      </Text>
    )
  }

  const { lastFrame, unmount } = render(<Probe />)
  try {
    const frame = await waitForFrame(lastFrame, '2|?|○|', 2000)
    expect(frame).toContain('? shop · ○ dash')
  } finally {
    unmount()
  }
})

test('SessionBar renders live session chips and follows status changes', async () => {
  const bus: SessionBus = createSessionBus()
  const ui = bus.create(makeSessionName('ui'))
  bus.create(makeSessionName('db'))

  const { lastFrame, unmount } = render(<SessionBar bus={bus} pollMs={20} />)
  try {
    await waitForFrame(lastFrame, '● ui · ● db', 2000)
    bus.setStatus(ui.id, 'idle')
    const frame = await waitForFrame(lastFrame, '○ ui', 2000)
    expect(frame).toContain('● db')
    expect(frame).not.toContain('[')
  } finally {
    unmount()
  }
})

test('SessionBar renders nothing when empty or hidden', async () => {
  const empty = createSessionBus()
  const first = render(<SessionBar bus={empty} pollMs={20} />)
  try {
    await sleep(80)
    expect(first.lastFrame() ?? '').not.toContain('●')
  } finally {
    first.unmount()
  }

  // One session is just this one — the status row covers it.
  const lone = createSessionBus()
  lone.create(makeSessionName('main'))
  const single = render(<SessionBar bus={lone} pollMs={20} />)
  try {
    await sleep(80)
    expect(single.lastFrame() ?? '').not.toContain('main')
  } finally {
    single.unmount()
  }

  const bus = createSessionBus()
  bus.create(makeSessionName('hidden'))
  bus.create(makeSessionName('also-hidden'))
  const second = render(<SessionBar bus={bus} pollMs={20} visible={false} />)
  try {
    await sleep(80)
    expect(second.lastFrame() ?? '').not.toContain('●')
  } finally {
    second.unmount()
  }
})

test('auto-focus switches to a waiting-input session and surfaces one notice', async () => {
  const bus = createSessionBus()
  const lead = bus.create(makeSessionName('lead'))
  bus.setActiveSession(lead.id)
  const notices: string[] = []
  const worker = bus.create(makeSessionName('worker'))

  const { unmount } = render(<SessionBar bus={bus} pollMs={15} activeRunning={false} onAutoFocus={(text) => notices.push(text)} />)
  try {
    bus.setStatus(worker.id, 'waiting-input')
    await sleep(150)
    expect(bus.activeSession).toBe(worker.id)
    expect(notices).toHaveLength(1)
    await sleep(120)
    expect(notices).toHaveLength(1)
  } finally {
    unmount()
  }
})

test('auto-focus holds the bus still while the current session is mid-turn', async () => {
  const bus = createSessionBus()
  const lead = bus.create(makeSessionName('lead'))
  bus.setActiveSession(lead.id)
  const notices: string[] = []
  const worker = bus.create(makeSessionName('worker'))

  const { unmount } = render(<SessionBar bus={bus} pollMs={15} activeRunning={true} onAutoFocus={(text) => notices.push(text)} />)
  try {
    bus.setStatus(worker.id, 'waiting-input')
    await sleep(150)
    expect(notices).toEqual([])
    expect(bus.activeSession).toBe(lead.id)
  } finally {
    unmount()
  }
})

test('auto-focus leaves the already-active waiting session alone', async () => {
  const bus = createSessionBus()
  const self = bus.create(makeSessionName('self'))
  bus.setActiveSession(self.id)
  const notices: string[] = []

  const { unmount } = render(<SessionBar bus={bus} pollMs={15} activeRunning={false} onAutoFocus={(text) => notices.push(text)} />)
  try {
    bus.setStatus(self.id, 'waiting-input')
    await sleep(150)
    expect(notices).toEqual([])
    expect(bus.activeSession).toBe(self.id)
  } finally {
    unmount()
  }
})

test('session key combos spawn sessions and cycle the active session', async () => {
  const bus = createSessionBus()
  const one = bus.create(makeSessionName('one'))
  const two = bus.create(makeSessionName('two'))
  bus.setActiveSession(one.id)
  let spawns = 0
  const cycled: string[] = []

  const { stdin, unmount } = render(
    <SessionShortcuts bus={bus} onSpawnSession={() => { spawns += 1 }} onCycle={(handle) => cycled.push(String(handle.name))} />,
  )
  try {
    stdin.write('\x1b[78;6u') // kitty ctrl+shift+N
    await sleep(60)
    expect(spawns).toBe(1)

    stdin.write('\x1b[9;5u') // kitty ctrl+tab
    await sleep(60)
    expect(bus.activeSession).toBe(two.id)
    expect(cycled).toEqual(['two'])

    stdin.write('\x1b[9;6u') // kitty ctrl+shift+tab
    await sleep(60)
    expect(bus.activeSession).toBe(one.id)
    expect(cycled).toEqual(['two', 'one'])
  } finally {
    unmount()
  }
})

test('sessionKeyCombo maps Ink key objects to the sessionKeyAction combos', () => {
  expect(sessionKeyCombo('n', { ctrl: true })).toBe('ctrl-shift-n')
  expect(sessionKeyCombo('N', { ctrl: true, shift: true })).toBe('ctrl-shift-n')
  expect(sessionKeyCombo('', { ctrl: true, tab: true })).toBe('ctrl-tab')
  expect(sessionKeyCombo('', { ctrl: true, shift: true, tab: true })).toBe('ctrl-shift-tab')
  expect(sessionKeyCombo('o', { ctrl: true })).toBeUndefined()
  expect(sessionKeyCombo('', { tab: true })).toBeUndefined()
  expect(sessionKeyCombo('', { shift: true, tab: true })).toBeUndefined()
  expect(sessionKeyCombo('q', {})).toBeUndefined()

  // The full contract: what the mapping produces is exactly what the pure
  // decision helper consumes for a fleet of sessions.
  expect(sessionKeyAction(sessionKeyCombo('n', { ctrl: true })!, 1, 3)).toEqual({ type: 'spawn' })
  expect(sessionKeyAction(sessionKeyCombo('', { ctrl: true, tab: true })!, 1, 3)).toEqual({ type: 'cycle-next' })
  expect(sessionKeyAction(sessionKeyCombo('', { ctrl: true, shift: true, tab: true })!, 1, 3)).toEqual({ type: 'cycle-prev' })
})

test('the change signature detects an in-place setStatus(blocked) that left the handle object untouched', async () => {
  const bus: SessionBus = createSessionBus()
  const gates = bus.create(makeSessionName('gates'))
  const before = bus.get(gates.id)

  function Probe() {
    const data = useSessionBarData({ bus, pollMs: 20 })
    return <Text>{data.glyph[gates.id] ?? '?'}|{data.sig}</Text>
  }

  const { lastFrame, unmount } = render(<Probe />)
  try {
    await waitForFrame(lastFrame, '●|', 2000)

    bus.setStatus(gates.id, 'blocked')

    expect(bus.get(gates.id)).toBe(before)
    expect(before?.status).toBe('blocked')

    const frame = await waitForFrame(lastFrame, new RegExp(`${gates.id}:blocked:gates`), 2000)
    expect(frame.startsWith('!|')).toBe(true)
  } finally {
    unmount()
  }
})

test('SessionBar repaints the blocked glyph for a live setStatus on the same handle bus.list() returns', async () => {
  const bus: SessionBus = createSessionBus()
  const gate = bus.create(makeSessionName('gate'))
  bus.create(makeSessionName('other'))
  const listed = bus.list()[0]

  const { lastFrame, unmount } = render(<SessionBar bus={bus} pollMs={20} />)
  try {
    await waitForFrame(lastFrame, '● gate', 2000)
    bus.setStatus(gate.id, 'blocked')
    const frame = await waitForFrame(lastFrame, '! gate', 2000)
    expect(bus.list()[0]).toBe(listed)
    expect(frame).toContain('! gate · ● other')
  } finally {
    unmount()
  }
})
