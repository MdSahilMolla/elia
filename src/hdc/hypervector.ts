/**
 * Hyperdimensional computing: binary spatter codes.
 *
 * A hypervector is a random-looking vector of D bits. In ten thousand
 * dimensions two random ones agree on almost exactly half their bits, so every
 * symbol elia ever names gets a vector that is, for practical purposes,
 * orthogonal to every other. Three operations then build structure out of
 * them without ever growing the vector:
 *
 * - bind (XOR) pairs two things into one that resembles neither: a role and
 *   its filler, a position and a character. It is its own inverse, so
 *   binding with the role again gives back the filler.
 * - bundle (a bitwise majority) makes a set: the result stays similar to every
 *   member and unrelated to anything else, up to a capacity.
 * - permute (a cyclic rotation) marks order: `permute(a, 1)` is unrelated to
 *   `a`, so "ab" and "ba" encode differently.
 *
 * Similarity is 1 − 2·hamming/D: 1 for the same vector, about 0 for unrelated
 * ones (standard deviation 1/√D ≈ 0.01 at this size), −1 for the complement.
 *
 * This is the representation AION built its memory on, done in plain
 * TypeScript on packed 32-bit words: bind, bundle and similarity are a few
 * hundred word operations each. Symbols are derived from a hash of their name,
 * not from a random draw, so the same word means the same vector in every
 * process and a stored vector can be read back tomorrow.
 *
 * Nothing here decides anything. It is a way to compare structured things by
 * how much they share; what counts as "the same idea" is decided by whatever
 * uses it (evolve/ideas.ts), with a threshold measured on real records.
 */

/** Bits per hypervector: 314 words of 32. */
export const DIMENSIONS = 10_048
const WORDS = DIMENSIONS / 32

export interface Hypervector {
  readonly words: Uint32Array
}

// --- Deterministic randomness ------------------------------------------------

/** A 32-bit seed from a string (xmur3). */
function seedOf(text: string): number {
  let hash = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^= hash >>> 16) >>> 0
}

/** A 32-bit generator (mulberry32). Fast, well mixed, and reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (value ^ (value >>> 14)) >>> 0
  }
}

function fromGenerator(next: () => number): Hypervector {
  const words = new Uint32Array(WORDS)
  for (let index = 0; index < WORDS; index += 1) words[index] = next()
  return { words }
}

/** A fresh random hypervector from a numeric seed. For tests and simulations; symbols use `symbol`. */
export function randomHypervector(seed: number): Hypervector {
  return fromGenerator(generator(seed))
}

const symbols = new Map<string, Hypervector>()
const SYMBOL_CACHE_LIMIT = 50_000

/**
 * The hypervector for a name. The same name gives the same vector in every
 * process, and different names give unrelated ones.
 */
export function symbol(name: string): Hypervector {
  const cached = symbols.get(name)
  if (cached) return cached
  const vector = fromGenerator(generator(seedOf(`hdc:${name}`)))
  if (symbols.size >= SYMBOL_CACHE_LIMIT) symbols.clear()
  symbols.set(name, vector)
  return vector
}

// --- Algebra -----------------------------------------------------------------

export function bind(a: Hypervector, b: Hypervector): Hypervector {
  const words = new Uint32Array(WORDS)
  for (let index = 0; index < WORDS; index += 1) words[index] = a.words[index]! ^ b.words[index]!
  return { words }
}

/** Binding is its own inverse: `unbind(bind(role, filler), role)` is `filler`, exactly. */
export const unbind = bind

/** Rotates by `shift` bits (negative rotates back), so order can be encoded. */
export function permute(vector: Hypervector, shift = 1): Hypervector {
  const bits = ((shift % DIMENSIONS) + DIMENSIONS) % DIMENSIONS
  if (bits === 0) return { words: vector.words.slice() }
  const wordShift = Math.floor(bits / 32)
  const bitShift = bits % 32
  const words = new Uint32Array(WORDS)
  for (let index = 0; index < WORDS; index += 1) {
    const source = vector.words[index]!
    const target = (index + wordShift) % WORDS
    words[target] = (words[target]! | (source << bitShift)) >>> 0
    if (bitShift > 0) {
      const spill = (target + 1) % WORDS
      words[spill] = (words[spill]! | (source >>> (32 - bitShift))) >>> 0
    }
  }
  return { words }
}

function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff
}

export function hamming(a: Hypervector, b: Hypervector): number {
  let distance = 0
  for (let index = 0; index < WORDS; index += 1) distance += popcount(a.words[index]! ^ b.words[index]!)
  return distance
}

/** 1 for identical, ~0 for unrelated, −1 for opposite. */
export function similarity(a: Hypervector, b: Hypervector): number {
  return 1 - (2 * hamming(a, b)) / DIMENSIONS
}

/**
 * A running bitwise majority. Members can be added one at a time and weighted,
 * so a memory can grow without keeping its members around.
 */
