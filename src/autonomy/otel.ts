import { redactRecord } from '../ui/redact.ts'
import { logSwallowedError } from '../diagnostics.ts'
import type { JournalEvent } from './journal.ts'

/**
 * An optional OTLP/HTTP+JSON sink that mirrors journal.ts events to an
 * external collector, purely additive: the local journal (events.ndjson,
 * checkpoints/) stays the actual source of truth a run can be rewound from,
 * and this never affects whether a run succeeds — a down or misconfigured
 * collector degrades to "no export", never to a failed run.
 *
 * JSON, not protobuf: the standard OTel Collector's OTLP HTTP receiver
 * accepts both (dispatched on Content-Type), and JSON avoids pulling in a
 * protobuf codegen toolchain for what is, from elia's side, a batch of plain
 * key/value log records.
 */

const OTLP_LOGS_PATH = '/v1/logs'
const FLUSH_INTERVAL_MS = 2_000
const MAX_BATCH = 200
const EXPORT_TIMEOUT_MS = 5_000

export function otelEndpoint(): string | undefined {
  const value = process.env.ELIA_OTEL_ENDPOINT?.trim()
  return value ? value.replace(/\/+$/, '') : undefined
}

export function otelEnabled(): boolean {
  return otelEndpoint() !== undefined
}

interface QueuedEvent {
  runId: string
  event: JournalEvent
}

let queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

/** Queues one journal event for export, debounced to a batch — never called from a hot synchronous path with any real cost when disabled. */
export function otelExportEvent(runId: string, event: JournalEvent): void {
  if (!otelEnabled()) return
  queue.push({ runId, event })
  if (queue.length >= MAX_BATCH) {
    flush()
    return
  }
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined
    flush()
  }, FLUSH_INTERVAL_MS)
}

/** Forces an immediate flush — call at run end so a short run's tail isn't lost to the debounce window. */
export function otelFlush(): void {
  flush()
}

/** Test-only: drops any queued events and cancels a pending flush, without sending anything. */
export function resetOtelStateForTests(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
  queue = []
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (queue.length === 0) return
  const batch = queue
  queue = []
  const endpoint = otelEndpoint()
  if (!endpoint) return

  let body: string
  try {
    body = JSON.stringify(buildExportRequest(batch))
  } catch (err) {
    logSwallowedError('otel.export.serialize', err, { batchSize: batch.length })
    return
  }
  fetch(`${endpoint}${OTLP_LOGS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
  }).catch((err) => {
    logSwallowedError('otel.export.fetch', err, { endpoint })
  })
}

function buildExportRequest(batch: QueuedEvent[]): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', 'elia')] },
        scopeLogs: [
          {
            scope: { name: 'elia.autonomy.journal' },
            logRecords: batch.map(({ runId, event }) => toLogRecord(runId, event)),
          },
        ],
      },
    ],
  }
}

function toLogRecord(runId: string, event: JournalEvent): unknown {
  // Redacted the same way diagnostics.ts redacts before writing — this data
  // is leaving the machine, so it gets no less scrutiny than a local log file.
  const redactedData = redactRecord(event.data)
  return {
    timeUnixNano: String(BigInt(event.at) * 1_000_000n),
    severityText: event.kind === 'verdict' || event.kind === 'run-end' ? 'INFO' : 'DEBUG',
    body: { stringValue: event.kind },
    attributes: [
      attr('run.id', runId),
      attr('event.seq', event.seq),
      attr('event.kind', event.kind),
      ...Object.entries(redactedData).map(([key, value]) => attr(`elia.${key}`, value)),
    ],
  }
}

function attr(key: string, value: unknown): { key: string; value: Record<string, unknown> } {
  if (typeof value === 'number' && Number.isInteger(value)) return { key, value: { intValue: value } }
  if (typeof value === 'number') return { key, value: { doubleValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (value === undefined || value === null) return { key, value: { stringValue: '' } }
  try {
    return { key, value: { stringValue: JSON.stringify(value) } }
  } catch {
    return { key, value: { stringValue: String(value) } }
  }
}
