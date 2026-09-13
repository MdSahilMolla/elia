import { afterEach, expect, test } from 'bun:test'
import {
  ContainerUnavailable,
  containerSandboxConfigured,
  containerSandboxRequested,
  isDockerTransportFailure,
  resetContainerSandboxWarningForTests,
  runShellInContainer,
  sandboxImage,
} from './container.ts'
import type { ShellResult } from '../shell.ts'

const originalMode = process.env.ELIA_SANDBOX
const originalImage = process.env.ELIA_SANDBOX_IMAGE
const originalWhich = Bun.which

afterEach(() => {
  if (originalMode === undefined) delete process.env.ELIA_SANDBOX
  else process.env.ELIA_SANDBOX = originalMode
  if (originalImage === undefined) delete process.env.ELIA_SANDBOX_IMAGE
  else process.env.ELIA_SANDBOX_IMAGE = originalImage
  Bun.which = originalWhich
  resetContainerSandboxWarningForTests()
})

test('containerSandboxRequested is false unless ELIA_SANDBOX is exactly "container"', () => {
  delete process.env.ELIA_SANDBOX
  expect(containerSandboxRequested()).toBe(false)
  process.env.ELIA_SANDBOX = 'off'
  expect(containerSandboxRequested()).toBe(false)
  process.env.ELIA_SANDBOX = 'container'
  expect(containerSandboxRequested()).toBe(true)
  process.env.ELIA_SANDBOX = 'Container' // case-insensitive
  expect(containerSandboxRequested()).toBe(true)
})

test('sandboxImage has no built-in default — never guesses an image', () => {
  delete process.env.ELIA_SANDBOX_IMAGE
  expect(sandboxImage()).toBeUndefined()
  process.env.ELIA_SANDBOX_IMAGE = 'node:20-slim'
  expect(sandboxImage()).toBe('node:20-slim')
})

test('containerSandboxConfigured requires both the mode and an explicit image', () => {
  delete process.env.ELIA_SANDBOX
  delete process.env.ELIA_SANDBOX_IMAGE
  expect(containerSandboxConfigured()).toBe(false)
  process.env.ELIA_SANDBOX = 'container'
  expect(containerSandboxConfigured()).toBe(false) // mode set, image still missing
  process.env.ELIA_SANDBOX_IMAGE = 'node:20-slim'
  expect(containerSandboxConfigured()).toBe(true)
})

test('runShellInContainer refuses to guess an image, before ever checking for docker itself', async () => {
  delete process.env.ELIA_SANDBOX_IMAGE
  await expect(runShellInContainer('echo hi', 5000)).rejects.toThrow(ContainerUnavailable)
  await expect(runShellInContainer('echo hi', 5000)).rejects.toThrow(/ELIA_SANDBOX_IMAGE/)
})

test('runShellInContainer reports docker missing distinctly, once an image is configured', async () => {
  // GitHub-hosted runners ship docker preinstalled and on PATH, so this can't
  // rely on the actual host lacking it. Mutating process.env.PATH doesn't
  // work either — Bun.which() resolves against a PATH snapshot taken at
  // startup, not process.env.PATH read fresh per call (verified: even
  // clearing/deleting/corrupting process.env.PATH at runtime, Bun.which still
  // finds an already-resolved binary). Stub Bun.which itself instead.
  process.env.ELIA_SANDBOX_IMAGE = 'node:20-slim'
  Bun.which = () => null
  await expect(runShellInContainer('echo hi', 5000)).rejects.toThrow(/docker is not installed/)
})

function result(overrides: Partial<ShellResult>): ShellResult {
  return { command: 'echo hi', exitCode: 1, stdout: '', stderr: '', elapsedMs: 5, timedOut: false, ...overrides }
}

test('isDockerTransportFailure recognizes the docker daemon actually being unreachable', () => {
  expect(isDockerTransportFailure(result({ stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }))).toBe(true)
  expect(isDockerTransportFailure(result({ stderr: 'error during connect: this error may indicate that the docker daemon is not running' }))).toBe(true)
  expect(isDockerTransportFailure(result({ stderr: 'permission denied while trying to connect to the Docker daemon socket' }))).toBe(true)
})

test('isDockerTransportFailure is false for a successful run, a real command failure, a timeout, or a missing image', () => {
  expect(isDockerTransportFailure(result({ exitCode: 0, stderr: '' }))).toBe(false)
  expect(isDockerTransportFailure(result({ exitCode: 1, stderr: 'npm test failed: 3 tests failed' }))).toBe(false)
  expect(isDockerTransportFailure(result({ exitCode: 1, timedOut: true, stderr: '' }))).toBe(false)
  // A missing image is a configuration problem the operator must see and fix,
  // never something to silently fall back from and lose the sandbox for.
  expect(isDockerTransportFailure(result({ exitCode: 125, stderr: 'Unable to find image \'node:not-a-real-tag\' locally\ndocker: Error response from daemon: manifest unknown' }))).toBe(false)
})
