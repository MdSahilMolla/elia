import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function runCli(args: string[], overrides: Record<string, string | undefined> = {}, cwd = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
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
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'index.ts'), ...args], {
    cwd,
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
  expect(result.stdout).toContain('/mode')
  // One way of working: the help names the one gate and no approval modes.
  expect(result.stdout).toContain('there is no mode to pick')
  expect(result.stdout).toContain('--authorize')
  expect(result.stdout).not.toContain('--supervised')
  expect(result.stdout).not.toContain('/auto on|off')
  expect(result.stdout).toContain('elia control stop')
  expect(result.stdout).toContain('--beta <mode>')
  expect(result.stdout).toContain('/betamode')
  expect(result.stdout).toContain('--battmann')
  expect(result.stdout).toContain('/eliabook')
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

test('sessions are listable and resumable by id without a provider', async () => {
  const withoutProvider = {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  }
  const project = mkdtempSync(join(tmpdir(), 'elia-cli-sessions-'))
  try {
    const { saveSession } = await import('../session.ts')
    await saveSession(
      'aa11bb22-cc33',
      [
        { role: 'user', content: [{ type: 'text', text: 'rename the billing column' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
      join(project, '.elia', 'sessions'),
    )

    const [listed, bare, unknown] = await Promise.all([
      runCli(['sessions', '--plain'], withoutProvider, project),
      runCli(['--resume', '--plain'], withoutProvider, project),
      runCli(['--resume', 'no-such-id', '--plain'], withoutProvider, project),
    ])

    // The listing is what makes an id available to copy in the first place.
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('aa11bb22-cc33')
    expect(listed.stdout).toContain('rename the billing column')

    // Without a terminal there is no picker to draw, so both failures name what
    // is available rather than silently starting an unrelated fresh session.
    expect(bare.code).toBe(1)
    expect(bare.stderr).toContain('--resume requires a session id')
    expect(bare.stderr).toContain('aa11bb22-cc33')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('No saved conversation with id "no-such-id"')

    for (const result of [listed, bare, unknown]) expect(result.stderr).not.toContain('No API key found')
  } finally {
    rmSync(project, { recursive: true, force: true })
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
  expect(stored).toContain('ELIA_MODEL=nvidia/nemotron-3-super-120b-a12b')
})

test('config set refuses another provider\'s model for a single-family provider, and saves nothing (#1294)', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'elia-cli-config-')), 'config.env')
  const env = {
    ELIA_CONFIG_PATH: configPath,
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    INCEPTION_API_KEY: undefined,
    ELIA_TEST_SETUP_KEY: 'setup-test-key',
  }
  const refused = await runCli(['config', 'set', '--provider', 'mercury', '--model', 'gpt-5.5', '--api-key-env', 'ELIA_TEST_SETUP_KEY', '--plain'], env)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`"gpt-5.5" is not one of mercury's models`)
  expect(existsSync(configPath)).toBe(false)

  const anyway = await runCli(['config', 'set', '--provider', 'mercury', '--model', 'gpt-5.5', '--anyway', '--api-key-env', 'ELIA_TEST_SETUP_KEY', '--plain'], env)
  expect(anyway.code).toBe(0)
  expect(readFileSync(configPath, 'utf8')).toContain('ELIA_MODEL=gpt-5.5')
})

test('the old supervision switches are gone: elia auto says so and stays autonomous', async () => {
  const result = await runCli(['auto', 'do work', '--supervised', '--plain'], {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    ELIA_SUPERVISION: 'supervised',
  })
  expect(`${result.stdout}${result.stderr}`).toContain('elia is always autonomous now')
  expect(`${result.stdout}${result.stderr}`).not.toContain('Supervision conflict')
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
  const metadataCwd = mkdtempSync(join(tmpdir(), 'elia-cli-metadata-'))
  const withoutProvider = {
    ELIA_PROVIDER: undefined,
    ELIA_MODEL: undefined,
    ELIA_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NVIDIA_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    ELIA_MCP_USER_CONFIG: join(metadataCwd, 'missing-user-mcp.json'),
  }
  try {
    const [skills, schedules, runs, timeline, daemon] = await Promise.all([
      runCli(['skills', 'path', '--plain'], withoutProvider, metadataCwd),
      runCli(['schedule', 'list', '--plain'], withoutProvider, metadataCwd),
      runCli(['runs', '--plain'], withoutProvider, metadataCwd),
      runCli(['runs', 'missing-run', '--plain'], withoutProvider, metadataCwd),
      runCli(['daemon', '--once', '--plain'], withoutProvider, metadataCwd),
    ])
    expect(skills.code).toBe(0)
    expect(schedules.code).toBe(0)
    expect(runs.code).toBe(0)
    expect(timeline.code).toBe(0)
    expect(daemon.code).toBe(0)
    for (const result of [skills, schedules, runs, timeline, daemon]) {
      expect(result.stderr).not.toContain('No API key found')
    }
  } finally {
    rmSync(metadataCwd, { recursive: true, force: true })
  }
}, 15_000)
