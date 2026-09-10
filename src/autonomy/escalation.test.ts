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

// Regression: this exact paste — a chat log copied in for context — was
// classified as "building a new project" because the words "build" and "bot"
// appear somewhere in its prose. It became an approved multi-wave run that
// completed zero of its one planned node (2026-09-10-6sl5-x7m6).
const PASTED_CHAT_LOG = "AI Mode conversation: can we scrape digicampus calander class mappingYou said: can we scrape digicampus calendar class mappingcan we scrape digicampus calendar class mappingYes, you can scrape the Digiicampus calendar class mapping, but because the platform is an authenticated, dynamic, single-page application (SPA), a standard HTTP request library like requests won't work on its own. [1] (https://digiicampus.com/academics/), [2] (https://digiicampus.com/learning-management-system/)To bypass their authentication and handle their JavaScript-heavy layout, you have two main approaches:Method 1: The DevTools Network Approach (Easiest & Cleanest)Instead of parsing the visual HTML frontend, you can capture the exact JSON payload the Digiicampus platform requests from its internal API when loading your calendar. [1] (https://digiicampus.com/learning-management-system/)Log in to your Digiicampus portal using Google Chrome or Firefox.Open the Developer Tools (Press F12) and navigate to the Network tab.Filter the network traffic by selecting Fetch/XHR.Refresh the page or click on your Calendar / Timetable view.Look for API requests named something like getCalendarEvents, timetable, class-mapping, or schedule.Right-click the request, select Copy -> Copy as cURL.Paste that cURL command into an online tool like curlconverter to instantly generate a working Python script (using requests) that includes all necessary authorization headers, cookies, and tokens.Method 2: Browser Automation (For Recurring Schedules)If you need to build a bot that runs on a schedule (e.g., pulling a new calendar mapping every Monday), you will need to automate the login session using Selenium or Playwright. [1] (https://www.firecrawl.dev/blog/automated-web-scraping-free-2025), [2] (https://www.scrapinglab."

test('a pasted chat log is context, not a build order', () => {
  const decision = classifyEscalation(PASTED_CHAT_LOG)
  expect(decision.escalate).toBe(false)
  expect(decision.reason).toBe('pasted context, not an instruction')
})

test('a long message that does open with an instruction still escalates', () => {
  const long = `build me an end-to-end inventory system with auth and a dashboard

${'reference material that goes on and on. '.repeat(80)}`
  expect(long.length).toBeGreaterThan(1500)
  expect(classifyEscalation(long).escalate).toBe(true)
})

test('build verbs buried in pasted prose do not escalate', () => {
  const pasted = `${'Here is some documentation about scraping. '.repeat(40)}You could build a bot that runs on a schedule. ${'More prose follows. '.repeat(40)}`
  expect(pasted.length).toBeGreaterThan(1500)
  expect(classifyEscalation(pasted).escalate).toBe(false)
})

test('an interrogative opener without a question mark is still a question', () => {
  expect(classifyEscalation('can you make a website for my portfolio and run it').escalate).toBe(false)
  expect(classifyEscalation('is this repo able to build an end to end system').escalate).toBe(false)
})

test('a normal typed build request is unaffected by the paste guard', () => {
  const decision = classifyEscalation('build me a full-stack app for tracking gym memberships with auth and payments')
  expect(decision.escalate).toBe(true)
})
