import { describe, expect, test } from 'bun:test'
import { browserMotionFrame, browserMotionLabel, motionKind, TRACK_WIDTH } from './browserMotion.ts'

const ACTIONS = [
  'status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'click',
  'type', 'press', 'scroll', 'wait', 'wait_for', 'extract', 'verify', 'console', 'network',
]

describe('browser motion', () => {
  test('every frame is exactly the track width, so the row never reflows mid-animation', () => {
    for (const action of ACTIONS) {
      for (let tick = 0; tick < 24; tick += 1) {
        expect(browserMotionFrame(action, tick)).toHaveLength(TRACK_WIDTH)
      }
    }
  })

  test('navigating reads as a head crossing the track, left to right', () => {
    // Pinned rather than described: this is the one motion a reader is meant to
    // recognise without the label, and a silent change to it is a regression
    // nothing else in the suite would notice.
    expect(browserMotionFrame('navigate', 0)).toBe('▸·········')
    expect(browserMotionFrame('navigate', 1)).toBe('─▸········')
    expect(browserMotionFrame('navigate', 2)).toBe('──▸·······')
    expect(browserMotionFrame('navigate', 3)).toBe('·──▸······')
    // It wraps rather than running off the end.
    expect(browserMotionFrame('navigate', TRACK_WIDTH)).toBe(browserMotionFrame('navigate', 0))
  })

  test('a click opens a ring from one point instead of sweeping', () => {
    expect(browserMotionFrame('click', 0)).toBe('·····●····')
    expect(browserMotionFrame('click', 1)).toBe('····◌·◌···')
    expect(browserMotionFrame('click', 2)).toBe('···◌···◌··')
  })

  test('typing accumulates behind a caret', () => {
    expect(browserMotionFrame('type', 0)).toBe('▏         ')
    expect(browserMotionFrame('type', 3)).toBe('···▏      ')
  })

  test('reading sweeps back and forth rather than wrapping', () => {
    const forward = browserMotionFrame('snapshot', 1)
    const back = browserMotionFrame('snapshot', TRACK_WIDTH * 2 - 3)
    expect(forward).toBe(back)
    // The band has a bright centre with a softer edge, so direction is legible.
    expect(browserMotionFrame('snapshot', 0)).toBe('▓▒░░░░░░░░')
  })

  test('actions that mean the same thing to the eye share one motion', () => {
    expect(motionKind('navigate')).toBe('travel')
    expect(motionKind('back')).toBe('travel')
    expect(motionKind('snapshot')).toBe('scan')
    expect(motionKind('extract')).toBe('scan')
    expect(motionKind('console')).toBe('signal')
    expect(motionKind('network')).toBe('signal')
    // Distinct ones stay distinct — this is the whole point of the module.
    expect(motionKind('click')).not.toBe(motionKind('type'))
    expect(motionKind('scroll')).not.toBe(motionKind('navigate'))
  })

  test('waiting looks like waiting — no motion across the track', () => {
    const frames = [0, 1, 2, 3].map((tick) => browserMotionFrame('wait', tick))
    // Only the centre cell ever changes; nothing travels.
    for (const frame of frames) expect(frame.trim()).toHaveLength(1)
  })

  test('an unknown or missing action degrades to the calm pulse instead of throwing', () => {
    expect(motionKind(undefined)).toBe('pulse')
    expect(motionKind('teleport')).toBe('pulse')
    expect(browserMotionFrame(undefined, 0)).toHaveLength(TRACK_WIDTH)
    expect(browserMotionFrame('teleport', 7)).toHaveLength(TRACK_WIDTH)
  })

  test('a nonsense tick or width cannot produce a broken row', () => {
    expect(browserMotionFrame('navigate', -5)).toHaveLength(TRACK_WIDTH)
    expect(browserMotionFrame('navigate', Number.NaN)).toHaveLength(TRACK_WIDTH)
    expect(browserMotionFrame('navigate', 2, 3)).toHaveLength(3)
    // A width below the floor is raised rather than producing an empty string.
    expect(browserMotionFrame('navigate', 2, 0).length).toBeGreaterThan(0)
  })

  test('the label admits when an action is taking a while', () => {
    expect(browserMotionLabel('navigate', 200)).toBe('loading')
    expect(browserMotionLabel('navigate', 4_000)).toBe('still loading')
    expect(browserMotionLabel('snapshot', 4_000)).toBe('still reading')
    expect(browserMotionLabel('click', 200)).toBe('interacting')
    expect(browserMotionLabel('scroll', 200)).toBe('scrolling')
    expect(browserMotionLabel('console', 200)).toBe('listening')
    expect(browserMotionLabel('wait', 200)).toBe('waiting')
  })

  test('actions that share the scan motion still get their own word', () => {
    // The shape is right for all three — something is being looked for — but
    // "Waiting for #results … reading" says two different things in one row.
    expect(motionKind('wait_for')).toBe(motionKind('snapshot'))
    expect(browserMotionLabel('wait_for', 200)).toBe('watching')
    expect(browserMotionLabel('wait_for', 4_000)).toBe('still watching')
    expect(browserMotionLabel('verify', 200)).toBe('checking')
  })
})
