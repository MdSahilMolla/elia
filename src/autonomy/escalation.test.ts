import { expect, test } from 'bun:test'
import { classifyEscalation } from './escalation.ts'

const escalates = [
  'create an end to end smart attendance tracking system',
  'build me a full-stack app for tracking gym memberships with auth and payments',
  'implement a REST API service for a todo app with a Postgres database and JWT auth',
  'scaffold a Next.js dashboard from scratch with charts and an admin panel',
  'I want a marketplace platform where sellers list items and buyers check out with Stripe',
  // "site" words don't get a free pass once there's a real feature set behind them.
  'build a portfolio website from scratch with a CMS backend, auth, and a contact-form API',
]

const stays = [
  'fix the failing test in src/agentLoop.test.ts',
  'add a --json flag to the export command and update the help text',
  'why does the autonomy governor block shell composition?',
  'rename resolveEliadPath to resolveDaemonPath everywhere',
  'refactor store.ts to pull the flush logic into its own function',
  'update the README install section',
  'can you build this?',
  'the scaffold is broken',
  // A static one-pager is a fast-path job, not a plan→scaffold→verify run.
  'create a static website for nikhil sharma a guy who is studying datascience and run it',
  'build me a portfolio site to show my projects',
  'make a personal landing page with my bio and links',
  'create a simple resume page for a frontend developer',
]

test('large project builds escalate', () => {
  for (const t of escalates) {
    const d = classifyEscalation(t)
    expect(d.escalate, `should escalate: ${t}`).toBe(true)
    expect(d.reason.length).toBeGreaterThan(0)
  }
})

test('targeted changes and questions stay on the fast path', () => {
  for (const t of stays) {
    expect(classifyEscalation(t).escalate, `should not escalate: ${t}`).toBe(false)
  }
})

test('short input never escalates', () => {
  expect(classifyEscalation('build an app').escalate).toBe(false)
})
