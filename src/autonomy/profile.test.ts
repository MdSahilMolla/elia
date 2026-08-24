import { describe, expect, test } from 'bun:test'
import { autonomyProfileDefaults } from './loop.ts'

describe('autonomy profiles', () => {
  test('fast profile is bounded for simple tasks', () => {
    const profile = autonomyProfileDefaults('fast')
    expect(profile.maxRepairAttempts).toBe(1)
    expect(profile.maxAmendments).toBe(1)
    expect(profile.polish).toBe(false)
    expect(profile.reviewerCount).toBe(1)
    expect(profile.learn).toBe(false)
    expect(profile.plannerSteps).toBeLessThan(40)
  })

  test('balanced remains the default-quality workflow', () => {
    const profile = autonomyProfileDefaults('balanced')
    expect(profile.polish).toBe(true)
    expect(profile.reviewerCount).toBe(3)
    expect(profile.learn).toBe(true)
  })

  test('thorough adds bounded depth rather than unbounded loops', () => {
    const profile = autonomyProfileDefaults('thorough')
    expect(profile.maxRepairAttempts).toBeGreaterThan(autonomyProfileDefaults('balanced').maxRepairAttempts)
    expect(profile.maxPolishPasses).toBeLessThanOrEqual(3)
    expect(profile.plannerSteps).toBeLessThanOrEqual(50)
  })
})
