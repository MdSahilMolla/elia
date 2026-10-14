import { describe, expect, test } from 'bun:test'
import {
  PLAYBOOKS,
  PLAYBOOK_CATEGORIES,
  detectCategories,
  isPlaybookCategory,
  playbookFor,
  type Playbook,
  type PlaybookCategory,
} from './index.ts'

/**
 * Pure data invariants. Nothing here renders or shells out — the point is that
 * the *content* of the playbooks is a real asset, not a placeholder that another
 * agent can fill with a stub and still pass a shape test. So the content tests
 * assert substance, not just presence.
 */

const CATEGORIES: PlaybookCategory[] = ['pwn', 'rev', 'crypto', 'stego', 'web', 'misc']

/** Below this a playbook is a stub, not a procedure. */
const MIN_STEPS = 5
const MIN_COMMANDS = 10
const MIN_GOTCHAS = 4
const MIN_DETECT = 3
const MIN_CHARS = 2_000

function allCommands(playbook: Playbook): string[] {
  return playbook.steps.flatMap((step) => step.commands ?? [])
}

describe('registry shape', () => {
  test('every category is present exactly once and in the triage order', () => {
    expect(PLAYBOOK_CATEGORIES).toEqual(CATEGORIES)
    expect(Object.keys(PLAYBOOKS).sort()).toEqual([...CATEGORIES].sort())
  })

  test('playbookFor returns the registered playbook and nothing for a non-category', () => {
    for (const category of CATEGORIES) {
      const playbook = playbookFor(category)
      expect(playbook).toBeDefined()
      expect(playbook!.category).toBe(category)
      expect(playbookFor('forensics' as PlaybookCategory)).toBeUndefined()
    }
  })

  test('isPlaybookCategory accepts the five and rejects near-misses', () => {
    for (const category of CATEGORIES) expect(isPlaybookCategory(category)).toBe(true)
    for (const nope of ['forensics', 'PWN', 'binary', 'reverse', '', 'pwn ']) expect(isPlaybookCategory(nope)).toBe(false)
  })
})

describe('every playbook is a real procedure', () => {
  test('detect, steps, gotchas and successShape are present and non-trivial', () => {
    for (const category of CATEGORIES) {
      const playbook = PLAYBOOKS[category]
      expect(playbook.summary.trim().length).toBeGreaterThan(80)
      expect(playbook.detect.length).toBeGreaterThanOrEqual(MIN_DETECT)
      expect(playbook.steps.length).toBeGreaterThanOrEqual(MIN_STEPS)
      expect(playbook.gotchas.length).toBeGreaterThanOrEqual(MIN_GOTCHAS)
      expect(playbook.successShape.trim().length).toBeGreaterThan(80)
    }
  })

  test('each step has a title, a note, and real commands — steps are in a stable order', () => {
    for (const category of CATEGORIES) {
      const playbook = PLAYBOOKS[category]
      const titles = playbook.steps.map((step) => step.title)
      expect(new Set(titles).size).toBe(titles.length)
      for (const step of playbook.steps) {
        expect(step.title.trim().length).toBeGreaterThan(0)
        expect((step.note ?? '').trim().length).toBeGreaterThan(0)
        expect((step.commands ?? []).length).toBeGreaterThan(0)
      }
      // "Stable order" as a property of the data, not of this test: the titles
      // read as a sequence, so the first step is a triage step and the last is
      // a verification/finish step rather than more triage.
      expect(titles[0]!.toLowerCase()).toMatch(/triage|establish|record|list|turn|metadata|mitigation|program takes input/i)
      expect(titles[titles.length - 1]!.toLowerCase()).toMatch(/verif|prove|re-class|finish|unwrap|band|solve|choose/i)
    }
  })

  test('there is real command volume, and it is concrete rather than a pointer', () => {
    for (const category of CATEGORIES) {
      const commands = allCommands(PLAYBOOKS[category])
      expect(commands.length).toBeGreaterThanOrEqual(MIN_COMMANDS)
      for (const command of commands) {
        expect(command.trim()).toBe(command)
        expect(command.trim().length).toBeGreaterThan(0)
        // A command that is only "look at it" is a placeholder, not a command.
        expect(command).toMatch(/[a-z]/i)
      }
    }
  })

  test('each playbook is substantial enough to be worth a round trip', () => {
    for (const category of CATEGORIES) {
      const size = JSON.stringify(PLAYBOOKS[category]).length
      expect(size).toBeGreaterThan(MIN_CHARS)
    }
  })

  test('signals tell the model what a bad result looks like, not just what to run', () => {
    for (const category of CATEGORIES) {
      const steps = PLAYBOOKS[category].steps
      const withSignals = steps.filter((step) => (step.signals ?? []).length > 0)
      expect(withSignals.length).toBeGreaterThanOrEqual(Math.ceil(steps.length / 2))
      for (const step of steps) {
        for (const signal of step.signals ?? []) expect(signal.trim().length).toBeGreaterThan(10)
      }
    }
  })

  test('pwn commands tell the model to write exploit files rather than inline them', () => {
    const pwn = PLAYBOOKS.pwn
    const commands = allCommands(pwn).join('\n')
    expect(commands).toContain('write_file')
    expect(commands).toContain('exploit.py')
    expect(commands).toContain('checksec')
    expect(commands).toContain('cyclic')
    // A `python3 -c` that carries the exploit itself is the documented failure
    // mode; the only -c allowed is a bare import probe.
    for (const command of allCommands(pwn)) {
      if (command.includes('python3 -c')) expect(command).toMatch(/import|from pwn import/)
    }
  })

  test('every playbook is self-contained: it names tools as strings, imports no catalog', () => {
    for (const category of CATEGORIES) {
      const serialised = JSON.stringify(PLAYBOOKS[category])
      expect(serialised).not.toContain('toolCatalog')
      expect(serialised).not.toContain('SECURITY_TOOL_CATALOG')
    }
  })
})

