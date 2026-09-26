// Headless smoke of the live lane — the answer a message gets while elia works.
// The one thing the test suite cannot prove: a REAL provider round-trip, with
// the read-only tools, answering from a mid-turn context. It asks two things in
// the current directory's project: a question that needs a file opened, and a
// direction that must come back with a STEER line.
//
//   bun --env-file=.env run scripts/live-reply-smoke.ts [path/to/a/file/to/ask/about]
//
// Exit 0 = both answered, and only the direction produced a STEER.
// Exit 1 = no usable answer (key, network, provider), or the protocol broke.
import { answerWhileWorking, type LiveContext } from '../src/live/liveReply.ts'

const file = process.argv[2] ?? 'package.json'
const ctx: LiveContext = {
  request: 'fix the failing tests in this project',
  elapsedMs: 35_000,
  status: 'Running the test suite',
  runningTools: ['Running bun test'],
  plan: [
    { content: 'Reproduce the failure', status: 'completed' },
    { content: 'Fix the root cause', status: 'in_progress' },
  ],
  recentTools: [{ name: 'read_file', input: `Reading ${file}`, outcome: '(read)', isError: false }],
  assistantSoFar: 'I have reproduced the failure and am looking at the code now.',
  steering: [],
  conversation: [{ role: 'user', content: [{ type: 'text', text: 'fix the failing tests in this project' }] }],
  exchanges: [],
  cwd: process.cwd(),
}

let ok = true
const started = Date.now()
const question = await answerWhileWorking(ctx, `What does ${file} contain, in one or two sentences? Open it to check.`)
console.log(`— question (${question.model}, ${((Date.now() - started) / 1000).toFixed(1)}s)\n${question.answer}\nsteer: ${question.steer ?? '(none)'}\n`)
if (!question.answer || question.answer === '(no answer)' || question.steer) ok = false

const directedAt = Date.now()
const direction = await answerWhileWorking({ ...ctx, exchanges: [{ question: `what is in ${file}?`, answer: question.answer }] }, 'also add a regression test for this once it is fixed')
console.log(`— direction (${direction.model}, ${((Date.now() - directedAt) / 1000).toFixed(1)}s)\n${direction.answer}\nsteer: ${direction.steer ?? '(none)'}`)
if (!direction.steer) ok = false

console.log(ok ? '\nOK' : '\nFAILED')
process.exit(ok ? 0 : 1)
