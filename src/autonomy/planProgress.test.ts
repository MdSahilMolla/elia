import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createTodoList, type TodoItem } from './todoList.ts'
import {
  STALE_PLAN_ACTIONS,
  beginPlanRequest,
  commandTokens,
  createPlanProgressTracker,
  planBelongsToRequest,
  planChecklist,
  planIsCurrent,
  planProgressTitle,
  proofLabel,
  stepAnchors,
  type ToolOutcome,
} from './planProgress.ts'

const ROOT = resolve('/repo')
const ok = (command: string, cwd?: string): ToolOutcome => ({ name: 'run_command', input: { command, ...(cwd ? { cwd } : {}) }, result: 'exit code: 0\nstdout: fine', isError: false })
const failed = (command: string): ToolOutcome => ({ name: 'run_command', input: { command }, result: 'Action postcondition failed: command did not return exit code 0 (exit code 1)', isError: true })
const wrote = (path: string): ToolOutcome => ({ name: 'write_file', input: { path, content: 'x' }, result: `Created ${path} (+1 −0)`, isError: false })
const read = (path: string): ToolOutcome => ({ name: 'read_file', input: { path }, result: '1 x', isError: false })
const previewed: ToolOutcome = { name: 'preview', input: { path: 'site/index.html' }, result: 'Opened http://127.0.0.1:5000/index.html in Chrome\nServing /repo/site/dist/index.html', isError: false }
const todoWrite = (items: TodoItem[]): ToolOutcome => ({ name: 'todo_write', input: { items }, result: '', isError: false })

const kinds = (step: string): string[] => stepAnchors(step).map((anchor) => `${anchor.kind}:${anchor.key}`)

function planOf(...steps: string[]) {
  const list = createTodoList()
  beginPlanRequest(list)
  list.write(steps.map((content, index) => ({ content, status: index === 0 ? 'in_progress' : 'pending' })))
  const tracker = createPlanProgressTracker({ list: () => list, root: ROOT, owned: () => planBelongsToRequest(list) })
  const status = () => list.read().map((item) => item.status[0]).join('')
  return { list, tracker, status }
}

test('a step names the concrete things that prove it: files, commands, components, packages, folders, the page', () => {
  expect(kinds('Create a static data file (`src/data/competitions.ts`) with placeholder entries.')).toEqual(['file:src/data/competitions.ts'])
  expect(kinds('Run `bun install` and `bun run build` to verify the project builds.')).toEqual(['command:install', 'command:run build'])
  expect(kinds('Create core components: `DestinationCard`, `ItineraryBuilder`, and `MapViewer`.')).toEqual(['component:destinationcard', 'component:itinerarybuilder', 'component:mapviewer'])
  expect(kinds('Install necessary dependencies including `leaflet` for mapping and `lucide-react` for icons.')).toEqual(['package:leaflet', 'package:lucide-react'])
  expect(kinds('Initialize a Node.js/Express backend in a `server` subfolder.')).toContain('dir:server')
  expect(kinds('Preview the site locally to ensure the UI renders correctly.')).toEqual(['preview:preview'])
  expect(kinds('Run `bun run dev` to verify the site loads in the browser.')).toEqual(['serve:run dev'])
})

test('a check asked for in plain words is a check, but only under a verb that runs it', () => {
  expect(kinds('Run typecheck to ensure no TypeScript errors')).toEqual(['check:typecheck'])
  expect(kinds('Verify build compiles successfully')).toEqual(['check:build'])
  expect(kinds('Install dependencies and build project')).toEqual(['check:build', 'check:install'])
  expect(kinds('Run tests to verify fixes')).toEqual(['check:test'])
  expect(kinds('Run TypeScript typecheck to verify code compiles')).toEqual(['check:typecheck'])
  expect(kinds('Fix any build issues found')).toEqual([])
  expect(kinds('Document type error with the author mapping')).toEqual([])
  expect(kinds('Add edge-case tests for the parser')).toEqual([])
  expect(kinds('Build homepage with hero, stats, featured attractions')).toEqual([])
})

test('prose that names nothing concrete gives elia nothing to tick', () => {
  expect(kinds('Add responsive styling using CSS modules or Tailwind if preferred, ensuring mobile compatibility.')).toEqual([])
  expect(kinds('Implement the main page layout to display the list of competitions.')).toEqual([])
  // Libraries are not files, and describing the browser is not asking for it.
  expect(kinds('Add a 3D chart to the dashboard with Three.js and Chart.js')).toEqual([])
  expect(kinds('Create a `README.md` explaining how to run the site (open in browser).')).toEqual(['file:readme.md'])
})