describe('detectCategories', () => {
  test('recognises a representative hint for each category', () => {
    expect(detectCategories(['chall.elf', 'ret2win'])).toEqual(['pwn'])
    expect(detectCategories(['app.apk'])).toEqual(['rev'])
    expect(detectCategories(['cipher.txt'])).toEqual(['crypto'])
    expect(detectCategories(['photo.png'])).toEqual(['stego'])
  })

  test('recognises the other common spellings of each category', () => {
    expect(detectCategories(['buffer overflow', 'pwnme'])).toEqual(['pwn'])
    expect(detectCategories(['checksec --file=chall'])).toEqual(['pwn'])
    expect(detectCategories(['AndroidManifest.xml', 'jadx'])).toEqual(['rev'])
    expect(detectCategories(['chall.pyc', 'uncompyle'])).toEqual(['rev'])
    expect(detectCategories(['flag.enc', 'RSA'])).toEqual(['crypto'])
    expect(detectCategories(['private key', 'modulus'])).toEqual(['crypto'])
    expect(detectCategories(['sound.wav', 'spectrogram'])).toEqual(['stego'])
    expect(detectCategories(['LSB'])).toEqual(['stego'])
    expect(detectCategories(['capture.pcap', 'tshark'])).toEqual(['misc'])
    expect(detectCategories(['base64', 'rot13'])).toEqual(['misc'])
  })

  test('returns [] for nonsense rather than guessing', () => {
    expect(detectCategories(['zzzz-not-a-real-hint-9182'])).toEqual([])
    expect(detectCategories([])).toEqual([])
    expect(detectCategories(['notes', 'todo', 'draft'])).toEqual([])
  })

  test('does not fire on short tokens that live inside ordinary words', () => {
    // `elf` inside shelf, `aes` inside aerospace, `key` inside monkey, `cap`
    // inside capacity — each would be a false positive from a bare substring.
    expect(detectCategories(['shelf-inventory.csv'])).toEqual([])
    expect(detectCategories(['aerospace-notes.txt'])).toEqual([])
    expect(detectCategories(['monkeybusiness.dat'])).toEqual([])
    expect(detectCategories(['capacity-plan.md'])).toEqual([])
  })

  test('an .apk is rev, not an archive under misc; an .elf is pwn, not rev', () => {
    expect(detectCategories(['app.apk'])).toEqual(['rev'])
    expect(detectCategories(['chall.elf'])).toEqual(['pwn'])
    expect(detectCategories(['chall'])).toEqual([])
  })

  test('a mixed bag returns every matched category in the fixed registry order', () => {
    expect(detectCategories(['photo.png', 'chall.elf'])).toEqual(['pwn', 'stego'])
    expect(detectCategories(['chall.elf', 'photo.png'])).toEqual(['pwn', 'stego'])
    expect(detectCategories(['photo.png', 'flag.enc', 'capture.pcap', 'random-file'])).toEqual(['crypto', 'stego', 'misc'])
  })

  test('is order-independent and never returns a duplicate', () => {
    const hints = ['chall.elf', 'ret2win', 'pwnme', 'ROP chain']
    const first = detectCategories(hints)
    const second = detectCategories([...hints].reverse())
    expect(first).toEqual(second)
    expect(first).toEqual(['pwn'])
    expect(new Set(first).size).toBe(first.length)
  })

  test('ignores non-string and blank entries instead of throwing', () => {
    const dirty = ['chall.elf', '', '   ', null, undefined, 7, {}] as unknown as string[]
    expect(detectCategories(dirty)).toEqual(['pwn'])
  })
})
