import { encodeSet, encodeText, similarity, type Hypervector } from '../hdc/hypervector.ts'
import { judgementOf, type GenerationRecord, type Judgement } from './ledger.ts'

/**
 * The improver's memory of its own ideas, in hypervectors.
 *
 * Every generation costs a full benchmark comparison, about eight million
 * tokens on this machine, and the proposer is already shown the whole ledger.
 * It still resubmits: generation 16 was generation 15 word for word, and 9 was
 * 7 reworded. Being shown a list is not the same as being stopped by it, so
 * this checks each submission the moment it is made, before anything is built
 * or measured.
 *
 * An idea is its title as a bundle of character trigrams (hdc/hypervector.ts),
 * so "Shorten tool descriptions for read_file…" and "Shorten read_file tool
 * description by ~40%…" land close together although they share few whole
 * words, and the files it names as a set. The decision rests on the text
 * alone. On this ledger the two real repeats scored 1.00 and 0.51, and the
 * closest pair of different ideas 0.28, so the threshold sits between. The
 * files overlap is reported but does not decide: generations 1 and 8 changed
 * the same file (speculation/cache.ts) for unrelated reasons. Two repeats is
 * little to calibrate on, and the threshold should move when the ledger says
 * so.
 *
 * Only a judged idea blocks (ledger.ts `judgementOf`). Generation 16 repeating
 * 15 was right, because 15 was never measured: the provider ran out of credit
 * halfway through. A repeat of an idea that was never judged is allowed and
 * said to be allowed.
 */

/** Text similarity at or above which a submission is the same idea. Measured; see above. */
export const SAME_IDEA = 0.4

export interface IdeaLike {
  hypothesis: string
  targetFiles?: readonly string[]
  changedFiles?: readonly string[]
}

interface Encoded {
  text: Hypervector
  files?: Hypervector
}

function encode(idea: IdeaLike): Encoded {
  const files = [...(idea.targetFiles ?? []), ...(idea.changedFiles ?? [])]
  return { text: encodeText(idea.hypothesis), ...(files.length > 0 ? { files: encodeSet(files, 'file') } : {}) }
}

export interface IdeaMatch {
  generation: number
  hypothesis: string
  /** How alike the titles are; this is what decides. */
  textSimilarity: number
  /** How alike the files are, when both name some. Context only. */
  filesSimilarity?: number
  judgement: Judgement
  why: string
}

/** Past generations most like this idea, closest first. */
export function similarIdeas(idea: IdeaLike, records: readonly GenerationRecord[], limit = 3): IdeaMatch[] {
  const mine = encode(idea)
  return records
    .filter((record) => record.hypothesis.trim().length > 0)
    .map((record) => {
      const theirs = encode(record)
      const { judgement, why } = judgementOf(record)
      return {
        generation: record.generation,
        hypothesis: record.hypothesis,
        textSimilarity: similarity(mine.text, theirs.text),
        ...(mine.files && theirs.files ? { filesSimilarity: similarity(mine.files, theirs.files) } : {}),
        judgement,
        why,
      }
    })
    .sort((a, b) => b.textSimilarity - a.textSimilarity)
    .slice(0, limit)
}

export interface IdeaVerdict {
  /** The closest past generation at or above the threshold, if any. */
  match?: IdeaMatch
  /** Present when the submission should go back to the proposer: it repeats a judged idea. */
  bounce?: string
}

/**
 * Whether a submitted hypothesis repeats an idea the ledger has already
 * judged, and if so what to tell the proposer.
 */
export function checkIdea(idea: IdeaLike, records: readonly GenerationRecord[]): IdeaVerdict {
  const judged = similarIdeas(idea, records, records.length).filter((entry) => entry.textSimilarity >= SAME_IDEA)
  const blocking = judged.find((entry) => entry.judgement !== 'not-judged')
  const match = blocking ?? judged[0]
  if (!match) return {}
  if (!blocking) return { match }
  const files = blocking.filesSimilarity === undefined ? '' : `, files ${percent(blocking.filesSimilarity)} alike`
  const outcome =
    blocking.judgement === 'promoted'
      ? `was promoted: it is already in the source you are reading`
      : `was measured and rejected: ${blocking.why}`
  return {
    match: blocking,
    bounce: [
      `This is the same idea as generation ${blocking.generation} ("${blocking.hypothesis}", titles ${percent(blocking.textSimilarity)} alike${files}), which ${outcome}.`,
      'Submit a different hypothesis. If this one really differs, submit it again with a rationale that says concretely what it changes that generation did not, and it will be accepted.',
    ].join(' '),
  }
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}
