// One clock for everything that moves.
//
// Every animated component used to run its own setInterval, and every tick of
// every one of them re-rendered and repainted the live region separately — a
// spinner per running tool, one per subagent, one in the working line. Here
// they all read one clock: one timer, one state change, one repaint per tick,
// however many things are moving. The clock only runs while something that
// animates is mounted, so an idle prompt costs nothing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { reducedMotion } from './working.ts'

/**
 * 12.5 frames a second. Every frame re-lays-out the whole live region, so the
 * rate is a cost: this is as slow as the shimmer can go and still read as
 * motion (one character per frame), and the spark changes every second frame.
 */
export const TICK_MS = 80
/** Reduced motion only needs the elapsed-time clock to move. */
export const REDUCED_TICK_MS = 1_000

const reduced = reducedMotion()
const tickMs = reduced ? REDUCED_TICK_MS : TICK_MS

interface ClockControl {
  retain(): () => void
}

const TimeContext = createContext<number | null>(null)
const ControlContext = createContext<ClockControl | null>(null)

export function ClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now())
  const users = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const retain = useCallback(() => {
    users.current += 1
    if (!timer.current) {
      setNow(Date.now())
      timer.current = setInterval(() => setNow(Date.now()), tickMs)
    }
    return () => {
      users.current -= 1
      if (users.current === 0 && timer.current) {
        clearInterval(timer.current)
        timer.current = undefined
      }
    }
  }, [])
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
    },
    [],
  )

  const control = useMemo(() => ({ retain }), [retain])
  // Children are passed in from above, so a tick re-renders only the
  // components that read the time — not the tree they sit in.
  return (
    <ControlContext.Provider value={control}>
      <TimeContext.Provider value={now}>{children}</TimeContext.Provider>
    </ControlContext.Provider>
  )
}

/**
 * The current animation time, re-rendering on every shared tick for as long as
 * the calling component is mounted. Mount the moving part only while it moves.
 *
 * Outside a ClockProvider (a component rendered on its own, as in tests) it
 * keeps a private timer instead, so it still animates.
 */
export function useAnimationClock(): number {
  const shared = useContext(TimeContext)
  const control = useContext(ControlContext)
  const [local, setLocal] = useState(() => Date.now())
  useEffect(() => {
    if (control) return control.retain()
    const timer = setInterval(() => setLocal(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [control])
  return control && shared !== null ? shared : local
}

/** Whether motion is reduced for this session (ELIA_REDUCED_MOTION). */
export const motionReduced = reduced
