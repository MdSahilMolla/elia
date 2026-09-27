import { createRng } from './rng.ts'
import { mean, quantileSorted } from './stats/describe.ts'
import { binomialCdf } from './stats/special.ts'
import { classificationMetrics } from './ml/metrics.ts'
import { tokenize } from './text.ts'

/**
 * Evaluation for LLM and generative-AI systems. LLM outputs are probabilistic, so they are
 * scored against references with deterministic metrics: classification quality,
 * structured-output validity, extractive QA exact match and token F1, ROUGE-L and BLEU,
 * retrieval ranking quality, lexical grounding of answers in their context (a hallucination
 * proxy), paired model comparisons with McNemar's test and a paired bootstrap, and
 * token/cost/latency profiles. Proxies are labelled as proxies.
 */

function normalizeAnswer(text: string): string[] {
  return tokenize(text.toLowerCase().replace(/\b(a|an|the)\b/g, ' '))
}

export function exactMatch(prediction: string, reference: string): number {
  return normalizeAnswer(prediction).join(' ') === normalizeAnswer(reference).join(' ') ? 1 : 0
}

export function tokenF1(prediction: string, reference: string): number {
  const p = normalizeAnswer(prediction)
  const r = normalizeAnswer(reference)
  if (!p.length || !r.length) return p.length === r.length ? 1 : 0
  const counts = new Map<string, number>()
  for (const token of r) counts.set(token, (counts.get(token) ?? 0) + 1)
  let overlap = 0
  for (const token of p) { const c = counts.get(token) ?? 0; if (c > 0) { overlap++; counts.set(token, c - 1) } }
  if (overlap === 0) return 0
  const precision = overlap / p.length
  const recall = overlap / r.length
  return (2 * precision * recall) / (precision + recall)
}

