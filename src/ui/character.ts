// Elia — the CLI's character. A small Greek woman in a laurel wreath and
// draped chiton, rendered as plain ASCII so she's safe in any terminal.
export const GOLD = '\x1b[33m'
export const DIM = '\x1b[2m'
export const RESET = '\x1b[0m'

export const CHARACTER_FRAMES: readonly string[][] = [
  // neutral
  [
    '      ,~^~^~,',
    '     ( o   o )',
    '      \\  u  /',
    '     __\\___/__',
    '    /  ELIA   \\',
    "    '-.,___,.-'",
  ],
  // blink
  [
    '      ,~^~^~,',
    '     ( -   - )',
    '      \\  u  /',
    '     __\\___/__',
    '    /  ELIA   \\',
    "    '-.,___,.-'",
  ],
  // pondering
  [
    '      ,~^~^~,',
    '     ( o   o )',
    '      \\  o  /',
    '     __\\___/__',
    '    /  ELIA   \\',
    "    '-.,___,.-'",
  ],
]

export function printBanner(): void {
  for (const line of CHARACTER_FRAMES[0]!) {
    process.stdout.write(`${GOLD}${line}${RESET}\n`)
  }
}
