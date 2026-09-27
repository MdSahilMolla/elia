import type { Rng } from './rng.ts'
import { kMeans, nmf } from './ml/unsupervised.ts'
import { mean } from './stats/describe.ts'

/**
 * Text analytics with deterministic methods: tokenisation, n-grams, TF-IDF keywords,
 * heuristic language identification, a lexicon sentiment baseline, NMF topics, document
 * clustering, lexical similarity search, extractive summaries, and pattern-based entity
 * extraction. Neural NER, abstractive summarisation, and semantic embeddings need a model
 * (the mode's LLM or a Python transformer); their outputs are then evaluated with
 * ds_ml llm_eval rather than trusted as ground truth.
 */

const STOPWORDS: Record<string, string[]> = {
  en: 'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just me more most my no not of on or our out over she so some than that the their them then there these they this to too up us was we were what when where which who why will with would you your'.split(' '),
  es: 'a al algo como con de del el ella ellos en es esta este fue ha hay la las lo los mas me mi muy no nos o para pero por que se si sin sobre su sus te tu un una uno y ya'.split(' '),
  fr: 'a au aux avec ce ces dans de des du elle en est et il ils je la le les leur lui ma mais me mes mon ne nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vous y'.split(' '),
  de: 'aber als am an auch auf aus bei bin bis das dass dem den der des die du ein eine einem einen einer es für hat ich ihr im in ist ja kein mit nach nicht noch nur oder sie sind so und uns von war was wie wir zu zum zur'.split(' '),
  pt: 'a ao aos as com como da das de do dos e ela ele em entre era essa esse esta este eu foi isso mais mas me meu minha muito na nas no nos o os ou para pela pelo por que se sem seu sua também um uma você'.split(' '),
  it: 'a ad al alla alle anche che chi ci come con da dal dei del della di e gli ha ho i il in io la le lo ma mi nel no non per più questo se si sono su tu un una uno'.split(' '),
  nl: 'aan al als bij dan dat de die dit door een en er had heb het hij hoe ik in is je kan maar me met mij na naar niet nog nu of om ook op over te tot u uit van voor was wat we wel wie zij zijn'.split(' '),
}
const STOP = new Set(STOPWORDS.en)

// A compact general-purpose sentiment lexicon (AFINN-style polarity, −3..+3), for a transparent baseline only.
const LEXICON: Record<string, number> = Object.fromEntries([
  ...'good:2 great:3 excellent:3 amazing:3 awesome:3 love:3 loved:3 like:2 liked:2 happy:3 pleased:2 satisfied:2 fantastic:3 wonderful:3 best:3 better:2 perfect:3 nice:2 fast:1 quick:1 easy:1 helpful:2 friendly:2 recommend:2 recommended:2 fine:1 smooth:1 reliable:2 impressive:3 enjoy:2 enjoyed:2 beautiful:3 superb:3 outstanding:3 brilliant:3 clean:1 comfortable:2 affordable:1 worth:2 thanks:2 thank:2 glad:2 delighted:3 positive:2 resolved:2 works:1 working:1'.split(' ').map((pair) => pair.split(':') as [string, string]),
  ...'bad:-2 terrible:-3 awful:-3 horrible:-3 hate:-3 hated:-3 poor:-2 worst:-3 worse:-2 slow:-1 broken:-2 bug:-1 bugs:-1 crash:-2 crashed:-2 crashes:-2 disappointed:-2 disappointing:-2 useless:-3 annoying:-2 angry:-3 unhappy:-2 problem:-1 problems:-1 issue:-1 issues:-1 fail:-2 failed:-2 failure:-2 fails:-2 difficult:-1 hard:-1 expensive:-1 overpriced:-2 rude:-2 dirty:-2 late:-1 delay:-1 delayed:-1 missing:-1 wrong:-2 refund:-1 cancel:-1 cancelled:-1 complaint:-2 never:-1 error:-2 errors:-2 confusing:-2 frustrating:-2 frustrated:-2 waste:-2 scam:-3 lost:-2 unusable:-3'.split(' ').map((pair) => pair.split(':') as [string, string]),
].map(([word, score]) => [word, Number(score)]))
const NEGATORS = new Set(['not', 'no', 'never', "n't", 'hardly', 'without', 'dont', "don't", 'isnt', "isn't", 'wasnt', "wasn't", 'cannot', "can't"])
const INTENSIFIERS: Record<string, number> = { very: 1.5, really: 1.4, extremely: 1.8, so: 1.3, super: 1.5, totally: 1.4, quite: 1.2, slightly: 0.6, somewhat: 0.7 }

