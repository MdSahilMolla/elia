import { expect, test } from 'bun:test'
import { describeObservation, parseAction } from './protocol.ts'

test('ARC observations retain all frames and exact row coordinates without game metadata', () => {
  const text = describeObservation({ game_id: 'fixture', state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2,
    available_actions: [1, 6], frame: [[[0, 15], [0, 15], [2, 3]], [[1, 2]]] })
  expect(text).toContain('y=0..1: 0F')
  expect(text).toContain('y=2: 23')
  expect(text).toContain('Frame 1 (2x1):\ny=0: 12')
  expect(text).not.toContain('fixture')
})

test('ARC action validation rejects unavailable actions and malformed click coordinates', () => {
  expect(parseAction({ action: 'ACTION6', x: 0, y: 63 }, [6])).toEqual({ action: 'ACTION6', data: { x: 0, y: 63 } })
  expect(() => parseAction({ action: 'ACTION3' }, [1])).toThrow()
  expect(() => parseAction({ action: 'ACTION6', x: 0.5, y: 2 }, [6])).toThrow()
  expect(() => parseAction({ action: 'ACTION6', x: 64, y: 2 }, [6])).toThrow()
  expect(() => parseAction({ action: 'ACTION6', x: '2', y: 2 }, [6])).toThrow()
  expect(() => parseAction({ action: 'shell' }, [1])).toThrow()
  expect(parseAction({ action: 'RESET' }, [])).toEqual({ action: 'RESET', data: {} })
})
