export type BridgeMethod =
  | 'chat.send'
  | 'autonomous.start'
  | 'autonomous.approve'
  | 'autonomous.control'
  | 'tasks.list'
  | 'task.control'
  | 'runs.list'
  | 'runs.inspect'
  | 'skills.list'
  | 'git.diff'
  | 'environment.inspect'
  | 'deployment.run'
  | 'shutdown'

export interface BridgeRequest {
  id: string
  method: BridgeMethod
  params?: Record<string, unknown>
}

export interface BridgeResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface BridgeEvent {
  type: 'event'
  event: string
  data?: Record<string, unknown>
}

export type BridgeMessage = BridgeResponse | BridgeEvent

export interface BridgeToolEvent {
  name: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  durationMs: number
  cached: boolean
  assessment?: Record<string, unknown>
  actionId?: string
  idempotencyKey?: string
  replayed?: boolean
  failureClass?: string
}

export interface BridgeChatResult {
  sessionId: string
  text: string
  usage: unknown
  steps: number
  stopReason: string
}

export interface BridgeAutonomousResult {
  runId: string
  taskSessionId?: string
  outcome: string
  proposal?: unknown
  verdict?: unknown
  completion: unknown
  usage: unknown
  elapsedMs: number
  lessons: string[]
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const request = value as Partial<BridgeRequest>
  return typeof request.id === 'string' && request.id.length > 0 && typeof request.method === 'string'
}

export function encodeBridgeMessage(message: BridgeMessage): string {
  return `${JSON.stringify(message)}\n`
}
