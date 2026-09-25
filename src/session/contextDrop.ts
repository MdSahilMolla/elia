/**
 * Context drops: publish a named payload from one session that other sessions
 * can subscribe to. A drop is injected into a subscriber as a context block —
 * never as a user message — so it informs a subscriber's ongoing work without
 * interrupting it.
 */
import type { ContextDrop, SessionBus, SessionId } from './types.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { writeNotice } from '../ui/stream.ts'

/** Keeps each subscription's lease alive for the life of the process. */
const subscriptionLeases = new Set<() => void>()

let testBus: SessionBus | undefined

/** Test seam: point the CLI handlers at a fake bus so they are unit-testable without the real registry. */
export function setSessionBusForTests(bus: SessionBus): void {
  testBus = bus
}

export function resetSessionBusForTests(): void {
  testBus = undefined
}

async function resolveBus(): Promise<SessionBus> {
  if (testBus) return testBus
  // Lazy + dynamic so this module stays loadable before the sibling bus.ts
  // lands; the registry itself exports getSessionBus().
  const specifier = './bus.ts'
  const imported = (await import(specifier)) as { getSessionBus?: () => SessionBus }
  if (typeof imported.getSessionBus !== 'function') {
    throw new Error('Session bus is unavailable: getSessionBus() was not exported by src/session/bus.ts.')
  }
  return imported.getSessionBus()
}

/**
 * Builds a ContextDrop from name/payload/source, stamps it with an id and
 * timestamp, hands it to the bus (`emitDrop` fans it out to subscribers and the
 * cross:context-sync event), and returns it.
 */
export function publishDrop(ctx: { name: string; payload: unknown; fromSession: SessionId; bus: SessionBus }): ContextDrop {
  const drop: ContextDrop = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name: ctx.name,
    fromSession: ctx.fromSession,
    payload: ctx.payload,
    emittedAt: Date.now(),
  }
  ctx.bus.emitDrop(drop)
  return drop
}

/** Reads a drop payload file: `.json` parses, anything else returns the raw text. */
export async function loadDropPayload(path: string): Promise<unknown> {
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    throw new Error(`Could not read the context-drop payload file: ${path}`)
  }
  if (!path.toLowerCase().endsWith('.json')) return text
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Context-drop payload "${path}" is not valid JSON.`)
  }
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    const encoded = JSON.stringify(payload, null, 2)
    return encoded === undefined ? String(payload) : encoded
  } catch {
    return String(payload)
  }
}

function resolveFromSession(bus: SessionBus, ref: string | undefined): SessionId {
  if (ref !== undefined) {
    const handle = bus.resolve(ref)
    if (!handle) throw new Error(`Unknown session "${ref}" — cannot publish a context drop from it.`)
    return handle.id
  }
  const active = bus.activeSession
  if (!active) throw new Error('No active session — pass --from <session> to publish a context drop.')
  return active
}

function resolveTarget(bus: SessionBus, ref: string): SessionId {
  const active = bus.activeSession
  if (active) return active
  const handle = bus.resolve(ref)
  if (!handle) throw new Error(`Unknown session "${ref}" — cannot subscribe.`)
  return handle.id
}

/**
 * CLI handler for publishing a context drop: resolves the source session
 * (defaulting to the bus's active session), loads the payload file when one is
 * given, publishes, and reports the result.
 */
export async function runContextDrop(opts: {
  name: string
  payloadPath?: string
  fromSession?: string
  json?: boolean
  quiet?: boolean
}): Promise<void> {
  const bus = await resolveBus()
  const fromSession = resolveFromSession(bus, opts.fromSession)
  const payload = opts.payloadPath === undefined ? undefined : await loadDropPayload(opts.payloadPath)
  const drop = publishDrop({ name: opts.name, payload, fromSession, bus })

  emitEvent('context_drop', { ...drop })
  if (machineReadable) return
  if (opts.json) {
    try {
      process.stdout.write(`${JSON.stringify({ type: 'context_drop', at: new Date().toISOString(), ...drop })}\n`)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ type: 'context_drop', at: new Date().toISOString(), id: drop.id, name: drop.name, fromSession: drop.fromSession })}\n`,
      )
    }
    return
  }
  if (!opts.quiet) writeNotice(`context drop "${drop.name}" published from ${drop.fromSession} (id ${drop.id})`)
}

/**
 * CLI handler for subscribing to a context drop: registers the subscription
 * against the active session (or the given ref) for this process's lifetime,
 * announces it, and — whenever a matching drop fires — prints the payload as a
 * context block.
 */
export async function runContextSubscribe(opts: {
  name: string
  fromSession: string
  json?: boolean
  quiet?: boolean
}): Promise<void> {
  const bus = await resolveBus()
  const target = resolveTarget(bus, opts.fromSession)
  const unsubscribe = bus.subscribeDrop(target, opts.name, (drop) => {
    if (!opts.quiet) writeNotice(`[context drop: ${opts.name}] ${payloadText(drop.payload)}`)
  })
  subscriptionLeases.add(unsubscribe)

  emitEvent('context_subscribed', { name: opts.name, target })
  if (machineReadable) return
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ type: 'context_subscribed', at: new Date().toISOString(), name: opts.name, target })}\n`)
    return
  }
  if (!opts.quiet) writeNotice(`subscribed to context drop "${opts.name}" on session ${target}`)
}