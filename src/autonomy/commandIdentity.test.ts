import { describe, expect, test } from 'bun:test'
import { canonicalizeCommandForIdentity } from './commandIdentity.ts'

describe('command identity canonicalization', () => {
  test('normalizes recognized POSIX shell wrapper paths', () => {
    expect(canonicalizeCommandForIdentity('bash -lc bun test')).toBe(canonicalizeCommandForIdentity('/bin/bash -lc bun test'))
    expect(canonicalizeCommandForIdentity('sh -c echo ok')).toBe(canonicalizeCommandForIdentity('/usr/bin/sh -c echo ok'))
  })

  test('preserves exact complex script text and distinguishes shell modes', () => {
    const script = 'printf "a  b" && echo \'$HOME\' > /tmp/out'
    expect(canonicalizeCommandForIdentity(`/bin/bash -lc ${script}`)).toBe(`__elia_shell_script__\u001f-lc\u001f${script}`)
    expect(canonicalizeCommandForIdentity(`/bin/bash -lc ${script}`)).not.toBe(canonicalizeCommandForIdentity(`/bin/bash -c ${script}`))
  })

  test('does not normalize unknown executable paths or non-shell commands', () => {
    expect(canonicalizeCommandForIdentity('/tmp/bash -lc bun test')).toBe('/tmp/bash -lc bun test')
    expect(canonicalizeCommandForIdentity('python -c print(1)')).toBe('python -c print(1)')
    expect(canonicalizeCommandForIdentity('bash script.sh')).toBe('bash script.sh')
  })

  test('normalizes PowerShell wrapper paths but retains mode and script', () => {
    expect(canonicalizeCommandForIdentity('pwsh -Command Get-ChildItem')).toBe('__elia_powershell_script__\u001f-command\u001fGet-ChildItem')
    expect(canonicalizeCommandForIdentity('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-ChildItem')).toBe('__elia_powershell_script__\u001f-command\u001fGet-ChildItem')
    expect(canonicalizeCommandForIdentity('pwsh -EncodedCommand abc')).toBe('__elia_powershell_script__\u001f-encodedcommand\u001fabc')
  })
})