export function tokenize(text: string, options: { lowercase?: boolean; stopwords?: boolean; minLength?: number } = {}): string[] {
  const normalized = text.normalize('NFKC')
  const tokens = (options.lowercase ?? true ? normalized.toLowerCase() : normalized).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []
  return tokens.filter((token) => token.length >= (options.minLength ?? 1) && !(options.stopwords && STOP.has(token)))
}

export function ngrams(tokens: string[], n: number): string[] {
  return tokens.slice(0, Math.max(0, tokens.length - n + 1)).map((_, index) => tokens.slice(index, index + n).join(' '))
}

export function detectLanguage(text: string): { language: string; confidence: number; method: string } {
  const tokens = tokenize(text)
  if (tokens.length < 3) return { language: 'unknown', confidence: 0, method: 'too short' }
  const scores = Object.entries(STOPWORDS).map(([language, words]) => { const set = new Set(words); return { language, hits: tokens.filter((token) => set.has(token)).length } }).sort((a, b) => b.hits - a.hits)
  const total = scores.reduce((sum, entry) => sum + entry.hits, 0)
  if (scores[0]!.hits === 0) return { language: 'unknown', confidence: 0, method: 'stopword overlap (en, es, fr, de, pt, it, nl only)' }
  return { language: scores[0]!.language, confidence: scores[0]!.hits / total, method: 'stopword overlap (en, es, fr, de, pt, it, nl only) — a heuristic' }
}

export function sentiment(text: string): { score: number; comparative: number; label: 'positive' | 'negative' | 'neutral'; hits: Array<{ word: string; score: number }> } {
  const tokens = tokenize(text)
  let score = 0
  const hits: Array<{ word: string; score: number }> = []
  tokens.forEach((token, index) => {
    const base = LEXICON[token]
    if (base === undefined) return
    let value = base
    const window = tokens.slice(Math.max(0, index - 3), index)
    if (window.some((word) => NEGATORS.has(word) || word.endsWith("n't"))) value = -value * 0.75
    const intensifier = tokens[index - 1] ? INTENSIFIERS[tokens[index - 1]!] : undefined
    if (intensifier) value *= intensifier
    score += value
    hits.push({ word: token, score: value })
  })
  const comparative = tokens.length ? score / tokens.length : 0
  return { score, comparative, label: score >= 1 ? 'positive' : score <= -1 ? 'negative' : 'neutral', hits }
}

export interface TfIdf {
  vocabulary: string[]
  idf: number[]
  vectors: Array<Map<number, number>>
}

export function tfidf(documents: string[], options: { maxFeatures?: number; ngram?: 1 | 2; minDocuments?: number } = {}): TfIdf {
  const docs = documents.map((doc) => { const tokens = tokenize(doc, { stopwords: true, minLength: 2 }); return options.ngram === 2 ? [...tokens, ...ngrams(tokens, 2)] : tokens })
  const df = new Map<string, number>()
  for (const tokens of docs) for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1)
  const minDocuments = options.minDocuments ?? (documents.length > 50 ? 2 : 1)
  const vocabulary = [...df.entries()].filter(([, count]) => count >= minDocuments && count <= 0.9 * documents.length + 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, options.maxFeatures ?? 2000).map(([term]) => term)
  const index = new Map(vocabulary.map((term, i) => [term, i]))
  const idf = vocabulary.map((term) => Math.log((1 + documents.length) / (1 + df.get(term)!)) + 1)
  const vectors = docs.map((tokens) => {
    const counts = new Map<number, number>()
    for (const token of tokens) { const i = index.get(token); if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1) }
    let norm = 0
    for (const [i, count] of counts) { const value = count * idf[i]!; counts.set(i, value); norm += value * value }
    norm = Math.sqrt(norm) || 1
    for (const [i, value] of counts) counts.set(i, value / norm)
    return counts
  })
  return { vocabulary, idf, vectors }
}

export function cosine(a: Map<number, number>, b: Map<number, number>): number {
  let total = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const [i, value] of small) total += value * (large.get(i) ?? 0)
  return total
}

