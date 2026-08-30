import { expect, test } from 'bun:test'
import { browserNameForPath, findChromePath } from './launchChrome.ts'

test('findChromePath returns undefined when none of the candidate paths exist', () => {
  expect(findChromePath(() => false)).toBeUndefined()
})

test('findChromePath returns the first candidate path that exists', () => {
  let calls = 0
  const exists = () => {
    calls += 1
    return calls === 2 // only the second candidate "exists"
  }
  const found = findChromePath(exists)
  expect(found).toBeDefined()
  expect(calls).toBe(2)
})

test('Chrome is preferred over Edge and other Chromium browsers when several are installed', () => {
  const found = findChromePath((path) => /chrome\.exe$|Google Chrome|google-chrome$/.test(path) || path.toLowerCase().includes('edge'))
  expect(found).toBeDefined()
  expect(browserNameForPath(found!)).toBe('Chrome')
})

test('falls back to Edge when Chrome is not installed', () => {
  const found = findChromePath((path) => /msedge|Microsoft Edge|microsoft-edge/.test(path))
  expect(found).toBeDefined()
  expect(browserNameForPath(found!)).toBe('Edge')
})

test('browserNameForPath names each Chromium family member', () => {
  expect(browserNameForPath('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe('Chrome')
  expect(browserNameForPath('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBe('Edge')
  expect(browserNameForPath('/usr/bin/brave-browser')).toBe('Brave')
  expect(browserNameForPath('/usr/bin/chromium')).toBe('Chromium')
})
