import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function runCli(args: string[], overrides: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    ...process.env,
    ELIA_ROUTING_MODE: 'selected',
    ELIA_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const proc = Bun.spawn([process.execPath, 'src/index.ts', ...args], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

test('native CLI emits parseable JSONL for argument errors', async () => {
  const result = await runCli(['auto', '--json'])
  expect(result.code).toBe(1)
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string })
  expect(events.map((event) => event.type)).toEqual(['cli_started', 'error'])
  expect(result.stdout).not.toContain('\x1b[')
})

test('plain mode emits no ANSI escape sequences', async () => {
  const result = await runCli(['skills', 'path', '--plain'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b[')
  expect(result.stdout).toContain('Project skills:')
})

test('help documents autonomous budget and agent dry-run controls', async () => {
  const result = await runCli(['--help', '--plain'])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('--max-run-ms')
  expect(result.stdout).toContain('--max-actions')
  expect(result.stdout).toContain('--dry-run')
  expect(result.stdout).toContain('Office workflows:')
  expect(result.stdout).toContain('spreadsheet')
  expect(result.stdout).toContain('presentation')
  expect(result.stdout).toContain('Dev mode (default)')
  expect(result.stdout).toContain('/dev')
  expect(result.stdout).toContain('--unattended')
  expect(result.stdout).toContain('--supervised')
  expect(result.stdout).toContain('elia control stop')
  expect(result.stdout).toContain('--sports')
  expect(result.stdout).toContain('--fitness')
  expect(result.stdout).toContain('/sports')
})

test('invalid autonomous wall-clock budget fails before execution', async () => {
  const result = await runCli(['auto', 'do work', '--max-run-ms', '0', '--plain'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--max-run-ms must be a positive integer')
})

test('invalid autonomous action budget fails before execution', async () => {
  const result = await runCli(['auto', 'do work', '--max-actions', '0', '--plain'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--max-actions must be a positive integer')
})

test('CLI accepts inline value flags and does not treat them as goal text', async () => {
  const result = await runCli(['auto', 'do work', '--max-actions=0', '--plain=false'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--max-actions must be a positive integer')
})

test('CLI rejects malformed numeric values instead of partially parsing them', async () => {
  const [suffix, negative, tooLarge] = await Promise.all([
    runCli(['auto', 'do work', '--max-run-ms', '1000ms', '--plain']),
    runCli(['auto', 'do work', '--max-actions', '-1', '--plain']),
    runCli(['auto', 'do work', '--max-actions', '10001', '--plain']),
  ])
  expect(suffix.code).toBe(1)
  expect(suffix.stderr).toContain('--max-run-ms must be a positive integer')
  expect(negative.code).toBe(1)
  expect(negative.stderr).toContain('--max-actions must be a positive integer')
  expect(tooLarge.code).toBe(1)
  expect(tooLarge.stderr).toContain('between 1 and 10000')
})

test('CLI rejects missing values without consuming the next flag', async () => {
  const result = await runCli(['auto', 'do work', '--max-actions', '--plain'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--max-actions must be a positive integer')
})

test('CLI rejects empty inline schedule options before persistence', async () => {
  const result = await runCli(['schedule', 'add', '--every', '1h', '--profile=', 'repository health', '--plain'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--profile must be fast, balanced, or thorough')
})

test('provider-independent validation does not initialize a model', async () => {
  const withoutProvider = {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  }
  const [auto, agent, evolve, fork, resume] = await Promise.all([
    runCli(['auto', 'do work', '--max-run-ms', '1000ms', '--plain'], withoutProvider),
    runCli(['agent', '--dry-run', '--plain'], withoutProvider),
    runCli(['evolve', '--generations', '2bad', '--plain'], withoutProvider),
    runCli(['fork', '--at', 'nope', '--with', 'change', '--plain'], withoutProvider),
    runCli(['--resume', '--plain'], withoutProvider),
  ])
  expect(auto.stderr).toContain('--max-run-ms must be a positive integer')
  expect(agent.stderr).toContain('Give elia a request')
  expect(evolve.stderr).toContain('--generations must be a positive integer')
  expect(fork.stderr).toContain('Usage: elia fork')
  expect(resume.stderr).toContain('--resume requires a session id')
  for (const result of [auto, agent, evolve, fork, resume]) {
    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain('No API key found')
  }
})

test('agent dry-run routes locally without a provider credential', async () => {
  const result = await runCli(['agent', 'Fix a TypeScript parser bug', '--dry-run', '--plain'], {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('tech')
  expect(result.stdout).toContain('dry-run')
  expect(result.stderr).not.toContain('No API key found')
})

test('config set stores a provider key without printing it', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'elia-cli-config-')), 'config.env')
  const result = await runCli(['config', 'set', '--provider', 'nvidia', '--api-key-env', 'ELIA_TEST_SETUP_KEY', '--plain'], {
    ELIA_CONFIG_PATH: configPath,
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    ELIA_TEST_SETUP_KEY: 'setup-test-key',
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Saved nvidia configuration')
  expect(result.stdout).not.toContain('setup-test-key')
  expect(result.stderr).not.toContain('setup-test-key')
  const stored = readFileSync(configPath, 'utf8')
  expect(stored).toContain('NVIDIA_API_KEY=setup-test-key')
  expect(stored).toContain('ELIA_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5')
})

test('invalid supervision settings fail before provider initialization', async () => {
  const result = await runCli(['auto', 'do work', '--plain'], {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    ELIA_SUPERVISION: 'unsafe',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('ELIA_SUPERVISION must be either supervised or unattended')
  expect(result.stderr).not.toContain('No API key found')
})

test('conflicting supervision flags fail closed', async () => {
  const result = await runCli(['auto', 'do work', '--supervised', '--unattended', '--plain'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Supervision conflict')
})

test('control status stays provider-independent', async () => {
  const result = await runCli(['control', 'status', '--plain'], {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  })
  expect(result.code).toBe(0)
  expect(result.stderr).not.toContain('No API key found')
})

test('metadata commands stay provider-independent', async () => {
  const withoutProvider = {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  }
  const [skills, schedules, runs, timeline, daemon] = await Promise.all([
    runCli(['skills', 'path', '--plain'], withoutProvider),
    runCli(['schedule', 'list', '--plain'], withoutProvider),
    runCli(['runs', '--plain'], withoutProvider),
    runCli(['runs', 'missing-run', '--plain'], withoutProvider),
    runCli(['daemon', '--once', '--plain'], withoutProvider),
  ])
  expect(skills.code).toBe(0)
  expect(schedules.code).toBe(0)
  expect(runs.code).toBe(0)
  expect(timeline.code).toBe(0)
  expect(daemon.code).toBe(0)
  for (const result of [skills, schedules, runs, timeline, daemon]) {
    expect(result.stderr).not.toContain('No API key found')
  }
})