export function keywords(documents: string[], top = 15, groups?: string[]): Array<{ group: string; terms: Array<{ term: string; score: number }> }> {
  const model = tfidf(documents, { ngram: 2 })
  const keys = groups ? [...new Set(groups)] : ['all']
  return keys.map((group) => {
    const members = model.vectors.filter((_, i) => !groups || groups[i] === group)
    const totals = new Map<number, number>()
    for (const vector of members) for (const [i, value] of vector) totals.set(i, (totals.get(i) ?? 0) + value)
    return { group, terms: [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([i, score]) => ({ term: model.vocabulary[i]!, score: score / members.length })) }
  })
}

function dense(model: TfIdf): number[][] {
  return model.vectors.map((vector) => { const row = new Array<number>(model.vocabulary.length).fill(0); for (const [i, value] of vector) row[i] = value; return row })
}

export function topics(documents: string[], k: number, rng: Rng, termsPerTopic = 10): { topics: Array<{ topic: number; terms: string[]; weight: number }>; assignments: number[]; method: string } {
  if (documents.length > 20_000) throw new Error('topic modelling here uses dense NMF; sample to at most 20,000 documents')
  const model = tfidf(documents, { maxFeatures: 1500 })
  if (model.vocabulary.length < k) throw new Error('vocabulary is too small for this many topics')
  const { W, H } = nmf(dense(model), k, rng, 200)
  const weights = H.map((_, t) => mean(W.map((row) => row[t]!)))
  return {
    topics: H.map((row, t) => ({ topic: t, terms: row.map((value, i) => ({ value, i })).sort((a, b) => b.value - a.value).slice(0, termsPerTopic).map(({ i }) => model.vocabulary[i]!), weight: weights[t]! })),
    assignments: W.map((row) => row.indexOf(Math.max(...row))),
    method: 'NMF on TF-IDF (unigrams, English stopwords removed); topics are word co-occurrence patterns that need human labelling',
  }
}

export function clusterDocuments(documents: string[], k: number, rng: Rng): { labels: number[]; clusters: Array<{ cluster: number; size: number; terms: string[] }> } {
  const model = tfidf(documents, { maxFeatures: 1500 })
  const matrix = dense(model)
  const result = kMeans(matrix, k, rng)
  return { labels: result.labels, clusters: result.centroids.map((centroid, c) => ({ cluster: c, size: result.sizes[c]!, terms: centroid.map((value, i) => ({ value, i })).sort((a, b) => b.value - a.value).slice(0, 8).map(({ i }) => model.vocabulary[i]!) })) }
}

export function search(documents: string[], query: string, top = 10): Array<{ index: number; score: number; snippet: string }> {
  const model = tfidf([...documents, query], { minDocuments: 1 })
  const q = model.vectors.at(-1)!
  return model.vectors.slice(0, -1).map((vector, index) => ({ index, score: cosine(vector, q), snippet: documents[index]!.slice(0, 200) })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, top)
}

export function extractiveSummary(text: string, sentences = 3): { summary: string[]; method: string } {
  const parts = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map((sentence) => sentence.trim()).filter((sentence) => sentence.split(' ').length >= 4)
  if (parts.length <= sentences) return { summary: parts, method: 'the text has no more sentences than requested' }
  const model = tfidf(parts, { minDocuments: 1 })
  const centrality = model.vectors.map((vector) => model.vectors.reduce((total, other) => total + cosine(vector, other), 0))
  const chosen = centrality.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score).slice(0, sentences).sort((a, b) => a.index - b.index)
  return { summary: chosen.map(({ index }) => parts[index]!), method: 'extractive: the sentences most similar to the rest of the text (TF-IDF centrality); no new text is generated' }
}

const ENTITY_PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  url: /https?:\/\/[^\s)]+/g,
  money: /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|JPY)\b)/gi,
  percentage: /\b\d+(?:\.\d+)?\s?%/g,
  date: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:, \d{4})?)\b/gi,
  phone: /\+?\d[\d\s().-]{7,}\d/g,
  hashtag: /#[\p{L}\p{N}_]+/gu,
  mention: /@[\w]+/g,
}

export function extractEntities(text: string, kinds: string[] = Object.keys(ENTITY_PATTERNS)): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const kind of kinds) {
    const pattern = ENTITY_PATTERNS[kind]
    if (!pattern) throw new Error(`unknown entity kind "${kind}"; available: ${Object.keys(ENTITY_PATTERNS).join(', ')}`)
    out[kind] = [...new Set(text.match(pattern) ?? [])].slice(0, 200)
  }
  return out
}

export const ENTITY_KINDS = Object.keys(ENTITY_PATTERNS)
