import { expect, test } from 'bun:test'
import { blendable, glyphs, onThemeChange, palette, resolveThemeName, setTheme, THEME_CHOICES, themeName } from './theme.ts'

test('the theme follows ELIA_THEME, then the console, then the background it advertises', () => {
  expect(resolveThemeName({})).toBe('dark')
  expect(resolveThemeName({ ELIA_THEME: 'light' })).toBe('light')
  expect(resolveThemeName({ ELIA_THEME: ' ANSI ' })).toBe('ansi')
  expect(resolveThemeName({ ELIA_THEME: 'solarized' })).toBe('dark')
  expect(resolveThemeName({ COLORFGBG: '0;15' })).toBe('light')
  expect(resolveThemeName({ COLORFGBG: '15;0' })).toBe('dark')
  expect(resolveThemeName({ TERM: 'linux' })).toBe('ansi')
  // A console that says it does true colour is taken at its word.
  expect(resolveThemeName({ TERM: 'linux', COLORTERM: 'truecolor' })).toBe('dark')
  expect(resolveThemeName({ ELIA_THEME: 'dark', COLORFGBG: '0;15' })).toBe('dark')
})

test('the suite always draws with the dark palette, whatever the shell exports', () => {
  expect(themeName).toBe('dark')
  expect(blendable).toBe(true)
  expect(palette.brand).toMatch(/^#[0-9A-F]{6}$/i)
  // Text keeps the terminal's own foreground.
  expect(palette.text).toBeUndefined()
  expect(palette.accent).toBeUndefined()
})

test('switching the theme changes the shared palette in place and tells whoever listens', () => {
  const heldBrand = palette.brand
  let heard = 0
  const stop = onThemeChange(() => {
    heard += 1
  })
  try {
    setTheme('light')
    expect(themeName).toBe('light')
    expect(palette.brand).not.toBe(heldBrand)
    setTheme('ansi')
    expect(palette.brand).toBe('yellow')
    // Named colours cannot be blended; the shimmer steps aside.
    expect(blendable).toBe(false)
    expect(heard).toBe(2)
  } finally {
    stop()
    setTheme('dark')
  }
  expect(palette.brand).toBe(heldBrand)
  expect(blendable).toBe(true)
  expect(THEME_CHOICES.map((choice) => choice.name)).toEqual(['dark', 'light', 'ansi'])
})

test('the glyphs other parts of the UI draw with are still there', () => {
  // BrowserMotion and the classic stream renderer depend on these.
  expect(glyphs.branch).toBe('⎿')
  expect(palette.muted).toBeDefined()
  expect(glyphs.user).toBe('❯')
  expect(glyphs.bullet).toBe('●')
})
