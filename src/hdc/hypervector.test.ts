import { expect, test } from 'bun:test'
import {
  bind,
  Bundle,
  bundle,
  cleanup,
  deserialize,
  DIMENSIONS,
  encodeRecord,
  encodeSet,
  encodeText,
  field,
  hamming,
  permute,
  randomHypervector,
  serialize,
  similarity,
  symbol,
  unbind,
} from './hypervector.ts'

/** Five standard deviations of the similarity of two unrelated vectors. */
const NOISE = 5 / Math.sqrt(DIMENSIONS)

test('random vectors are quasi-orthogonal, and a vector is identical to itself', () => {
  const vectors = Array.from({ length: 20 }, (_, index) => randomHypervector(index + 1))
  for (let a = 0; a < vectors.length; a += 1) {
    expect(similarity(vectors[a]!, vectors[a]!)).toBe(1)
    for (let b = a + 1; b < vectors.length; b += 1) expect(Math.abs(similarity(vectors[a]!, vectors[b]!))).toBeLessThan(NOISE)
  }
})

test('a symbol is the same vector in every call and every process, and names do not collide', () => {
  expect(serialize(symbol('read_file'))).toBe(serialize(symbol('read_file')))
  // Pinned: if the hash or generator changes, stored vectors stop meaning what they meant.
  expect(serialize(symbol('read_file')).slice(0, 24)).toBe('NHoQzim0VauzKhxlKETQmXNm')
  expect(Math.abs(similarity(symbol('read_file'), symbol('read_files')))).toBeLessThan(NOISE)
})

test('binding resembles neither side and is its own inverse', () => {
  const role = symbol('role:file')
  const filler = symbol('src/config.ts')
  const bound = bind(role, filler)
  expect(Math.abs(similarity(bound, role))).toBeLessThan(NOISE)
  expect(Math.abs(similarity(bound, filler))).toBeLessThan(NOISE)
  expect(similarity(unbind(bound, role), filler)).toBe(1)
})

test('a rotation is unrelated to the original and undone by rotating back', () => {
  const vector = symbol('order')
  for (const shift of [1, 7, 32, 33, 5_000, DIMENSIONS - 1]) {
    expect(Math.abs(similarity(permute(vector, shift), vector))).toBeLessThan(NOISE)
    expect(similarity(permute(permute(vector, shift), -shift), vector)).toBe(1)
  }
  expect(similarity(permute(vector, DIMENSIONS), vector)).toBe(1)
  expect(hamming(permute(vector, 3), vector)).toBeGreaterThan(0)
})

test('a bundle stays similar to its members, as the majority-rule capacity predicts, and not to others', () => {
  for (const size of [3, 7, 21, 51]) {
    const members = Array.from({ length: size }, (_, index) => randomHypervector(1_000 + size * 100 + index))
    const set = bundle(members)
    // Expected member similarity for a majority of k random vectors is about √(2/(πk)).
    const expected = Math.sqrt(2 / (Math.PI * size))
    for (const member of members) expect(similarity(set, member)).toBeGreaterThan(expected - 6 / Math.sqrt(DIMENSIONS))
    expect(Math.abs(similarity(set, randomHypervector(99_999)))).toBeLessThan(NOISE)
  }
})

test('a weighted, incremental bundle equals the batch one', () => {
  const [a, b, c] = [symbol('a'), symbol('b'), symbol('c')]
  const incremental = new Bundle().add(a).add(b).add(c).toHypervector()
  expect(similarity(incremental, bundle([a, b, c]))).toBe(1)
  const heavy = new Bundle().add(a, 3).add(b).add(c).toHypervector()
  expect(similarity(heavy, a)).toBe(1)
})

test('sets are as similar as their overlap', () => {
  const same = similarity(encodeSet(['a.ts', 'b.ts', 'c.ts']), encodeSet(['c.ts', 'a.ts', 'b.ts']))
  const most = similarity(encodeSet(['a.ts', 'b.ts', 'c.ts']), encodeSet(['a.ts', 'b.ts', 'd.ts']))
  const some = similarity(encodeSet(['a.ts', 'b.ts', 'c.ts']), encodeSet(['a.ts']))
  const none = similarity(encodeSet(['a.ts', 'b.ts', 'c.ts']), encodeSet(['x.ts', 'y.ts']))
  expect(same).toBe(1)
  expect(most).toBeGreaterThan(some)
  expect(some).toBeGreaterThan(none)
  expect(Math.abs(none)).toBeLessThan(NOISE)
})

test('text is compared by shared character n-grams, so word forms and near-rewordings still match', () => {
  const a = encodeText('Shorten the read_file tool description')
  expect(similarity(a, encodeText('shorten the READ_FILE tool description!'))).toBe(1)
  const reworded = similarity(a, encodeText('Shorten tool descriptions for read_file'))
  const related = similarity(a, encodeText('Improve tool descriptions for parallel batching'))
  const unrelated = similarity(a, encodeText('Add a retry to the payment webhook handler'))
  expect(reworded).toBeGreaterThan(related)
  expect(related).toBeGreaterThan(unrelated)
  expect(reworded).toBeGreaterThan(0.4)
  expect(unrelated).toBeLessThan(0.15)
  // Order inside an n-gram counts: an anagram is not the same text.
  expect(similarity(encodeText('abc'), encodeText('cba'))).toBeLessThan(0.5)
})

test('a record gives each field back through its role, recovered from a codebook by cleanup', () => {
  const files = ['src/config.ts', 'src/agentLoop.ts', 'src/tools/readFile.ts', 'src/autonomy/roles.ts', 'src/subagent.ts']
  const verdicts = ['promoted', 'rejected', 'not-judged']
  const codebook = [...files.map((item) => ({ item, vector: symbol(item) })), ...verdicts.map((item) => ({ item, vector: symbol(item) }))]
  for (const [file, verdict] of [['src/tools/readFile.ts', 'rejected'], ['src/subagent.ts', 'promoted']] as const) {
    const record = encodeRecord({ file: symbol(file), verdict: symbol(verdict), area: symbol('tools'), strategy: symbol('default-v2'), generation: symbol('13') })
    expect(cleanup(field(record, 'file'), codebook)?.item).toBe(file)
    expect(cleanup(field(record, 'verdict'), codebook)?.item).toBe(verdict)
  }
})

test('a vector survives serialization, and a wrong-sized one is refused', () => {
  const vector = encodeText('round trip')
  expect(similarity(deserialize(serialize(vector)), vector)).toBe(1)
  expect(() => deserialize('AAAA')).toThrow('bytes')
})