export function rougeL(prediction: string, reference: string): number {
  const p = tokenize(prediction)
  const r = tokenize(reference)
  if (!p.length || !r.length) return 0
  const dp = Array.from({ length: p.length + 1 }, () => new Array<number>(r.length + 1).fill(0))
  for (let i = 1; i <= p.length; i++) for (let j = 1; j <= r.length; j++) dp[i]![j] = p[i - 1] === r[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
  const lcs = dp[p.length]![r.length]!
  const precision = lcs / p.length
  const recall = lcs / r.length
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

export function bleu(prediction: string, references: string[], maxN = 4): number {
  const p = tokenize(prediction)
  if (!p.length) return 0
  const refs = references.map((reference) => tokenize(reference))
  let logPrecision = 0
  for (let n = 1; n <= maxN; n++) {
    const grams = new Map<string, number>()
    for (let i = 0; i + n <= p.length; i++) { const g = p.slice(i, i + n).join(' '); grams.set(g, (grams.get(g) ?? 0) + 1) }
    const maxRef = new Map<string, number>()
    for (const ref of refs) {
      const counts = new Map<string, number>()
      for (let i = 0; i + n <= ref.length; i++) { const g = ref.slice(i, i + n).join(' '); counts.set(g, (counts.get(g) ?? 0) + 1) }
      for (const [g, c] of counts) maxRef.set(g, Math.max(maxRef.get(g) ?? 0, c))
    }
    const total = Math.max(1, p.length - n + 1)
    let clipped = 0
    for (const [g, c] of grams) clipped += Math.min(c, maxRef.get(g) ?? 0)
    logPrecision += Math.log((clipped + 1) / (total + 1)) / maxN
  }
  const closest = refs.map((ref) => ref.length).sort((a, b) => Math.abs(a - p.length) - Math.abs(b - p.length))[0] ?? p.length
  const brevity = p.length >= closest ? 1 : Math.exp(1 - closest / p.length)
  return brevity * Math.exp(logPrecision)
}

/** Share of content tokens and of numbers in an answer that also occur in its context — a lexical grounding proxy. */
export function grounding(answer: string, context: string): { tokenSupport: number; unsupportedNumbers: string[]; numberSupport: number | null } {
  const contextTokens = new Set(tokenize(context, { stopwords: true }))
  const answerTokens = tokenize(answer, { stopwords: true })
  const support = answerTokens.length ? answerTokens.filter((token) => contextTokens.has(token)).length / answerTokens.length : 1
  const numbers = answer.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? []
  const normalizedContext = context.replace(/,/g, '')
  const unsupported = numbers.filter((number) => !normalizedContext.includes(number.replace(/,/g, '')))
  return { tokenSupport: support, unsupportedNumbers: unsupported, numberSupport: numbers.length ? 1 - unsupported.length / numbers.length : null }
}

export function retrievalMetrics(queries: Array<{ retrieved: string[]; relevant: string[] }>, k = 10): Record<string, number> {
  const recall: number[] = []; const precision: number[] = []; const mrr: number[] = []; const ndcg: number[] = []; const hit: number[] = []
  for (const { retrieved, relevant } of queries) {
    const rel = new Set(relevant)
    const top = retrieved.slice(0, k)
    const hits = top.filter((id) => rel.has(id)).length
    recall.push(rel.size ? hits / rel.size : 0)
    precision.push(hits / k)
    const first = top.findIndex((id) => rel.has(id))
    mrr.push(first < 0 ? 0 : 1 / (first + 1))
    hit.push(first < 0 ? 0 : 1)
    const dcg = top.reduce((total, id, rank) => total + (rel.has(id) ? 1 / Math.log2(rank + 2) : 0), 0)
    const idcg = Array.from({ length: Math.min(rel.size, k) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((a, b) => a + b, 0)
    ndcg.push(idcg ? dcg / idcg : 0)
  }
  return { [`recall@${k}`]: mean(recall), [`precision@${k}`]: mean(precision), mrr: mean(mrr), [`ndcg@${k}`]: mean(ndcg), [`hitRate@${k}`]: mean(hit), queries: queries.length }
}

export interface SchemaSpec { required?: string[]; types?: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>; enums?: Record<string, string[]> }

export function structuredOutputValidity(outputs: string[], schema: SchemaSpec): { validJson: number; schemaValid: number; failures: Array<{ index: number; reason: string }> } {
  let json = 0
  let valid = 0
  const failures: Array<{ index: number; reason: string }> = []
  outputs.forEach((output, index) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      json++
    } catch {
      failures.push({ index, reason: 'not valid JSON' })
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { failures.push({ index, reason: 'not a JSON object' }); return }
    const record = parsed as Record<string, unknown>
    const missing = (schema.required ?? []).filter((key) => !(key in record))
    if (missing.length) { failures.push({ index, reason: `missing ${missing.join(', ')}` }); return }
    for (const [key, type] of Object.entries(schema.types ?? {})) {
      if (!(key in record)) continue
      const value = record[key]
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
      if (actual !== type) { failures.push({ index, reason: `${key} is ${actual}, expected ${type}` }); return }
    }
    for (const [key, allowed] of Object.entries(schema.enums ?? {})) if (key in record && !allowed.includes(String(record[key]))) { failures.push({ index, reason: `${key}=${String(record[key])} not in allowed values` }); return }
    valid++
  })
  return { validJson: json / Math.max(1, outputs.length), schemaValid: valid / Math.max(1, outputs.length), failures: failures.slice(0, 50) }
}

/** McNemar's exact test on paired correctness, plus a paired bootstrap CI for the accuracy difference. */
export function compareModels(correctA: boolean[], correctB: boolean[], seed = 42): { accuracyA: number; accuracyB: number; difference: number; ci: [number, number]; mcnemar: { bOnlyCorrect: number; aOnlyCorrect: number; pValue: number }; interpretation: string } {
  if (correctA.length !== correctB.length) throw new Error('paired comparison needs both models scored on the same items')
  const n = correctA.length
  const aOnly = correctA.filter((a, i) => a && !correctB[i]).length
  const bOnly = correctA.filter((a, i) => !a && correctB[i]).length
  const discordant = aOnly + bOnly
  const pValue = discordant === 0 ? 1 : Math.min(1, 2 * binomialCdf(Math.min(aOnly, bOnly), discordant, 0.5))
  const rng = createRng(seed)
  const draws: number[] = []
  for (let b = 0; b < 2000; b++) {
    let diff = 0
    for (let i = 0; i < n; i++) { const j = rng.int(n); diff += Number(correctB[j]) - Number(correctA[j]) }
    draws.push(diff / n)
  }
  draws.sort((x, y) => x - y)
  const accuracyA = correctA.filter(Boolean).length / n
  const accuracyB = correctB.filter(Boolean).length / n
  return { accuracyA, accuracyB, difference: accuracyB - accuracyA, ci: [quantileSorted(draws, 0.025), quantileSorted(draws, 0.975)], mcnemar: { bOnlyCorrect: bOnly, aOnlyCorrect: aOnly, pValue }, interpretation: pValue < 0.05 ? `B is ${accuracyB > accuracyA ? 'more' : 'less'} accurate than A on these ${n} items (McNemar p = ${pValue.toPrecision(3)})` : `no significant difference on these ${n} items (McNemar p = ${pValue.toPrecision(3)}); the CI shows the plausible range` }
}

export function evaluateLabels(predicted: string[], gold: string[]): Record<string, unknown> {
  if (predicted.length !== gold.length) throw new Error('predictions and gold labels must align')
  const classes = [...new Set([...gold, ...predicted])].sort()
  const index = new Map(classes.map((label, i) => [label, i]))
  return classificationMetrics(gold.map((label) => index.get(label)!), predicted.map((label) => index.get(label)!), undefined, classes)
}

export function usageProfile(rows: Array<{ group: string; inputTokens?: number; outputTokens?: number; latencyMs?: number; cost?: number }>): Array<Record<string, unknown>> {
  const groups = new Map<string, typeof rows>()
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row])
  return [...groups.entries()].map(([group, members]) => {
    const pick = (key: 'inputTokens' | 'outputTokens' | 'latencyMs' | 'cost') => members.map((m) => m[key]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
    const latency = pick('latencyMs')
    const cost = pick('cost')
    return { group, calls: members.length, meanInputTokens: mean(pick('inputTokens')), meanOutputTokens: mean(pick('outputTokens')), latencyP50: latency.length ? quantileSorted(latency, 0.5) : null, latencyP95: latency.length ? quantileSorted(latency, 0.95) : null, totalCost: cost.reduce((a, b) => a + b, 0), costPerCall: cost.length ? mean(cost) : null }
  })
}