test('the same command under different runners, versions, and spellings is the same command', () => {
  expect(commandTokens('npm run build')).toEqual(commandTokens('bun run build'))
  expect(commandTokens('npm create vite@latest travel-planner -- --template react-ts').slice(0, 2)).toEqual(['create', 'vite'])
  expect(commandTokens('python -m pytest -q')).toEqual(['pytest'])
  expect(commandTokens('npm i')).toEqual(['install'])
})

test('writing the files a step names ticks it, moves the plan on, and tells the model', () => {
  const { list, tracker, status } = planOf('Create `src/data.ts` with sample data', 'Create `Header` and `Footer` components', 'Run `bun run build`')
  const first = tracker.observe([wrote('app/src/data.ts')])
  expect(status()).toBe('cip')
  expect(first.update?.ticked).toEqual(['Create `src/data.ts` with sample data'])
  expect(first.note).toContain('✓ 1. Create `src/data.ts` with sample data')
  expect(first.note).toContain('Now in progress: 2.')
  // A step is done when everything it names is done, not the first of them.
  expect(tracker.observe([wrote('app/src/components/Header.tsx')]).update).toBeUndefined()
  expect(status()).toBe('cip')
  tracker.observe([wrote('app/src/components/Footer.tsx')])
  expect(status()).toBe('cci')
  tracker.observe([ok('npm run build', 'app')])
  expect(status()).toBe('ccc')
  expect(list.read().every((item) => item.status === 'completed')).toBe(true)
})

test('only a command that exited 0 proves anything, and only the part its exit code vouches for', () => {
  const { tracker, status } = planOf('Run `bun test` to verify', 'Run `bun run build`')
  tracker.observe([failed('bun test')])
  tracker.observe([ok('bun test | tail -20')])
  tracker.observe([ok('bun test || true')])
  expect(status()).toBe('ip')
  tracker.observe([ok('bun install && bun test')])
  expect(status()).toBe('ci')
})

test('a timed-out command and a preview whose build failed prove nothing', () => {
  const { tracker, status } = planOf('Run `bun run build`', 'Preview the site in the browser')
  tracker.observe([{ name: 'run_command', input: { command: 'bun run build' }, result: 'timed out after 60000ms (killed)', isError: false }])
  tracker.observe([{ name: 'preview', input: { path: 'site' }, result: 'Build failed — nothing to preview yet.\n$ bun run build\nerror', isError: false }])
  expect(status()).toBe('ip')
  tracker.observe([previewed])
  expect(status()).toBe('ic')
})

test('one piece of evidence ticks one step: a baseline test run does not tick the final one', () => {
  const { tracker, status } = planOf('Run `bun test` to confirm the baseline', 'Edit `src/a.ts` to add the feature', 'Run `bun test` again to verify')
  tracker.observe([ok('bun test')])
  expect(status()).toBe('cip')
  tracker.observe([wrote('src/a.ts')])
  expect(status()).toBe('cci')
  tracker.observe([ok('bun test')])
  expect(status()).toBe('ccc')
})

test('a step that names nothing is left for the model, and the in-progress marker sits on it', () => {
  const { tracker, status } = planOf('Create `index.html`', 'Add responsive styling', 'Preview the page')
  tracker.observe([wrote('site/index.html')])
  expect(status()).toBe('cip')
  tracker.observe([previewed])
  expect(status()).toBe('cic')
})

test('a plan left unchanged through real work draws a reminder, backing off, at most three times', () => {
  const { tracker } = planOf('Add responsive styling', 'Polish the copy')
  const nudges: number[] = []
  for (let i = 1; i <= STALE_PLAN_ACTIONS * 8; i += 1) {
    const result = tracker.observe([{ name: 'edit_file', input: { path: `src/f${i}.css` }, result: 'Edited', isError: false }])
    if (result.nudge) nudges.push(i)
  }
  expect(nudges).toEqual([STALE_PLAN_ACTIONS, STALE_PLAN_ACTIONS * 3, STALE_PLAN_ACTIONS * 7])
  // Reads do not count: they move no step forward.
  const quiet = planOf('Add responsive styling').tracker
  for (let i = 0; i < STALE_PLAN_ACTIONS * 3; i += 1) expect(quiet.observe([read(`src/f${i}.ts`)]).nudge).toBeUndefined()
})

