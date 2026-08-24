import { describe, expect, test } from 'bun:test'
import { encodeBridgeMessage, isBridgeRequest } from './protocol'

describe('VS Code bridge protocol', () => {
  test('accepts a bounded request envelope', () => {
    expect(isBridgeRequest({ id: 'request-1', method: 'tasks.list', params: {} })).toBe(true)
    expect(isBridgeRequest({ id: '', method: 'tasks.list' })).toBe(false)
    expect(isBridgeRequest({ id: 'request-1' })).toBe(false)
    expect(isBridgeRequest(null)).toBe(false)
  })

  test('encodes one JSON object per line', () => {
    const encoded = encodeBridgeMessage({ type: 'event', event: 'bridge_started', data: { version: 1 } })
    expect(encoded).toBe('{"type":"event","event":"bridge_started","data":{"version":1}}\n')
  })
})
