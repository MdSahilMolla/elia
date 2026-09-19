// The frames behind the working indicator — pure, so the suite can pin them.
//
// Everything that moves on screen is a function of elapsed time: the spark's
// shape, where the shimmer band is on the label, how far the spark has faded
// toward "stalled", how far the token counter has caught up. Components only
// read the shared clock (animation.tsx) and call these.

import { sparkFrames } from './theme.ts'

/** One spark shape every this many ms — a calm breath, not a strobe. Two animation ticks. */
export const SPARK_FRAME_MS = 160

export function sparkFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPARK_FRAME_MS) % sparkFrames.length
  return sparkFrames[index]!
}

/** A running tool's dot breathes once per this many ms. */
export const PULSE_MS = 1_200

/** 1 at the start of each breath, 0 halfway through, back to 1 — a cosine, not a blink. */
export function pulseLevel(elapsedMs: number): number {
  const phase = (Math.max(0, elapsedMs) % PULSE_MS) / PULSE_MS
  return (1 + Math.cos(phase * 2 * Math.PI)) / 2
}

// ------------------------------------------------------------------ colour

export function parseHex(color: string | undefined): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(color ?? '')
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

const hex2 = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')

/**
 * `a` blended toward `b` by `t` (0–1). Named colours can't be blended, so they
 * snap: `a` below the halfway point, `b` from it.
 */
export function mixColor(a: string | undefined, b: string | undefined, t: number): string | undefined {
  const amount = Math.min(1, Math.max(0, t))
  const from = parseHex(a)
  const to = parseHex(b)
  if (!from || !to) return amount < 0.5 ? a : b
  return `#${hex2(from[0] + (to[0] - from[0]) * amount)}${hex2(from[1] + (to[1] - from[1]) * amount)}${hex2(from[2] + (to[2] - from[2]) * amount)}`
}

// ----------------------------------------------------------------- shimmer

export interface ColorRun {
  text: string
  color: string | undefined
}

/** How fast the bright band travels, and how wide and how far apart its passes are. */
export const SHIMMER_CHARS_PER_SECOND = 12.5
export const SHIMMER_RADIUS = 3
export const SHIMMER_PAUSE_CHARS = 16
/** Blend levels the band uses — few enough that neighbouring cells merge into one run. */
const SHIMMER_STEPS = 4

/**
 * `text` split into coloured runs with a bright band sweeping left to right
 * across it, then resting off-screen for a beat before the next pass.
 *
 * Returns a single run in `base` when there is nothing to blend (no colour,
 * named ANSI colours, reduced motion).
 */
export function shimmerRuns(text: string, elapsedMs: number, base: string | undefined, highlight: string | undefined, enabled = true): ColorRun[] {
  const chars = Array.from(text)
  if (!enabled || chars.length === 0 || !parseHex(base) || !parseHex(highlight)) return [{ text, color: base }]
  const period = chars.length + SHIMMER_RADIUS * 2 + SHIMMER_PAUSE_CHARS
  const head = ((Math.max(0, elapsedMs) / 1000) * SHIMMER_CHARS_PER_SECOND) % period - SHIMMER_RADIUS
  const runs: ColorRun[] = []
  for (let i = 0; i < chars.length; i += 1) {
    const distance = Math.abs(i - head)
    const raw = distance >= SHIMMER_RADIUS ? 0 : (1 + Math.cos((Math.PI * distance) / SHIMMER_RADIUS)) / 2
    const level = Math.round(raw * SHIMMER_STEPS) / SHIMMER_STEPS
    const color = level === 0 ? base : mixColor(base, highlight, level)
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.text += chars[i]
    else runs.push({ text: chars[i]!, color })
  }
  return runs
}

// ------------------------------------------------------------------- stall

/** Silence from the model this long before the spark starts to fade… */
export const STALL_AFTER_MS = 10_000
/** …and this long before it has fully faded. */
export const STALL_FULL_MS = 30_000

/** 0 while output is arriving, rising to 1 as the model stays silent. */
export function stallLevel(quietMs: number): number {
  if (quietMs <= STALL_AFTER_MS) return 0
  return Math.min(1, (quietMs - STALL_AFTER_MS) / (STALL_FULL_MS - STALL_AFTER_MS))
}

// ----------------------------------------------------------------- counter

/** How quickly a counter closes the gap to its target: about a third of it per 60ms. */
export const COUNT_EASE_MS = 150

/**
 * A counter catching up with its target after `elapsedMs`: the gap shrinks
 * exponentially with real time — so a slow frame rate never leaves the number
 * behind — by at least one, and never past the target. Numbers roll instead
 * of jumping.
 */
export function easeToward(shown: number, target: number, elapsedMs = 60): number {
  if (shown >= target) return target
  const remaining = (target - shown) * Math.exp(-Math.max(0, elapsedMs) / COUNT_EASE_MS)
  return Math.min(target, Math.max(shown + 1, Math.round(target - remaining)))
}

// ------------------------------------------------------------------- flare

/**
 * The spark catching once, for the moment elia commits a lesson to memory: a
 * point flares into a star and settles on ✦ — the working spark's own frames,
 * played a single time, not looped.
 */
export const FLARE_FRAMES = ['·', '✧', '✦', '✶', '✷', '✸', '✷', '✶', '✦'] as const
export const FLARE_STEP_MS = 70
export const FLARE_MS = FLARE_FRAMES.length * FLARE_STEP_MS

/** The flare's glyph `sinceMs` after the lesson landed, or undefined once it has settled. */
export function flareFrame(sinceMs: number): string | undefined {
  if (sinceMs < 0 || sinceMs >= FLARE_MS) return undefined
  return FLARE_FRAMES[Math.floor(sinceMs / FLARE_STEP_MS)]
}

/**
 * `text` with one shimmer band crossing it exactly once over the flare, left
 * to right — the shimmer's own curve, just timed to the flare instead of to
 * its resting pace.
 */
export function flareRuns(text: string, sinceMs: number, base: string | undefined, highlight: string | undefined, enabled = true): ColorRun[] {
  const progress = Math.min(1, Math.max(0, sinceMs / FLARE_MS))
  if (progress >= 1) return [{ text, color: base }]
  const travel = Array.from(text).length + SHIMMER_RADIUS * 2
  return shimmerRuns(text, (progress * travel * 1000) / SHIMMER_CHARS_PER_SECOND, base, highlight, enabled)
}
