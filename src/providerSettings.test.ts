import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activeProviderNeedsSetup, removeProviderConfiguration, savedProviderNames, saveProviderConfiguration } from './providerSettings.ts'

const originalProvider = process.env.ELIA_PROVIDER
const originalModel = process.env.ELIA_MODEL
const originalBaseURL = process.env.ELIA_BASE_URL
const originalNvidiaKey = process.env.NVIDIA_API_KEY
const originalOpenAIKey = process.env.OPENAI_API_KEY

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('ELIA_PROVIDER', originalProvider)
  restore('ELIA_MODEL', originalModel)
  restore('ELIA_BASE_URL', originalBaseURL)
  restore('NVIDIA_API_KEY', originalNvidiaKey)
  restore('OPENAI_API_KEY', originalOpenAIKey)
})

test('provider setup saves a selected model atomically and activates it immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-provider-settings-'))
  const path = join(dir, 'config.env')
  try {
    const saved = saveProviderConfiguration({ provider: 'nvidia', apiKey: 'synthetic-nvidia-key', model: 'nvidia/test-model', filePath: path })
    expect(saved.provider).toBe('nvidia')
    expect(saved.model).toBe('nvidia/test-model')
    expect(process.env.ELIA_PROVIDER).toBe('nvidia')
    expect(process.env.ELIA_MODEL).toBe('nvidia/test-model')
    expect(process.env.NVIDIA_API_KEY).toBe('synthetic-nvidia-key')
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('ELIA_PROVIDER=nvidia')
    expect(content).toContain('ELIA_MODEL=nvidia/test-model')
    expect(content).toContain('NVIDIA_API_KEY=synthetic-nvidia-key')
    expect(statSync(path).mode & 0o077).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('first-run completeness detection requires credentials and custom provider metadata', () => {
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'key' })).toBe(false)
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'nvidia' })).toBe(true)
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'custom', ELIA_API_KEY: 'key', ELIA_BASE_URL: 'https://api.example.com/v1', ELIA_MODEL: 'model' })).toBe(false)
  expect(activeProviderNeedsSetup({ ELIA_PROVIDER: 'custom', ELIA_API_KEY: 'key', ELIA_BASE_URL: 'https://api.example.com/v1' })).toBe(true)
})

test('saved provider listing omits providers with no stored key and removal deletes only selected profile fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-provider-removal-'))
  const path = join(dir, 'config.env')
  try {
    writeFileSync(path, '# keep\nELIA_PROVIDER=nvidia\nNVIDIA_API_KEY=nvidia-key\nELIA_MODEL=nvidia/model\nOPENAI_API_KEY=openai-key\nOTHER_SETTING=keep\n')
    expect(savedProviderNames(path)).toEqual(['openai', 'nvidia'])
    const removed = removeProviderConfiguration('nvidia', path)
    expect(removed.removed).toBe(true)
    const content = readFileSync(path, 'utf8')
    expect(content).not.toContain('NVIDIA_API_KEY')
    expect(content).not.toContain('ELIA_PROVIDER=nvidia')
    expect(content).not.toContain('ELIA_MODEL=nvidia/model')
    expect(content).toContain('OPENAI_API_KEY=openai-key')
    expect(content).toContain('OTHER_SETTING=keep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
