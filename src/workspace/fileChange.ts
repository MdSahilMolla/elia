/**
 * `FileChanged` as an observation of the shared folder, rather than a report
 * that an agent finished touching one file.
 *
 * The split this module enforces is the one that makes the file plane safe to
 * replicate. Metadata is persisted, replicated and audited: it says a path
 * changed, by which node, and by how much. The diff body is not persisted at
 * all, because the event log is durable, replicated to every peer, hashed into
 * the audit chain and retained until compaction — so a body would outlive the
 * session that produced it and could not be reliably scrubbed afterwards.
 *
 * `buildFileChangedPayload` is therefore the only supported way to construct the
 * persisted payload, and it returns a fixed set of scalar fields. There is no
 * property on the result a diff body could be smuggled into.
 */

import { parseUnifiedDiff, renderUnifiedDiff, shouldWithholdDiffBody, WITHHELD_NOTICE } from './diff.ts'

export type FileChangeOp = 'create' | 'write' | 'delete'

/**
 * The persisted record of one change to the shared folder. Every field is a
 * scalar or a fixed-size count; nothing here holds file content.
 */
export interface FileChangeMeta {
  path: string
  op: FileChangeOp
  /** The peer that made the change, so a reader can attribute it. */
  originNode: string
  oldSha: string
  newSha: string
  added: number
  removed: number
  size: number
  /** True when the body was withheld rather than shown or stored. */
  diffWithheld: boolean
}

/**
 * A change as the sidecar reports it, including the diff body it computed for
 * the wire. The body is an input to display only.
 */
export interface IncomingFileChange extends Omit<FileChangeMeta, 'diffWithheld'> {
  /** Unified diff text, or empty when the sidecar sent counts only. */
  diff?: string
  /** True when the sidecar reported binary content. */
  binary?: boolean
}

/**
 * Reduces an incoming change to the persistable payload.
 *
 * The withholding decision is made here rather than by the caller so that no
 * call site can forget it: a sensitive path yields metadata with
 * `diffWithheld: true` and no body, whatever the sidecar sent.
 */
export function buildFileChangedPayload(change: IncomingFileChange): FileChangeMeta {
  const { diff: _diff, binary: _binary, ...meta } = change
  return {
    ...meta,
    added: Number.isFinite(meta.added) ? meta.added : 0,
    removed: Number.isFinite(meta.removed) ? meta.removed : 0,
    size: Number.isFinite(meta.size) ? meta.size : 0,
    diffWithheld: shouldWithholdDiffBody(meta.path),
  }
}

/** Reads persisted metadata back off a stored event, tolerating older payloads. */
export function fileChangeFromPayload(payload: Record<string, unknown>): FileChangeMeta | undefined {
  const path = typeof payload['path'] === 'string' ? payload['path'] : undefined
  if (path === undefined) return undefined
  const op = payload['op']
  return {
    path,
    op: op === 'create' || op === 'write' || op === 'delete' ? op : 'write',
    originNode: typeof payload['originNode'] === 'string' ? payload['originNode'] : 'unknown',
    oldSha: typeof payload['oldSha'] === 'string' ? payload['oldSha'] : '',
    newSha: typeof payload['newSha'] === 'string' ? payload['newSha'] : '',
    added: Number(payload['added'] ?? 0),
    removed: Number(payload['removed'] ?? 0),
    size: Number(payload['size'] ?? 0),
    diffWithheld: payload['diffWithheld'] === true,
  }
}

/**
 * The one-line feed entry. A withheld path reports the change and the reason it
 * cannot be shown, which is more useful than silence: the reader knows work
 * happened and that the file is worth asking about.
 */
export function describeFileChange(meta: FileChangeMeta): string {
  const counts = meta.op === 'delete' ? `−${meta.removed}` : `+${meta.added} −${meta.removed}`
  const source = meta.diffWithheld ? ` ${WITHHELD_NOTICE}` : ''
  return `${meta.op.padEnd(6)} ${meta.path} ${counts}  ${meta.originNode}${source}`
}

/**
 * Renders the live body for a change, or the withheld notice. Accepts the
 * untrusted sidecar input so that the withholding rule is applied at the last
 * moment before display, not trusted from an earlier decision.
 */
export function renderFileChangeBody(change: IncomingFileChange): string {
  if (shouldWithholdDiffBody(change.path)) return WITHHELD_NOTICE
  const body = change.diff ?? ''
  if (body === '') {
    return change.binary ? 'binary content changed' : 'no textual change'
  }
  return renderUnifiedDiff(parseUnifiedDiff(change.path, body))
}