import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('the manifest restricts the settings that choose which executable is spawned in an untrusted workspace', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    capabilities?: { untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: string[] } }
  }
  const untrusted = manifest.capabilities?.untrustedWorkspaces
  expect(untrusted?.supported).toBe('limited')
  for (const setting of ['elia.cliPath', 'elia.runtime', 'elia.governanceMode']) expect(untrusted?.restrictedConfigurations).toContain(setting)
})

test('the extension does not start the bridge in an untrusted workspace', () => {
  const source = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8')
  const trust = source.indexOf('vscode.workspace.isTrusted')
  expect(trust).toBeGreaterThan(-1)
  expect(trust).toBeLessThan(source.indexOf('new EliaBridgeClient'))
})
