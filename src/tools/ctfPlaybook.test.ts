import { describe, expect, test } from 'bun:test'
import { ctfPlaybookTool, renderIndex, renderPlaybook, reportPlaybook } from './ctfPlaybook.ts'
import { PLAYBOOKS, PLAYBOOK_CATEGORIES, type PlaybookCategory } from '../security/playbooks/index.ts'

/**
 * The tool is read-only and pure, so every assertion here runs with no toolchain
 * and no network. The two things worth guarding hard are (a) the default path
 * stays short, since it is the one that gets called before the challenge is even
 * read, and (b) no category renders an empty or stubbed page.
 */

const CATEGORIES: PlaybookCategory[] = ['pwn', 'rev', 'crypto', 'stego', 'misc']

/** Below this a rendered playbook is a stub rather than a procedure. */
const MIN_PLAYBOOK_CHARS = 2_500
const MIN_STEP_HEADINGS = 5

describe('the tool surface', () => {
  test('is named ctf_playbook and declares a category enum on its schema', () => {
    expect(ctfPlaybookTool.name).toBe('ctf_playbook')
    expect(ctfPlaybookTool.input_schema.properties.category).toMatchObject({
      type: 'string',
      enum: CATEGORIES,
    })
    expect(ctfPlaybookTool.input_schema.properties.hints).toMatchObject({ type: 'array' })
  })

  test('routes through execute, not just the exported helper', async () => {
    const viaTool = await ctfPlaybookTool.execute({ category: 'crypto' })
    const viaHelper = await reportPlaybook({ category: 'crypto' })
    expect(viaTool).toBe(viaHelper)
  })
})

describe('the default path is the index, and the index is short', () => {
  test('no arguments renders every category with its summary and a detect line', async () => {
    const index = await ctfPlaybookTool.execute({})
    for (const category of CATEGORIES) {
      expect(index).toContain(`## ${category}`)
      expect(index).toContain(PLAYBOOKS[category].summary)
      expect(index).toContain(`- detect: ${PLAYBOOKS[category].detect[0]}`)
    }
    expect(index).toContain('# CTF playbooks — index')
  })

  test('the all-categories index is shorter than a single full playbook', async () => {
    const index = renderIndex()
    for (const category of CATEGORIES) {
      expect(index.length).toBeLessThan(renderPlaybook(PLAYBOOKS[category]).length)
    }
  })

  test('the index carries no command blocks — that is the whole point of it being short', () => {
    expect(renderIndex()).not.toContain('```')
  })

  test('empty strings count as absent, not as an invalid category', async () => {
    const index = await ctfPlaybookTool.execute({ category: '', hints: [] })
    expect(index).toContain('# CTF playbooks — index')
  })
})

