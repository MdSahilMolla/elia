/**
 * The bridge between Ink's key objects and `sessionActions.ts`'s pure decision
 * helper. Kept separate from the component so the mapping is unit-testable
 * without mounting an Ink tree.
 *
 * Terminal reality check: plain-ASCII terminals cannot distinguish Ctrl+N from
 * Ctrl+Shift+N (both arrive as 0x0E), so any ctrl-n input maps to the spawn
 * combo. A kitty-protocol terminal reports the Shift alongside a printable
 * uppercase "N", which this also accepts. Ctrl+Tab similarly needs a terminal
 * that speaks the kitty (or CSI-u) reporting protocols; a plain Tab is left
 * alone so the existing Tab / Shift+Tab behaviours (menu completion, mode
 * cycling) are untouched.
 */

export interface ComboKeySource {
  ctrl?: boolean
  shift?: boolean
  tab?: boolean
}

/** Ink key object → the normalized combo string `sessionKeyAction` understands. */
export function sessionKeyCombo(input: string, key: ComboKeySource): string | undefined {
  if (key.tab === true && key.ctrl === true) return key.shift === true ? 'ctrl-shift-tab' : 'ctrl-tab'
  if (key.ctrl === true && (input ?? '').toLowerCase() === 'n') return 'ctrl-shift-n'
  return undefined
}