test('the reminder names what is still open and tells the model it may carry on', () => {
  const { tracker } = planOf('Add responsive styling', 'Polish the copy')
  let nudge: string | undefined
  for (let i = 0; i < STALE_PLAN_ACTIONS && !nudge; i += 1) nudge = tracker.observe([wrote(`src/f${i}.css`)]).nudge
  expect(nudge).toContain('◐ 1. Add responsive styling')
  expect(nudge).toContain('□ 2. Polish the copy')
  expect(nudge).toContain('call todo_write')
  expect(nudge).toContain('If you are still on step 1, carry on')
})

test('a todo_write resets the reminder clock', () => {
  const { list, tracker } = planOf('Add responsive styling', 'Polish the copy')
  for (let i = 0; i < STALE_PLAN_ACTIONS - 1; i += 1) tracker.observe([wrote(`src/f${i}.css`)])
  list.write([{ content: 'Add responsive styling', status: 'completed' }, { content: 'Polish the copy', status: 'in_progress' }])
  expect(tracker.observe([todoWrite(list.read()), wrote('src/g.css')]).nudge).toBeUndefined()
})

test('a step the model reopens needs fresh evidence', () => {
  const { list, tracker, status } = planOf('Edit `src/a.ts` to fix the bug', 'Run `bun test`')
  tracker.observe([wrote('src/a.ts')])
  expect(status()).toBe('ci')
  // The model knows better: the fix is wrong. Its write reopens step 1.
  list.write([{ content: 'Edit `src/a.ts` to fix the bug', status: 'in_progress' }, { content: 'Run `bun test`', status: 'pending' }])
  tracker.observe([todoWrite(list.read())])
  expect(status()).toBe('ip')
  tracker.observe([ok('bun test')])
  expect(status()).toBe('ic')
  tracker.observe([wrote('src/a.ts')])
  expect(status()).toBe('cc')
})

test('a step keeps what it names when the model copies it into todo_write without the backticks', () => {
  const { list, tracker, status } = planOf('Create `src/data.ts` with sample data', 'Run `bun run build`')
  list.write([{ content: 'Create src/data.ts with sample data', status: 'in_progress' }, { content: 'Run bun run build', status: 'pending' }])
  tracker.observe([todoWrite(list.read())])
  tracker.observe([ok('bun run build')])
  expect(status()).toBe('ic')
})

test('a plan left over from an earlier request is not ticked or nagged about', () => {
  const list = createTodoList()
  list.write([{ content: 'Create `src/old.ts`', status: 'in_progress' }, { content: 'Tidy up', status: 'pending' }])
  beginPlanRequest(list)
  expect(planBelongsToRequest(list)).toBe(false)
  expect(planIsCurrent(list)).toBe(false)
  const tracker = createPlanProgressTracker({ list: () => list, root: ROOT, owned: () => planBelongsToRequest(list) })
  for (let i = 0; i < STALE_PLAN_ACTIONS * 2; i += 1) expect(tracker.observe([wrote('src/old.ts')])).toEqual({})
  expect(list.read()[0]!.status).toBe('in_progress')
  // Once this request writes its own plan, it is tracked.
  list.write([{ content: 'Create `src/new.ts`', status: 'in_progress' }])
  expect(planBelongsToRequest(list)).toBe(true)
  tracker.observe([todoWrite(list.read()), wrote('src/new.ts')])
  expect(list.read()[0]!.status).toBe('completed')
})

test('without a marked request boundary, any list is the current plan, as elia auto expects', () => {
  const list = createTodoList()
  expect(planIsCurrent(list)).toBe(false)
  list.write([{ content: 'Step', status: 'pending' }])
  expect(planIsCurrent(list)).toBe(true)
})

test('a read step is proven by reading, a run step by running, an existence check by a listing', () => {
  const { tracker, status } = planOf('Read `src/app.ts` to understand the flow', 'Run `seed.py` to load the data', 'Verify `index.html` exists')
  tracker.observe([read('src/app.ts')])
  expect(status()).toBe('cip')
  tracker.observe([wrote('scripts/seed.py')])
  expect(status()).toBe('cip')
  tracker.observe([ok('python scripts/seed.py')])
  expect(status()).toBe('cci')
  tracker.observe([{ name: 'list_files', input: { pattern: '*', cwd: 'site' }, result: 'index.html\nstyle.css', isError: false }])
  expect(status()).toBe('ccc')
})

