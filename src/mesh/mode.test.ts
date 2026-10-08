import { afterEach, describe, expect, it, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshEnabled, meshHostAdvertiseAddress, meshHostListenAddress, meshMode, meshPathProblem, resolveMeshPath } from './mode.ts'

const savedMode = process.env.ELIA_WORKSPACE_MESH
const savedPath = process.env.ELIA_RWS_PATH

afterEach(() => {
  if (savedMode === undefined) delete process.env.ELIA_WORKSPACE_MESH
  else process.env.ELIA_WORKSPACE_MESH = savedMode
  if (savedPath === undefined) delete process.env.ELIA_RWS_PATH
  else process.env.ELIA_RWS_PATH = savedPath
})

test('the mesh defaults to off', () => {
  delete process.env.ELIA_WORKSPACE_MESH
  expect(meshMode()).toBe('off')
  expect(meshEnabled()).toBe(false)
})

test('auto and require are honoured, case-insensitively; anything else is off', () => {
  process.env.ELIA_WORKSPACE_MESH = 'AUTO'
  expect(meshMode()).toBe('auto')
  process.env.ELIA_WORKSPACE_MESH = 'require'
  expect(meshMode()).toBe('require')
  process.env.ELIA_WORKSPACE_MESH = 'yes'
  expect(meshMode()).toBe('off')
})

test('the binary resolves only from ELIA_RWS_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-mesh-mode-'))
  const bin = join(dir, 'workspace-sidecar')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)

  delete process.env.ELIA_RWS_PATH
  expect(resolveMeshPath()).toBeUndefined()

  process.env.ELIA_RWS_PATH = bin
  expect(resolveMeshPath()).toBe(bin)
  expect(meshPathProblem()).toBeUndefined()
})

test('a configured path that is missing or not executable does not resolve, and says why', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'elia-mesh-mode-'))
  const missing = join(fixtureDir, 'nope')
  process.env.ELIA_RWS_PATH = missing
  expect(resolveMeshPath()).toBeUndefined()
  expect(meshPathProblem()).toContain('does not exist')

  const notExecutable = join(fixtureDir, 'data.txt')
  writeFileSync(notExecutable, 'x')
  chmodSync(notExecutable, 0o644)
  process.env.ELIA_RWS_PATH = notExecutable
  if (process.platform !== 'win32') {
    expect(resolveMeshPath()).toBeUndefined()
    expect(meshPathProblem()).toContain('not executable')
  }
})

// A member that has already paired comes back to the address it was given once.
// If the host re-binds a random port on restart there is nothing to come back to,
// so the address has to be configurable — and this is the only place it is read.
describe('host reachability', () => {
  const saved = { listen: process.env.ELIA_RWS_LISTEN, advertise: process.env.ELIA_RWS_ADVERTISE }
  afterEach(() => {
    if (saved.listen === undefined) delete process.env.ELIA_RWS_LISTEN
    else process.env.ELIA_RWS_LISTEN = saved.listen
    if (saved.advertise === undefined) delete process.env.ELIA_RWS_ADVERTISE
    else process.env.ELIA_RWS_ADVERTISE = saved.advertise
  })

  it('binds loopback on a random port unless told otherwise', () => {
    delete process.env.ELIA_RWS_LISTEN
    expect(meshHostListenAddress()).toBe('127.0.0.1:0')
  })

  it('uses the configured listen address', () => {
    process.env.ELIA_RWS_LISTEN = '0.0.0.0:9777'
    expect(meshHostListenAddress()).toBe('0.0.0.0:9777')
  })

  it('has no advertised address unless one is configured', () => {
    delete process.env.ELIA_RWS_ADVERTISE
    expect(meshHostAdvertiseAddress()).toBeUndefined()
    process.env.ELIA_RWS_ADVERTISE = '   '
    expect(meshHostAdvertiseAddress()).toBeUndefined()
  })

  it('advertises a bare host, stripping a port the caller included', () => {
    // The join code carries the port from what the sidecar bound, so passing one
    // here would have it wrapped a second time into `[host:port]:port` — an
    // address that fails to resolve on the peer, seconds later and on a machine
    // that looks nothing like the one that was misconfigured.
    process.env.ELIA_RWS_ADVERTISE = 'laptop.local'
    expect(meshHostAdvertiseAddress()).toBe('laptop.local')
    process.env.ELIA_RWS_ADVERTISE = 'laptop.local:9777'
    expect(meshHostAdvertiseAddress()).toBe('laptop.local')
    process.env.ELIA_RWS_ADVERTISE = '10.0.0.5:9777'
    expect(meshHostAdvertiseAddress()).toBe('10.0.0.5')
    // A bare IPv6 literal is full of colons and must survive intact.
    process.env.ELIA_RWS_ADVERTISE = 'fe80::1'
    expect(meshHostAdvertiseAddress()).toBe('fe80::1')
    process.env.ELIA_RWS_ADVERTISE = '[fe80::1]:9777'
    expect(meshHostAdvertiseAddress()).toBe('[fe80::1]')
    process.env.ELIA_RWS_ADVERTISE = 'fe80::1'
    expect(meshHostAdvertiseAddress()).toBe('fe80::1')
    // A single colon with a non-numeric tail is a host, not a host and port.
    process.env.ELIA_RWS_ADVERTISE = 'laptop.local:'
    expect(meshHostAdvertiseAddress()).toBe('laptop.local:')
  })
})
