/**
 * The motion under a running `browser` card.
 *
 * A spinner says "something is happening". It does not say *what*, and the
 * browser tool is the one place in the transcript where that difference
 * carries information: the actions look nothing alike. Navigating goes
 * somewhere. Reading sweeps a page. A click lands in one spot. Typing
 * accumulates. Waiting does none of those and should look like it.
 *
 * So the track encodes the action instead of decorating it — a glance tells you
 * which of them elia is doing without reading the label, the same way the diff
 * gutter tells you an edit landed without reading the numbers.
 *
 * Pure on purpose. An animation nobody can assert on is an animation that
 * silently rots, and this file is where the rot would be invisible: every
 * frame is a string, so the suite pins them the way it pins toolSummary's.
 */

/** How a browser action moves. Several actions share one shape — they mean the same thing to the eye. */
export type MotionKind = 'travel' | 'scan' | 'tap' | 'keys' | 'vertical' | 'signal' | 'pulse'

const KIND_BY_ACTION: Record<string, MotionKind> = {
  navigate: 'travel',
  refresh: 'travel',
  back: 'travel',
  forward: 'travel',
  snapshot: 'scan',
  extract: 'scan',
  verify: 'scan',
  wait_for: 'scan',
  click: 'tap',
  press: 'tap',
  type: 'keys',
  scroll: 'vertical',
  console: 'signal',
  network: 'signal',
  status: 'pulse',
  wait: 'pulse',
}

export function motionKind(action: string | undefined): MotionKind {
  return KIND_BY_ACTION[(action ?? '').trim().toLowerCase()] ?? 'pulse'
}

/** Track width. Ten cells reads as a distance without crowding a narrow terminal. */
export const TRACK_WIDTH = 10

const cells = (width: number, pick: (index: number) => string): string =>
  Array.from({ length: width }, (_, index) => pick(index)).join('')

/** A head running left to right with a short trail — going somewhere. */
function travel(tick: number, width: number): string {
  const head = tick % width
  return cells(width, (i) => (i === head ? '▸' : i === head - 1 || i === head - 2 ? '─' : '·'))
}

/** A band sweeping back and forth — reading across a page rather than crossing it. */
function scan(tick: number, width: number): string {
  const period = Math.max(1, (width - 1) * 2)
  const phase = tick % period
  const centre = phase < width ? phase : period - phase
  return cells(width, (i) => {
    const distance = Math.abs(i - centre)
    return distance === 0 ? '▓' : distance === 1 ? '▒' : '░'
  })
}

/** A ring opening out from the point of contact — one spot, not a sweep. */
function tap(tick: number, width: number): string {
  const centre = Math.floor(width / 2)
  const radius = tick % 5
  return cells(width, (i) => {
    const distance = Math.abs(i - centre)
    if (radius === 0) return distance === 0 ? '●' : '·'
    return distance === radius ? '◌' : '·'
  })
}

/** Characters accumulating behind a caret. */
function keys(tick: number, width: number): string {
  const caret = tick % width
  return cells(width, (i) => (i < caret ? '·' : i === caret ? '▏' : ' '))
}

/** A wave running through the three braille heights — movement down the page, not across it. */
function vertical(tick: number, width: number): string {
  const levels = ['⠁', '⠂', '⠄']
  return cells(width, (i) => levels[(tick + i) % levels.length]!)
}

/** Traffic: bars of varying height travelling along the track. */
function signal(tick: number, width: number): string {
  const levels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃', '▂']
  return cells(width, (i) => levels[(tick + i * 2) % levels.length]!)
}

/** A slow breath. Nothing is moving, and the track should not pretend otherwise. */
function pulse(tick: number, width: number): string {
  const centre = Math.floor(width / 2)
  const glyph = ['·', '∘', '○', '∘'][tick % 4]!
  return cells(width, (i) => (i === centre ? glyph : ' '))
}

const RENDERERS: Record<MotionKind, (tick: number, width: number) => string> = {
  travel,
  scan,
  tap,
  keys,
  vertical,
  signal,
  pulse,
}

/**
 * One frame of the track for `action` at `tick`.
 *
 * Every frame is exactly `width` cells, so the row never reflows as it animates
 * — a track that changed length would drag the text after it left and right on
 * every repaint.
 */
export function browserMotionFrame(action: string | undefined, tick: number, width: number = TRACK_WIDTH): string {
  const safeWidth = Math.max(3, Math.floor(width))
  const safeTick = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0
  return RENDERERS[motionKind(action)](safeTick, safeWidth)
}

/**
 * What the track is doing, in words, for the row beside it.
 *
 * Deliberately not the tool's own verb: the header already says "Navigating
 * to example.com", and repeating it under the header would be two lines
 * carrying one fact. This says where in the action elia is instead.
 */
export function browserMotionLabel(action: string | undefined, elapsedMs: number): string {
  const kind = motionKind(action)
  const name = (action ?? '').trim().toLowerCase()
  // `wait_for` and `verify` share the scan motion — both are looking for
  // something on the page, which is the right shape — but neither is "reading",
  // and a row reading "Waiting for #results … reading" says two things at once.
  if (name === 'wait_for') return elapsedMs > 1_500 ? 'still watching' : 'watching'
  if (name === 'verify') return 'checking'
  // The first moment of any browser action in a session can include a cold
  // browser launch (~1s), which otherwise looks like a hang on a fast page.
  if (elapsedMs > 1_500 && kind === 'travel') return 'still loading'
  if (elapsedMs > 1_500 && kind === 'scan') return 'still reading'
  switch (kind) {
    case 'travel': return 'loading'
    case 'scan': return 'reading'
    case 'tap': return 'interacting'
    case 'keys': return 'typing'
    case 'vertical': return 'scrolling'
    case 'signal': return 'listening'
    default: return 'waiting'
  }
}
