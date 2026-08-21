import { expect, test } from 'bun:test'
import { capabilityForPersona, detectCapabilities } from './capabilities.ts'

test('detectCapabilities identifies finance and business analysis together', () => {
  const ids = detectCapabilities('prepare a business case with a budget, pricing, and ROI sensitivity analysis').map((capability) => capability.id)
  expect(ids).toContain('business-analysis')
  expect(ids).toContain('finance')
})

test('detectCapabilities identifies reproducible data work', () => {
  const capability = detectCapabilities('profile this CSV, check missingness, and run a cohort analysis')[0]
  expect(capability?.id).toBe('data-analysis')
  expect(capability?.outputContract).toContain('limitations and reproducibility')
})

test('high-impact capabilities declare high risk', () => {
  expect(capabilityForPersona('cyber')?.risk).toBe('high')
  expect(capabilityForPersona('communications')?.risk).toBe('high')
  expect(capabilityForPersona('automation')?.risk).toBe('high')
})

test('AI and research capabilities remain distinct', () => {
  const ids = detectCapabilities('compare LLM inference latency and cite the primary research').map((capability) => capability.id)
  expect(ids).toContain('ai-ml')
  expect(ids).toContain('research')
})
