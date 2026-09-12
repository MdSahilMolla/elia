import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { battmannTool } from '../tools/battmann.ts'

// Regression coverage for two verified security findings in src/battmann/store.ts:
//  1. objectDetail must not return an ontology-object revision whose validity window has already closed.
//  2. stageDeployment must gate on the actual classification of the report's embedded content, not the
//     self-reported (and possibly understated) documentClassification label.

test('object_detail excludes an ontology-object revision that has expired by asOf', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-expired-revision-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2020-01-01', retrievedAt: '2020-01-01', excerpt: 'Of record.', independenceGroup: 'reg', reliability: 0.9 })
  // A revision that was valid only from Jan through June 2020 — it should not be "current" after that window closes.
  await run({ action: 'upsert_object', objectId: 'temp-entity', objectType: 'organization', name: 'Temporary Entity', validFrom: '2020-01-01', validTo: '2020-06-01', confidence: 'high', evidenceIds: ['e1'] })

  // Within the validity window: the revision is returned normally.
  const within = JSON.parse(await run({ action: 'object_detail', objectId: 'temp-entity', asOf: '2020-03-01' }))
  expect(within.object.name).toBe('Temporary Entity')

  // After validTo: the only revision on record has expired, so this must behave like "no revision found",
  // not silently return the expired revision as current.
  await expect(run({ action: 'object_detail', objectId: 'temp-entity', asOf: '2020-07-01' })).rejects.toThrow('has no revision valid at')

  // With no asOf at all (latest-revision semantics), the object is still reachable.
  const latest = JSON.parse(await run({ action: 'object_detail', objectId: 'temp-entity' }))
  expect(latest.object.name).toBe('Temporary Entity')
})

test('object_detail excludes an expired revision even when an earlier revision would still be active', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-expired-revision-2-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2020-01-01', retrievedAt: '2020-01-01', excerpt: 'Of record.', independenceGroup: 'reg', reliability: 0.9 })
  await run({ action: 'upsert_object', objectId: 'entity', objectType: 'organization', name: 'First Name', validFrom: '2020-01-01', confidence: 'high', evidenceIds: ['e1'] })
  // The latest revision only covers Feb-Mar; asking about April should find no revision in force, not fall back
  // to the still-more-recently-inserted (but expired) revision, and not to the earlier open-ended one either,
  // since objectRevisionAt already correctly picks the most recent row with valid_from <= asOf.
  await run({ action: 'upsert_object', objectId: 'entity', objectType: 'organization', name: 'Second Name', validFrom: '2020-02-01', validTo: '2020-03-01', confidence: 'high', evidenceIds: ['e1'] })
  await expect(run({ action: 'object_detail', objectId: 'entity', asOf: '2020-04-01' })).rejects.toThrow('has no revision valid at')
})

