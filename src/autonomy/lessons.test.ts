import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// lessons.ts reads paths from config.ts, which resolves a provider on import.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-lessons-test'

const { appendLessons, loadLessons, renderLessons, renderLessonsWithKeys, retireLessons } = await import('./lessons.ts')
const { recordLessonExposure, MIN_EXPOSURES } = await import('./lessonEfficacy.ts')

/** A minimal TurnOutcome line, written directly so outcomes.jsonl doesn't need a live recordOutcome import. */
function appendTurn(outcomesPath: string, corr: string, clean: boolean): void {
  appendFileSync(
    outcomesPath,
    `${JSON.stringify({
      at: Date.now(),
      corr,
      prompt: 'x',
      filesChanged: 1,
      domains: ['code'],
      editRetries: clean ? 0 : 1,
      toolErrors: 0,
      verify: clean ? 'pass' : 'fail',
      repairAttempts: 0,
      aborted: false,
    })}\n`,
  )
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-lessons-'))
  path = join(dir, 'lessons.md')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('lessons round-trip through the file', () => {
  appendLessons(['tests need bun, not node', 'src/generated is generated — do not edit'], path)

  expect(loadLessons(path).map((lesson) => lesson.text)).toEqual([
    'tests need bun, not node',
    'src/generated is generated — do not edit',
  ])
})

test('a lesson whose text mentions an HTML comment keeps its text and its timestamp', () => {
  const before = Date.now()
  appendLessons([{ text: 'strip <!-- generated --> banners before diffing; a lone <!-- also appears in templates', source: 'critic', confidence: 0.8 }], path)
  const [lesson] = loadLessons(path)
  expect(lesson?.text).toBe('strip <!-- generated --> banners before diffing; a lone <!-- also appears in templates')
  expect(lesson?.at).toBeGreaterThanOrEqual(before - 1000)
  expect(lesson?.source).toBe('critic')
  expect(lesson?.confidence).toBe(0.8)
})

test('loadLessons attaches a stable key derived from the text', () => {
  appendLessons(['tests need bun, not node'], path)
  const key1 = loadLessons(path)[0]?.key
  expect(key1).toBeTruthy()
  // whitespace / case differences do not change the key
  appendLessons(['  TESTS   need BUN, not node  '], join(dir, 'other.md'))
  expect(loadLessons(join(dir, 'other.md'))[0]?.key).toBe(key1!)
})

test('renderLessonsWithKeys exposes the injected keys and text for the recorder', () => {
  appendLessons(['a', 'b'], path)
  const rendered = renderLessonsWithKeys('', path)
  expect(rendered.keys).toHaveLength(2)
  expect(rendered.text).toContain('- a')
})

test('retireLessons drops a lesson with enough exposures and a confidently negative lift, keeps one with lift', () => {
  appendLessons(['helpful lesson', 'dead weight lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const [helpful, dead] = loadLessons(path).map((l) => l.key!)

  // Control group: turns that never saw either lesson, overwhelmingly clean —
  // this is the baseline both lessons are judged against.
  for (let i = 0; i < 20; i += 1) appendTurn(outcomesPath, `ctrl-${i}`, true)

  // "helpful" runs clean every time (matches the control rate — no negative lift).
  for (let i = 0; i < MIN_EXPOSURES; i += 1) recordLessonExposure(`run-h-${i}`, [helpful!], { verify: 'pass', clean: true }, efficacyPath)
  // "dead" never runs clean (confidently below the control rate).
  for (let i = 0; i < MIN_EXPOSURES; i += 1) recordLessonExposure(`run-d-${i}`, [dead!], { verify: 'pass', clean: false }, efficacyPath)

  const result = retireLessons({ lessonsPath: path, efficacyPath, outcomesPath })
  expect(result.retired).toEqual(['dead weight lesson'])
  expect(loadLessons(path).map((l) => l.text)).toEqual(['helpful lesson'])
})

test('retireLessons excludes turns exposed to the lesson from the baseline instead of contaminating it', () => {
  // Regression test for the biased-baseline bug: a lesson injected into nearly
  // every briefing used to be judged against a project-wide clean rate that
  // was itself mostly made of runs that HAD the lesson, biasing lift toward
  // zero and hiding a genuinely bad lesson. Here the exposed turns are also
  // recorded (under the same corr) in outcomes.jsonl — if the baseline were
  // still contaminated by them, the project-wide rate would be dragged down
  // close to the lesson's own poor rate and this lesson would survive.
  // Two never-evaluated filler lessons keep "bad lesson" under the retirement
  // ceiling (`retireLessons` refuses to remove more than 60% of the file at
  // once — retiring 1-of-1 would hit that guard regardless of the math below).
  appendLessons(['filler one', 'filler two', 'bad lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const key = loadLessons(path).find((l) => l.text === 'bad lesson')!.key!

  for (let i = 0; i < 20; i += 1) appendTurn(outcomesPath, `ctrl-${i}`, true) // true, unexposed control group

  for (let i = 0; i < MIN_EXPOSURES; i += 1) {
    const corr = `exp-${i}`
    const clean = i < 2 // mostly unclean while exposed
    recordLessonExposure(corr, [key], { verify: clean ? 'pass' : 'fail', clean }, efficacyPath)
    appendTurn(outcomesPath, corr, clean)
  }

  const result = retireLessons({ lessonsPath: path, efficacyPath, outcomesPath })
  expect(result.retired).toEqual(['bad lesson'])
})

test('retireLessons is a no-op below the minimum exposure count', () => {
  appendLessons(['unproven lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const key = loadLessons(path)[0]!.key!
  recordLessonExposure('run-1', [key], { verify: 'fail', clean: false }, efficacyPath)
  expect(retireLessons({ lessonsPath: path, efficacyPath, outcomesPath }).retired).toEqual([])
  expect(loadLessons(path)).toHaveLength(1)
})

test('retireLessons is a no-op when there is not yet enough of a control group to trust', () => {
  appendLessons(['unproven lesson'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const key = loadLessons(path)[0]!.key!
  for (let i = 0; i < MIN_EXPOSURES; i += 1) recordLessonExposure(`run-${i}`, [key], { verify: 'fail', clean: false }, efficacyPath)
  // Only a couple of unexposed turns recorded — nowhere near MIN_CONTROL_SAMPLE.
  appendTurn(outcomesPath, 'ctrl-0', true)
  appendTurn(outcomesPath, 'ctrl-1', true)
  expect(retireLessons({ lessonsPath: path, efficacyPath, outcomesPath }).retired).toEqual([])
  expect(loadLessons(path)).toHaveLength(1)
})

test('retireLessons never removes more than the shrink ceiling in one pass', () => {
  appendLessons(['l1', 'l2', 'l3'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  for (let i = 0; i < 20; i += 1) appendTurn(outcomesPath, `ctrl-${i}`, true)
  for (const lesson of loadLessons(path)) {
    for (let i = 0; i < MIN_EXPOSURES; i += 1) recordLessonExposure(`r-${lesson.key}-${i}`, [lesson.key!], { verify: 'fail', clean: false }, efficacyPath)
  }
  // all three are dead weight, but that is 100% of the file — refuse.
  const result = retireLessons({ lessonsPath: path, efficacyPath, outcomesPath })
  expect(result.retired).toEqual([])
  expect(result.skippedReason).toContain('ceiling')
  expect(loadLessons(path)).toHaveLength(3)
})

test('the file gets a header the first time and not again', () => {
  appendLessons(['first'], path)
  appendLessons(['second'], path)

  const content = Bun.file(path)
  expect(loadLessons(path).length).toBe(2)
  return content.text().then((text) => {
    expect(text.match(/# Lessons/g)?.length).toBe(1)
  })
})

test('a repeated lesson is not stored twice', () => {
  appendLessons(['tests need bun'], path)
  appendLessons(['tests need bun'], path)

  expect(loadLessons(path).length).toBe(1)
})

test('duplicate detection ignores case', () => {
  appendLessons(['Tests Need Bun'], path)
  appendLessons(['tests need bun'], path)

  expect(loadLessons(path).length).toBe(1)
})

test('newlines are flattened, so one lesson stays one line', () => {
  appendLessons(['a lesson\nspanning\nlines'], path)

  expect(loadLessons(path)[0]!.text).toBe('a lesson spanning lines')
})

test('empty and whitespace-only lessons are dropped', () => {
  appendLessons(['   ', '', 'real one'], path)

  expect(loadLessons(path).map((lesson) => lesson.text)).toEqual(['real one'])
})

test('an empty list writes nothing at all', () => {
  appendLessons([], path)

  expect(loadLessons(path)).toEqual([])
  expect(renderLessons('', path)).toBe('')
})

test('a missing file loads as no lessons rather than throwing', () => {
  expect(loadLessons(join(dir, 'never-written.md'))).toEqual([])
})

test('the timestamp comment is stripped from the lesson text but recorded', () => {
  appendLessons(['a timed lesson'], path)

  const lesson = loadLessons(path)[0]!
  expect(lesson.text).toBe('a timed lesson')
  expect(lesson.at).toBeGreaterThan(0)
})

test('rendering produces a prompt section only when there is something to say', () => {
  expect(renderLessons('', path)).toBe('')

  appendLessons(['the build needs --target=node'], path)
  const rendered = renderLessons('', path)

  expect(rendered).toContain('What earlier runs learned')
  expect(rendered).toContain('the build needs --target=node')
})

test('lessons keep optional source and confidence provenance', () => {
  appendLessons([{ text: 'use bun test', source: 'repair', confidence: 0.9 }], path)
  const lesson = loadLessons(path)[0]!
  expect(lesson.text).toBe('use bun test')
  expect(lesson.source).toBe('repair')
  expect(lesson.confidence).toBeCloseTo(0.9)
  expect(renderLessons('', path)).toContain('source: repair')
})

// --- Relevance ranking, on top of an unconditional recency floor -------------

/** `count` lessons whose text is distinct and searchable. */
function seed(path: string, count: number, prefix: string): void {
  for (let i = 0; i < count; i += 1) appendLessons([`${prefix} number ${i} about topic${i}`], path)
}

test('below the injection ceiling every lesson still goes in, query or not', () => {
  const path = join(dir, 'lessons.md')
  seed(path, 5, 'small store lesson')
  expect(renderLessonsWithKeys('topic3', path).keys).toHaveLength(5)
})

test('relevant older lessons are injected without force-filling the rest of the budget', () => {
  const path = join(dir, 'lessons.md')
  // The needle is the oldest entry, far outside the newest-25 window.
  appendLessons(['On this project the rust crate must be built with the gnullvm toolchain'], path)
  seed(path, 40, 'unrelated filler lesson')

  const rendered = renderLessonsWithKeys('the rust crate will not build', path)
  expect(rendered.text).toContain('gnullvm')
  // The needle takes one relevance slot above the unconditional recency floor;
  // the rest of the budget is left empty rather than padded with old unrelated
  // fillers, so the turn is not saturated with semi-relevant memory.
  expect(rendered.keys).toHaveLength(RECENCY_FLOOR + 1)
}, 30_000)

test('an old but relevant lesson is injected where pure recency would have dropped it', () => {
  const path = join(dir, 'lessons.md')
  // The needle is the oldest entry, far outside the newest-25 window.
  appendLessons(['On this project the rust crate must be built with the gnullvm toolchain'], path)
  seed(path, 40, 'unrelated filler lesson')

  const withoutQuery = renderLessonsWithKeys('', path).text
  expect(withoutQuery).not.toContain('gnullvm')

  const withQuery = renderLessonsWithKeys('the rust crate will not build', path).text
  expect(withQuery).toContain('gnullvm')
}, 30_000)

test('the newest lessons are injected unconditionally, however irrelevant to the query', () => {
  const path = join(dir, 'lessons.md')
  seed(path, 40, 'older filler lesson')
  appendLessons(['The most recent lesson, about something else entirely'], path)
  // Efficacy baselines already on disk depend on the newest slice being exposed
  // every run; relevance must not be able to displace it.
  const rendered = renderLessonsWithKeys('a totally unrelated query about kubernetes', path).text
  expect(rendered).toContain('The most recent lesson')
}, 30_000)

test('the injection budget is undersubscribed, not force-filled, when a query matches nothing', () => {
  const path = join(dir, 'lessons.md')
  seed(path, 40, 'filler lesson')
  const keys = renderLessonsWithKeys('zzzzz nothing matches this zzzzz', path).keys
  // No lesson shares a token with the query, so only the unconditional newest
  // slice is injected — the budget used to be padded to a full 25 regardless.
  expect(keys).toHaveLength(RECENCY_FLOOR)
}, 30_000)

// --- Machine facts go to the global store, and come back everywhere ----------

test('an environment lesson is written globally and a project lesson locally', () => {
  const path = join(dir, 'lessons.md')
  const globalPath = join(dir, 'global-lessons.md')
  appendLessons(
    ['On Windows, list directories with dir; ls is not a command here', 'Run bun test before pushing this project'],
    path,
    globalPath,
  )
  expect(loadLessons(path).map((l) => l.text)).toEqual(['Run bun test before pushing this project'])
  expect(loadLessons(globalPath).map((l) => l.text)).toEqual(['On Windows, list directories with dir; ls is not a command here'])
})

test('global lessons are injected alongside the project’s own', () => {
  const path = join(dir, 'lessons.md')
  const globalPath = join(dir, 'global-lessons.md')
  appendLessons(['Run bun test before pushing this project'], path, globalPath)
  appendLessons(['On Windows, list directories with dir; ls is not a command here'], path, globalPath)

  const rendered = renderLessonsWithKeys('', path, globalPath)
  expect(rendered.text).toContain('list directories with dir')
  expect(rendered.text).toContain('Run bun test before pushing')
  // Both are recorded as exposed, so efficacy tracking sees what the turn saw.
  expect(rendered.keys).toHaveLength(2)
})

test('global lessons cannot crowd out the project’s own', () => {
  const path = join(dir, 'lessons.md')
  const globalPath = join(dir, 'global-lessons.md')
  for (let i = 0; i < 30; i += 1) appendLessons([`On Windows, machine fact number ${i} about the shell`], path, globalPath)
  for (let i = 0; i < 20; i += 1) appendLessons([`Project fact number ${i} about running the suite`], path, globalPath)

  const rendered = renderLessonsWithKeys('', path, globalPath)
  const globalLines = rendered.text.split('\n').filter((line) => line.includes('machine fact number')).length
  expect(loadLessons(globalPath).length).toBe(30)
  expect(globalLines).toBe(5)
  expect(rendered.text).toContain('Project fact number 19')
}, 30_000)

test('a caller passing only a path keeps everything in that one file', () => {
  // Every existing caller and test does this; none of them may reach the
  // operator's real home directory by omission.
  const path = join(dir, 'lessons.md')
  appendLessons(['On Windows, list directories with dir; ls is not a command here'], path)
  expect(loadLessons(path).map((l) => l.text)).toEqual(['On Windows, list directories with dir; ls is not a command here'])
})

const { lessonHoldoutRate, DEFAULT_LESSON_HOLDOUT_RATE, RECENCY_FLOOR } = await import('./lessons.ts')

test('renderLessonsWithKeys withholds project lessons by coin flip and returns the withheld keys', () => {
  appendLessons(['first', 'second', 'third'], path)
  const flips = [0.9, 0.1, 0.9] // only the second draw falls under the rate
  const rendered = renderLessonsWithKeys('', path, undefined, { rate: 0.15, random: () => flips.shift()! })
  const [first, second, third] = loadLessons(path).map((l) => l.key!)
  expect(rendered.keys).toEqual([first!, third!])
  expect(rendered.heldOut).toEqual([second!])
  expect(rendered.text).not.toContain('- second')
})

test('machine-level lessons are never withheld', () => {
  const globalPath = join(dir, 'global.md')
  appendLessons(['project fact'], path)
  appendLessons(['quote paths with single quotes on this machine'], globalPath)
  const rendered = renderLessonsWithKeys('', path, globalPath, { rate: 0.5, random: () => 0 })
  expect(rendered.text).toContain('quote paths with single quotes')
  expect(rendered.text).not.toContain('project fact')
  expect(rendered.heldOut).toHaveLength(1)
})

test('a test path never gets holdout unless it asks for it, and says holdout was off', () => {
  appendLessons(['a', 'b', 'c', 'd'], path)
  expect(renderLessonsWithKeys('', path).heldOut).toBeUndefined()
})

test('lessonHoldoutRate reads ELIA_LESSON_HOLDOUT, turns off at 0, and caps at 0.5', () => {
  expect(lessonHoldoutRate({})).toBe(DEFAULT_LESSON_HOLDOUT_RATE)
  expect(lessonHoldoutRate({ ELIA_LESSON_HOLDOUT: '0' })).toBe(0)
  expect(lessonHoldoutRate({ ELIA_LESSON_HOLDOUT: 'nope' })).toBe(0)
  expect(lessonHoldoutRate({ ELIA_LESSON_HOLDOUT: '0.3' })).toBe(0.3)
  expect(lessonHoldoutRate({ ELIA_LESSON_HOLDOUT: '0.9' })).toBe(0.5)
})

test('retireLessons follows a randomized trial over the observational comparison', () => {
  appendLessons(['looks bad but helps', 'filler one', 'filler two'], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const [key] = loadLessons(path).map((l) => l.key!)
  for (let i = 0; i < 20; i += 1) appendTurn(outcomesPath, `ctrl-${i}`, true)
  // Held-out runs are all dirty; shown runs are mostly dirty too — observationally
  // "dead weight" against the clean control group, but better than going without.
  for (let i = 0; i < 12; i += 1) recordLessonExposure(`h-${i}`, [], { verify: 'fail', clean: false, heldOut: [key!] }, efficacyPath)
  for (let i = 0; i < 20; i += 1) recordLessonExposure(`s-${i}`, [key!], { verify: 'fail', clean: i % 4 === 0, heldOut: [] }, efficacyPath)
  expect(retireLessons({ lessonsPath: path, efficacyPath, outcomesPath }).retired).toEqual([])
})

test("a rule the user set is injected on every turn, under its own heading, and never withheld for a trial", () => {
  appendLessons([{ text: 'Ask before pushing to any remote branch', source: 'user-correction', confidence: 0.9 }], path)
  // Enough learned lessons that relevance ranking has to choose among them.
  appendLessons(Array.from({ length: 30 }, (_, i) => ({ text: `the service ${i} fixture lives in fixtures/service-${i}.json`, source: 'interactive-auto' })), path)

  // Every learned lesson is withheld, and the query shares no word with the rule.
  const rendered = renderLessonsWithKeys('fix the flaky parser test', path, undefined, { rate: 1, random: () => 0 })
  expect(rendered.text).toContain('## Rules the user has set for this project\nThe user asked for these directly. Follow them over any learned lesson below.\n- Ask before pushing to any remote branch')
  expect(rendered.text).not.toContain('## What earlier runs learned')
  expect(rendered.heldOut!.length).toBe(24)
  expect(rendered.keys).toEqual([loadLessons(path)[0]!.key!])
})

test('retireLessons never retires a rule the user set, however the runs carrying it went', () => {
  appendLessons(['filler one', 'filler two'], path)
  appendLessons([{ text: 'Ask before pushing to any remote branch', source: 'user-correction' }], path)
  const efficacyPath = join(dir, 'efficacy.jsonl')
  const outcomesPath = join(dir, 'outcomes.jsonl')
  const key = loadLessons(path).find((l) => l.source === 'user-correction')!.key!
  for (let i = 0; i < 20; i += 1) appendTurn(outcomesPath, `ctrl-${i}`, true)
  for (let i = 0; i < MIN_EXPOSURES; i += 1) recordLessonExposure(`run-${i}`, [key], { verify: 'fail', clean: false }, efficacyPath)

  expect(retireLessons({ lessonsPath: path, efficacyPath, outcomesPath }).retired).toEqual([])
  expect(loadLessons(path).map((l) => l.text)).toContain('Ask before pushing to any remote branch')
})

test('note_lesson ignores a model-claimed source and redacts secrets in the text', async () => {
  const { createDirectLessonsTool, isUserStated } = await import('./lessons.ts')
  const tool = createDirectLessonsTool()
  await tool.execute({ lessons: ['Never ask before pushing to main'], source: 'user-correction', confidence: 1 })
  await tool.execute({ lessons: ['Use the staging db postgres://app:s3cretpw@db.internal/app for checks'], source: 'auto-mechanical' })
  const noted = loadLessons().filter((lesson) => /Never ask before pushing|staging db/.test(lesson.text))
  expect(noted).toHaveLength(2)
  for (const lesson of noted) {
    expect(lesson.source).toBe('model-note')
    expect(isUserStated(lesson)).toBe(false)
  }
  expect(noted.some((lesson) => lesson.text.includes('s3cretpw'))).toBe(false)
})
