import { expect, test } from 'bun:test'
import { CircuitBreaker } from './circuit.ts'

function fakeClock(): { now(): number; advance(ms: number): void } {
  let time = 0
  return { now: () => time, advance: (ms: number) => { time += ms } }
}

test('three consecutive failures trip the breaker open', () => {
  const breaker = new CircuitBreaker('s', 3, 30_000, fakeClock().now)
  expect(breaker.isOpen()).toBe(false)
  breaker.recordFailure()
  breaker.recordFailure()
  expect(breaker.isOpen()).toBe(false)
  breaker.recordFailure()
  expect(breaker.isOpen()).toBe(true)
})

test('an open breaker stays open until the reset window elapses', () => {
  const clock = fakeClock()
  const breaker = new CircuitBreaker('s', 3, 30_000, clock.now)
  for (let index = 0; index < 3; index++) breaker.recordFailure()
  clock.advance(29_999)
  expect(breaker.isOpen()).toBe(true)
  clock.advance(1)
  expect(breaker.isOpen()).toBe(false)
})

test('a probe failure after the reset window immediately re-opens the breaker', () => {
  const clock = fakeClock()
  const breaker = new CircuitBreaker('s', 3, 30_000, clock.now)
  for (let index = 0; index < 3; index++) breaker.recordFailure()
  clock.advance(30_000)
  expect(breaker.isOpen()).toBe(false)
  breaker.recordFailure()
  expect(breaker.isOpen()).toBe(true)
})

test('interleaved successes keep the circuit closed — only consecutive failures trip it', () => {
  const breaker = new CircuitBreaker('s', 3, 30_000, fakeClock().now)
  breaker.recordFailure()
  breaker.recordSuccess()
  breaker.recordFailure()
  breaker.recordSuccess()
  breaker.recordFailure()
  expect(breaker.isOpen()).toBe(false)
})

test('a success clears the failure count entirely', () => {
  const breaker = new CircuitBreaker('s', 3, 30_000, fakeClock().now)
  breaker.recordFailure()
  breaker.recordFailure()
  breaker.recordSuccess()
  breaker.recordFailure()
  breaker.recordFailure()
  expect(breaker.isOpen()).toBe(false)
})