test('stage_deployment gates on the actual classification of embedded evidence, not an understated documentClassification', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-content-classification-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  // A restricted source is embedded in the report via a claim, while the report author (mistakenly or not)
  // leaves documentClassification at its default of 'internal'.
  await run({ action: 'register_evidence', evidenceId: 'sensitive-source', title: 'Restricted intercept', url: 'https://intel.example/r1', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Sensitive material.', independenceGroup: 'sigint', reliability: 0.9, securityClassification: 'restricted' })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'A restricted-source fact.', classification: 'observed_fact', confidence: 'high', asOf: '2026-01-02', evidenceLinks: [{ evidenceId: 'sensitive-source', relation: 'supports', supportingExcerpt: 'Sensitive material.' }] })
  // documentClassification is left unset -> defaults to 'internal', understating the restricted content above.
  const bundle = JSON.parse(await run({ action: 'report_from_store', reportId: 'rep1', reportStatus: 'draft', title: 'Brief', executiveSummary: 'Summary.', author: 'a', asOf: '2026-01-03', outputPath: 'reports/brief.md' }))
  expect(bundle.reportStatus).toBe('draft')

  await run({ action: 'define_deployment_target', targetId: 't-mid', name: 'Mid Clearance Target', kind: 'sovereign-cloud', maxClassification: 'confidential', formats: ['md', 'json'] })
  await run({ action: 'define_deployment_target', targetId: 't-high', name: 'High Clearance Target', kind: 'air-gap-export', maxClassification: 'restricted', formats: ['md', 'json'] })

  // Before the fix, stageDeployment trusted the self-reported documentClassification ('internal') and would have
  // allowed staging restricted content to a target that only clears 'confidential'. It must now block this.
  await expect(run({ action: 'stage_deployment', stageId: 's1', targetId: 't-mid', reportPath: 'reports/brief.md', stagedBy: 'ops' })).rejects.toThrow('accepts at most confidential')

  // A target cleared for the actual (restricted) content succeeds.
  const staged = JSON.parse(await run({ action: 'stage_deployment', stageId: 's2', targetId: 't-high', reportPath: 'reports/brief.md', stagedBy: 'ops' }))
  expect(staged.status).toBe('staged')
  expect(staged.manifest.report.classification).toBe('restricted')
})

test('stage_deployment still honours a documentClassification stricter than the computed content classification', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-content-classification-floor-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  // Only public/internal content is embedded, but the author explicitly marks the document itself confidential
  // (e.g. because the executive summary or title is sensitive even though no embedded record is). The self-reported
  // label may still raise the bar — it must just never lower it.
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Ordinary filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Nothing sensitive.', independenceGroup: 'reg', reliability: 0.9 })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'An ordinary fact.', classification: 'observed_fact', confidence: 'high', asOf: '2026-01-02', evidenceLinks: [{ evidenceId: 'e1', relation: 'supports', supportingExcerpt: 'Nothing sensitive.' }] })
  await run({ action: 'report_from_store', reportId: 'rep1', reportStatus: 'draft', title: 'Brief', executiveSummary: 'Summary.', author: 'a', documentClassification: 'confidential', asOf: '2026-01-03', outputPath: 'reports/brief.md' })
  await run({ action: 'define_deployment_target', targetId: 't-low', name: 'Low Clearance Target', kind: 'sovereign-cloud', maxClassification: 'internal', formats: ['md', 'json'] })
  await expect(run({ action: 'stage_deployment', stageId: 's1', targetId: 't-low', reportPath: 'reports/brief.md', stagedBy: 'ops' })).rejects.toThrow('accepts at most internal')
})

// Regression coverage for a verified correctness finding: the data write and its audit-hash-chain entry run as
// two separate transactions (see the comment above MUTATING_STORE_ACTIONS in store.ts), so a crash between them
// leaves an undetectable gap. Since a true single-transaction fix would require threading a shared, externally
// owned connection through every one of the ~20 self-contained mutating handlers (each opens/commits/closes its
// own), the mitigation is a reconciliation check (`reconcileAuditGaps`) that `audit_trail` now runs on every
// call, so the gap becomes "detected and reported" instead of "silently undetectable."
test('audit_trail reports no gaps for a normal write, and detects one once simulated', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-audit-gap-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'create_question', questionId: 'q1', question: 'Will X happen?', resolutionCriteria: 'X occurs by the horizon.', openedAt: '2025-01-01', horizon: '2030-01-01' })

  const clean = JSON.parse(await run({ action: 'audit_trail' }))
  expect(clean.auditGaps).toEqual([])

  // Simulate the crash-between-transactions failure mode directly: delete the audit_log entry for q1's write,
  // leaving the `questions` row in place with no corresponding audit entry — exactly the gap a mid-write crash
  // would leave, since the data-write transaction (already committed) is never rolled back for an audit failure.
  const db = new Database(join(cwd, '.elia', 'battmann.sqlite'))
  db.exec("DELETE FROM audit_log WHERE target = 'q1'")
  db.close()

  const gapped = JSON.parse(await run({ action: 'audit_trail' }))
  expect(gapped.auditGaps).toEqual([{ table: 'questions', missing: 1, sampleIds: ['q1'] }])
})
