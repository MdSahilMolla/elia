import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'
import { runGit } from '../autonomy/worktree.ts'
import { loadLessons, renderLessonsWithKeys, rewriteLessons } from '../autonomy/lessons.ts'
import { loadTaskSpecs } from './history/suite.ts'

/**
 * Lessons, as a benchmark task sees them.
 *
 * The benchmark used to run with no project memory at all, so nothing could say
 * whether elia's lessons make it better at real work — the one part of
 * compounding that lives in memory rather than code was invisible to the
 * number that decides everything else. `elia bench --lessons` points the task
 * processes at a lesson store (`ELIA_BENCH_LESSONS`), and they get what a real
 * turn would get.
 *
 * With one guard. A history task is a real past commit of this repository, and a
 * lesson written after that commit may describe the very fix the task asks for.
 * Those lessons would score as help while being the answer key, so a history task
 * only sees lessons recorded before its commit — and none at all when that date
 * cannot be read.
 */

export const BENCH_LESSONS_ENV = 'ELIA_BENCH_LESSONS'

async function commitTimeMs(sha: string, repoRoot = ELIA_ROOT): Promise<number | undefined> {
  const result = await runGit(['show', '-s', '--format=%ct', sha], repoRoot)
  const seconds = Number(result.stdout.trim())
  return result.exitCode === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** The lesson block to append to a task's system prompt, or '' when lessons are off or unsafe for this task. */
export async function benchLessonBlock(taskId: string, prompt: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const storePath = env[BENCH_LESSONS_ENV]
  if (!storePath) return ''
  let lessons = loadLessons(storePath)
  const spec = loadTaskSpecs().find((candidate) => candidate.id === taskId)
  if (spec) {
    const cutoff = await commitTimeMs(spec.sha)
    if (cutoff === undefined) return ''
    lessons = lessons.filter((lesson) => lesson.at > 0 && lesson.at < cutoff)
  }
  if (lessons.length === 0) return ''
  const dir = mkdtempSync(join(tmpdir(), 'elia-bench-lessons-'))
  try {
    const path = join(dir, 'lessons.md')
    rewriteLessons(lessons, path)
    // No holdout: this measures the store as a whole, and every task in the run
    // must see the same thing for the with/without comparison to mean anything.
    return renderLessonsWithKeys(prompt, path, undefined, { rate: 0 }).text
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
