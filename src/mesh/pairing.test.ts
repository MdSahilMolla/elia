import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMeshPaired, readMeshPairing } from './pairing.ts'

function stateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'elia-mesh-pairing-'))
}

/** Creates a state database with the columns the reader touches. */
function writeState(root: string, rows: { role?: string; hostCert?: string; peers?: number }): void {
  const dir = join(root, '.workspace')
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'state.db'))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE peers (peer_id TEXT PRIMARY KEY, role TEXT, cert_sha256 TEXT)')
  if (rows.role !== undefined) db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('role', rows.role)
  if (rows.hostCert !== undefined) db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('host_cert_sha256', rows.hostCert)
  for (let i = 0; i < (rows.peers ?? 0); i += 1) {
    db.query('INSERT INTO peers (peer_id, role, cert_sha256) VALUES (?, ?, ?)').run(`peer_${i}`, 'member', `cert_${i}`)
  }
  db.close()
}

test('no state database means no workspace', () => {
  const pairing = readMeshPairing(stateRoot())
  expect(pairing.present).toBe(false)
  expect(isMeshPaired(pairing)).toBe(false)
})

test('a lone host that has never been joined is not paired', () => {
  const root = stateRoot()
  writeState(root, { role: 'host', peers: 0 })
  const pairing = readMeshPairing(root)
  expect(pairing.present).toBe(true)
  expect(pairing.role).toBe('host')
  expect(isMeshPaired(pairing)).toBe(false)
})

test('a host with a known peer is paired', () => {
  const root = stateRoot()
  writeState(root, { role: 'host', peers: 1 })
  expect(isMeshPaired(readMeshPairing(root))).toBe(true)
})

test('a member that pinned its host is paired', () => {
  const root = stateRoot()
  writeState(root, { role: 'member', hostCert: 'bb'.repeat(32) })
  const pairing = readMeshPairing(root)
  expect(pairing.role).toBe('member')
  expect(pairing.hostCert).toBe('bb'.repeat(32))
  expect(isMeshPaired(pairing)).toBe(true)
})

test('a member that has not pinned a host is not paired', () => {
  const root = stateRoot()
  writeState(root, { role: 'member', peers: 0 })
  expect(isMeshPaired(readMeshPairing(root))).toBe(false)
})

test('an unreadable state database fails safe: present but not paired', () => {
  const root = stateRoot()
  const dir = join(root, '.workspace')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.db'), 'this is not a sqlite database')
  const pairing = readMeshPairing(root)
  expect(pairing.present).toBe(true)
  expect(pairing.peers).toBe(0)
  expect(isMeshPaired(pairing)).toBe(false)
})
