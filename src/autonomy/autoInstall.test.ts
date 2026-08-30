import { expect, test } from 'bun:test'
import { detectMissingPackage, installCommandFor, isInstallCommand } from './autoInstall.ts'

test('detects a missing npm module', () => {
  expect(detectMissingPackage("Error: Cannot find module 'lodash'")).toEqual({ manager: 'node', package: 'lodash' })
  expect(detectMissingPackage("Cannot find package 'zod' imported from /x/y.ts")).toEqual({ manager: 'node', package: 'zod' })
})

test('reduces a scoped subpath import to the package name', () => {
  expect(detectMissingPackage("Cannot find module '@tanstack/react-query/build'")).toEqual({ manager: 'node', package: '@tanstack/react-query' })
})

test('ignores node built-ins and relative imports', () => {
  expect(detectMissingPackage("Cannot find module 'fs'")).toBeUndefined()
  expect(detectMissingPackage("Cannot find module './helpers'")).toBeUndefined()
  expect(detectMissingPackage("Cannot find module 'node:crypto'")).toBeUndefined()
})

test('detects a missing python module', () => {
  expect(detectMissingPackage("ModuleNotFoundError: No module named 'requests'")).toEqual({ manager: 'python', package: 'requests' })
  expect(detectMissingPackage("ModuleNotFoundError: No module named 'PIL.Image'")).toEqual({ manager: 'python', package: 'PIL' })
})

test('nothing on a normal failure', () => {
  expect(detectMissingPackage('AssertionError: expected 2 to equal 3')).toBeUndefined()
})

test('installCommandFor respects the package manager', () => {
  expect(installCommandFor({ manager: 'python', package: 'flask' })).toBe('pip install flask')
  expect(installCommandFor({ manager: 'node', package: 'zod' }, '/tmp/nonexistent-node-proj')).toBe('npm install zod')
})

test('isInstallCommand recognizes installs so we do not loop on them', () => {
  expect(isInstallCommand('bun add react')).toBe(true)
  expect(isInstallCommand('npm ci')).toBe(true)
  expect(isInstallCommand('pip install requests')).toBe(true)
  expect(isInstallCommand('bun test')).toBe(false)
})