export class Bundle {
  private readonly counts = new Int32Array(DIMENSIONS)
  private total = 0

  add(vector: Hypervector, weight = 1): this {
    for (let index = 0; index < WORDS; index += 1) {
      const word = vector.words[index]!
      const base = index * 32
      for (let bit = 0; bit < 32; bit += 1) {
        this.counts[base + bit] = this.counts[base + bit]! + ((word >>> bit) & 1 ? weight : -weight)
      }
    }
    this.total += weight
    return this
  }

  get size(): number {
    return this.total
  }

  /**
   * The majority vector. A bit with no majority (an even split) takes the bit
   * of a fixed tie-breaker, the usual convention, so the result is
   * deterministic and ties add noise rather than bias.
   */
  toHypervector(): Hypervector {
    const tie = symbol('__bundle_tie__')
    const words = new Uint32Array(WORDS)
    for (let index = 0; index < WORDS; index += 1) {
      let word = 0
      const base = index * 32
      for (let bit = 0; bit < 32; bit += 1) {
        const count = this.counts[base + bit]!
        const set = count > 0 || (count === 0 && ((tie.words[index]! >>> bit) & 1) === 1)
        if (set) word |= 1 << bit
      }
      words[index] = word >>> 0
    }
    return { words }
  }
}

export function bundle(vectors: readonly Hypervector[]): Hypervector {
  const accumulator = new Bundle()
  for (const vector of vectors) accumulator.add(vector)
  return accumulator.toHypervector()
}

// --- Encoders ----------------------------------------------------------------

/** A set of names: similar to every member, so two sets are as similar as their overlap. */
export function encodeSet(items: Iterable<string>, space = 'item'): Hypervector {
  const unique = [...new Set(items)]
  if (unique.length === 0) return symbol(`${space}:__empty__`)
  return bundle(unique.map((item) => symbol(`${space}:${item}`)))
}

/**
 * Text as a bundle of character n-grams, each an ordered binding of its
 * letters. Two texts are as similar as the n-grams they share, so
 * "descriptions" still resembles "description", which a word match would miss,
 * and word order inside an n-gram counts.
 */
export function encodeText(text: string, n = 3): Hypervector {
  const normalised = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  if (normalised.trim().length === 0) return symbol('text:__empty__')
  const grams = new Map<string, number>()
  for (let index = 0; index + n <= normalised.length; index += 1) {
    const gram = normalised.slice(index, index + n)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  const accumulator = new Bundle()
  for (const [gram, count] of grams) accumulator.add(ngram(gram), count)
  return accumulator.toHypervector()
}

const ngrams = new Map<string, Hypervector>()

function ngram(gram: string): Hypervector {
  const cached = ngrams.get(gram)
  if (cached) return cached
  let vector = permute(symbol(`char:${gram[0]}`), gram.length - 1)
  for (let index = 1; index < gram.length; index += 1) vector = bind(vector, permute(symbol(`char:${gram[index]}`), gram.length - 1 - index))
  if (ngrams.size >= SYMBOL_CACHE_LIMIT) ngrams.clear()
  ngrams.set(gram, vector)
  return vector
}

/**
 * A structured record: each field's value bound to its role, all bundled.
 * `unbind(record, symbol('role:x'))` is a noisy copy of field x, which
 * `cleanup` turns back into the value it was.
 */
export function encodeRecord(fields: Readonly<Record<string, Hypervector>>): Hypervector {
  return bundle(Object.entries(fields).map(([role, value]) => bind(symbol(`role:${role}`), value)))
}

export function field(record: Hypervector, role: string): Hypervector {
  return unbind(record, symbol(`role:${role}`))
}

/** The known item most similar to a noisy vector, with its similarity. */
export function cleanup<T>(noisy: Hypervector, items: ReadonlyArray<{ item: T; vector: Hypervector }>): { item: T; similarity: number } | undefined {
  let best: { item: T; similarity: number } | undefined
  for (const candidate of items) {
    const score = similarity(noisy, candidate.vector)
    if (!best || score > best.similarity) best = { item: candidate.item, similarity: score }
  }
  return best
}

// --- Persistence ---------------------------------------------------------------

/** Base64 of the packed words, for storing a vector in JSON. */
export function serialize(vector: Hypervector): string {
  return Buffer.from(vector.words.buffer, vector.words.byteOffset, vector.words.byteLength).toString('base64')
}

export function deserialize(text: string): Hypervector {
  const bytes = Buffer.from(text, 'base64')
  if (bytes.byteLength !== WORDS * 4) throw new Error(`a hypervector is ${WORDS * 4} bytes, this is ${bytes.byteLength}`)
  const words = new Uint32Array(WORDS)
  for (let index = 0; index < WORDS; index += 1) words[index] = bytes.readUInt32LE(index * 4)
  return { words }
}
