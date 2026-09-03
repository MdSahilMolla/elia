import type { SlashCommand } from '../slashPrompt.ts'

export const REPL_COMMANDS_FOR_TEST: SlashCommand[] = [
  { name: '/cost', description: 'session token breakdown' },
  { name: '/export', description: 'export to markdown' },
  { name: '/help', description: 'list commands' },
]

/**
 * Poll an ink-testing-library frame until it matches, or throw after `timeoutMs`.
 *
 * A fixed `sleep(20)` before asserting on a frame is the top source of CI flake
 * in these tests: an Ink render plus its effects can take tens of milliseconds
 * to settle on a loaded 2-core runner — far longer than a hard-coded wait
 * assumes, and long enough that `--retry` alone does not save it. Waiting on the
 * actual frame content instead is both faster in the common case and robust
 * when the machine is slow.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  match: string | RegExp,
  timeoutMs = 2000,
): Promise<string> {
  const hit = (frame: string) => (typeof match === 'string' ? frame.includes(match) : match.test(frame))
  const deadline = Date.now() + timeoutMs
  let frame = lastFrame() ?? ''
  while (!hit(frame) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    frame = lastFrame() ?? ''
  }
  if (!hit(frame)) {
    throw new Error(`waitForFrame: timed out after ${timeoutMs}ms waiting for ${match}\n--- last frame ---\n${frame}`)
  }
  return frame
}