describe('a single category renders a full procedure', () => {
  test('commands are fenced and the gotchas heading is present', async () => {
    const crypto = await ctfPlaybookTool.execute({ category: 'crypto' })
    expect(crypto).toContain('```sh')
    expect(crypto).toContain('## Gotchas')
    expect(crypto).toMatch(/### \d+\. /)
  })

  test('every category renders with headings, fenced commands, gotchas and a success shape', async () => {
    for (const category of CATEGORIES) {
      const rendered = renderPlaybook(PLAYBOOKS[category])
      expect(rendered).toContain(`# CTF playbook: ${category}`)
      expect(rendered).toContain('## When this is the right category')
      expect(rendered).toContain('## Triage sequence')
      expect(rendered).toContain('## Gotchas')
      expect(rendered).toContain('## What solved looks like')
      expect(rendered).toContain('```sh')
      expect(rendered).toContain('ctf_toolchain')
    }
  })

  test('every rendered playbook is substantial — a stub cannot pass this', async () => {
    for (const category of CATEGORIES) {
      const rendered = await ctfPlaybookTool.execute({ category })
      expect(rendered.length).toBeGreaterThan(MIN_PLAYBOOK_CHARS)
      // Every step title from the data is rendered as a numbered heading.
      const headings = rendered.match(/### \d+\. /g) ?? []
      expect(headings.length).toBe(PLAYBOOKS[category].steps.length)
      expect(headings.length).toBeGreaterThanOrEqual(MIN_STEP_HEADINGS)
      // And every command in the data is present in the render.
      const commands = PLAYBOOKS[category].steps.flatMap((step) => step.commands ?? [])
      for (const command of commands) expect(rendered).toContain(command)
    }
  })

  test('numbering is sequential from 1, not a placeholder or a repeat', async () => {
    for (const category of CATEGORIES) {
      const rendered = renderPlaybook(PLAYBOOKS[category])
      const numbers = [...rendered.matchAll(/### (\d+)\. /g)].map((match) => Number(match[1]))
      expect(numbers).toEqual(PLAYBOOKS[category].steps.map((_, index) => index + 1))
    }
  })

  test('a category carries only its own content', async () => {
    const pwn = await ctfPlaybookTool.execute({ category: 'pwn' })
    expect(pwn).toContain('### 1. ')
    for (const other of CATEGORIES) {
      if (other === 'pwn') continue
      expect(pwn).not.toContain(`# CTF playbook: ${other}`)
    }
  })
})

describe('the hints path', () => {
  test('names the suggested category and says why it was suggested', async () => {
    const rev = await ctfPlaybookTool.execute({ hints: ['app.apk'] })
    expect(rev).toContain('app.apk')
    expect(rev).toMatch(/rev/)
    expect(rev).toContain('# CTF playbook: rev')
    expect(rev).toContain('heuristic')
  })

  test('suggests each category from a representative hint', async () => {
    const cases: Array<[string[], PlaybookCategory]> = [
      [['chall.elf', 'ret2win'], 'pwn'],
      [['app.apk'], 'rev'],
      [['cipher.txt'], 'crypto'],
      [['photo.png'], 'stego'],
      [['capture.pcap'], 'misc'],
    ]
    for (const [hints, category] of cases) {
      const rendered = await ctfPlaybookTool.execute({ hints })
      expect(rendered).toContain(`# CTF playbook: ${category}`)
      expect(rendered).toContain(PLAYBOOKS[category].summary)
    }
  })

  test('a mixed bag renders every suggested category, each once', async () => {
    const rendered = await ctfPlaybookTool.execute({ hints: ['photo.png', 'chall.elf'] })
    expect(rendered.split('# CTF playbook: pwn').length - 1).toBe(1)
    expect(rendered.split('# CTF playbook: stego').length - 1).toBe(1)
  })

  test('no match says so plainly and still hands over the index rather than an empty page', async () => {
    const rendered = await ctfPlaybookTool.execute({ hints: ['zzzz-not-a-hint-9182'] })
    expect(rendered).toContain('no category matched')
    expect(rendered).toContain('zzzz-not-a-hint-9182')
    expect(rendered.length).toBeGreaterThan(renderIndex().length)
    for (const category of CATEGORIES) expect(rendered).toContain(`## ${category}`)
  })

  test('a bare string and a numeric hint are both accepted; an object is a real mistake', async () => {
    expect(await ctfPlaybookTool.execute({ hints: 'chall.elf' })).toContain('# CTF playbook: pwn')
    expect(await ctfPlaybookTool.execute({ hints: [7] })).toContain('no category matched')
    await expect(ctfPlaybookTool.execute({ hints: [{ file: 'a' }] })).rejects.toThrow(/hints must be an array of strings/)
  })

  test('a category wins over hints when both are given', async () => {
    const rendered = await ctfPlaybookTool.execute({ category: 'stego', hints: ['chall.elf'] })
    expect(rendered).toContain('# CTF playbook: stego')
    expect(rendered).not.toContain('# CTF playbook: pwn')
  })
})

describe('bad input fails loudly', () => {
  test('an unknown category throws and names the valid ones', async () => {
    await expect(ctfPlaybookTool.execute({ category: 'forensics' })).rejects.toThrow(
      /category must be one of: pwn, rev, crypto, stego, misc — got "forensics"/,
    )
  })

  test('a wrong-typed category throws rather than being coerced', async () => {
    await expect(ctfPlaybookTool.execute({ category: 7 })).rejects.toThrow(/category must be a string/)
    await expect(ctfPlaybookTool.execute({ category: { name: 'pwn' } })).rejects.toThrow(/category must be a string/)
  })

  test('category casing is not silently normalised', async () => {
    await expect(ctfPlaybookTool.execute({ category: 'PWN' })).rejects.toThrow(/category must be one of/)
  })
})

describe('rendering is deterministic and never empty', () => {
  test('the same input renders byte-identical output', async () => {
    for (const category of PLAYBOOK_CATEGORIES) {
      const first = await reportPlaybook({ category })
      const second = await reportPlaybook({ category })
      expect(first).toBe(second)
    }
  })

  test('no category is missing from the registry or renders blank', () => {
    for (const category of PLAYBOOK_CATEGORIES) {
      const playbook = PLAYBOOKS[category]
      expect(playbook).toBeDefined()
      const rendered = renderPlaybook(playbook)
      expect(rendered.trim().length).toBeGreaterThan(MIN_PLAYBOOK_CHARS)
      expect(rendered).not.toContain('TODO')
      expect(rendered).not.toContain('placeholder')
      expect(rendered).not.toMatch(/step\.title/)
    }
  })
})