test('"open `index.html` in the browser" is proven by previewing that page, after its write went to the step that wrote it', () => {
  // The live mercury-2.5 run: one batch wrote everything, then a preview opened it.
  const { tracker, status } = planOf('Write `index.html` with a hero and a menu', 'Open the `index.html` file in the browser to verify the layout')
  tracker.observe([wrote('workspace/coffee-shop/index.html')])
  expect(status()).toBe('ci')
  tracker.observe([{ name: 'preview', input: { path: 'coffee-shop/index.html' }, result: 'Serving http://127.0.0.1:58801/index.html (ELIA_NO_BROWSER_LAUNCH=1, so no window was opened)\nServing workspace\\coffee-shop\\index.html', isError: false }])
  expect(status()).toBe('cc')
})

test('a folder the step creates is proven by a command running in it; one it only mentions needs a file inside', () => {
  const { tracker, status } = planOf('Create a new project folder `workspace/shop` and initialize it', 'Add the API routes in a `server` subfolder')
  tracker.observe([ok('mkdir server', 'workspace/shop')])
  expect(status()).toBe('ci')
  // The routes are not written just because their folder now exists.
  tracker.observe([ok('mkdir server/routes', 'workspace/shop')])
  expect(status()).toBe('ci')
  tracker.observe([wrote('workspace/shop/server/index.ts')])
  expect(status()).toBe('cc')
})

test('the panel checklist and title use the glyphs the plan panel draws', () => {
  const items: TodoItem[] = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]
  expect(planChecklist(items)).toBe('✓ a\n◐ b\n□ c')
  expect(planProgressTitle(items)).toBe('Plan · 1/3 done')
  expect(planProgressTitle(items.map((item) => ({ ...item, status: 'completed' as const })))).toBe('Plan complete · 3/3')
})

test('each tick carries what proved it, in words the plan panel can print', () => {
  const { tracker } = planOf('Create `src/data.ts` with sample data', 'Run `bun test` to verify')
  expect(tracker.observe([wrote('app\\src\\data.ts')]).update?.proofs).toEqual(['wrote data.ts'])
  expect(tracker.observe([ok('bun test')]).update?.proofs).toEqual(['ran bun test'])
  expect(proofLabel(previewed)).toBe('page rendered')
  expect(proofLabel(ok('bun test --coverage --reporter=junit --reporter-outfile=out/report.xml'))).toMatch(/^ran bun test --coverage.{0,40}…$/)
})

// Seen live: the person's note added "Add a dynamic demo section to the
// website" to a chat turn's plan; the work built the demo, and the plan sat at
// 4/6 with every open step a bare □ — nothing was ticked, nothing shown under
// way, and the model was not reminded until six more actions had gone by.
test('a step a note adds that names its file is ticked when that file is written', async () => {
  const { applyEditsToTodos } = await import('./operatorNotes.ts')
  const { list, tracker, status } = planOf('Write `public/css/style.css`', 'Open the preview to verify it')
  tracker.observe([wrote('public/css/style.css')])
  expect(status()).toBe('ci')
  // The note, as the session applies it between two model calls.
  list.write(applyEditsToTodos(list.read(), [{ kind: 'add', title: 'Add the demo section to `public/index.html`', afterTitle: 'Write `public/css/style.css`' }]))
  // Under way at once: the new step, not the one it now stands before.
  expect(status()).toBe('cip')
  const ticked = tracker.observe([wrote('workspace/ds-cyber-roadmap/public/index.html')])
  expect(ticked.update?.ticked).toEqual(['Add the demo section to `public/index.html`'])
  expect(status()).toBe('cci')
})

test('after a note rewrites the plan, the model is reminded to keep it moving after half the usual quiet', async () => {
  const { applyEditsToTodos } = await import('./operatorNotes.ts')
  const { list, tracker } = planOf('Build the page', 'Check it')
  list.write(applyEditsToTodos(list.read(), [{ kind: 'add', title: 'Add a dynamic demo section', afterTitle: 'Build the page' }]))
  const quiet = Math.ceil(STALE_PLAN_ACTIONS / 2)
  let nudge: string | undefined
  let actions = 0
  while (!nudge && actions < STALE_PLAN_ACTIONS) {
    actions += 1
    nudge = tracker.observe([wrote(`src/part${actions}.ts`)]).nudge
  }
  expect(actions).toBe(quiet)
  expect(nudge).toContain('Add a dynamic demo section')
  // The model's own todo_write is not "from outside": no early reminder after it.
  tracker.observe([todoWrite(list.read())])
  let later = 0
  while (later < quiet) {
    later += 1
    expect(tracker.observe([wrote(`src/more${later}.ts`)]).nudge).toBeUndefined()
  }
})
