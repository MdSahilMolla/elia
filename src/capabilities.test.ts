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
  expect(capability?.outputContract).toContain('artifact or code path for reproduction')
})

test('high-impact capabilities declare high risk', () => {
  expect(capabilityForPersona('cyber')?.risk).toBe('high')
  expect(capabilityForPersona('communications')?.risk).toBe('high')
  expect(capabilityForPersona('automation')?.risk).toBe('high')
  expect(capabilityForPersona('production')?.risk).toBe('high')
})

test('detectCapabilities identifies production delivery work', () => {
  const ids = detectCapabilities('prepare a production deployment with database migrations, observability, and rollback').map((capability) => capability.id)
  expect(ids).toContain('production-delivery')
  expect(capabilityForPersona('production')?.outputContract).toContain('preflight evidence')
})

test('finance and data contracts require traceability and reproducibility', () => {
  expect(capabilityForPersona('finance')?.outputContract).toContain('calculations with traceable inputs')
  expect(capabilityForPersona('data')?.outputContract).toContain('artifact or code path for reproduction')
})

test('AI and research capabilities remain distinct', () => {
  const ids = detectCapabilities('compare LLM inference latency and cite the primary research').map((capability) => capability.id)
  expect(ids).toContain('ai-ml')
  expect(ids).toContain('research')
})
