/**
 * Figure grounding: which numbers in a claim do not appear in the evidence it cites.
 *
 * A live brief put India's HS 8541 supplier shares into a claim about HS 8542 and cited the 8542 record; every
 * figure looked plausible and the citation was well-formed. Comparing the claim's figures with the stored text
 * of the cited evidence — the excerpt the source or the feed code wrote, never the model's supporting excerpt —
 * catches that class of mistake mechanically. It is a flag for the reviewer, not a verdict: a derived figure
 * or the model's own estimate will also show up here, and should then be labelled as such.
 */

interface Figure { raw: string; value: number; decimals: number }

const DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g
const NUMBER = /(US\$|\$|₹|€|£|Rs\.?\s?)?(?<![\w.])(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?(\s*(?:%|percent|pp|bn|billion|b\b|mn|million|m\b|crore|lakh|trillion|t\b|usd\b|inr\b|eur\b|us\$|\/bbl|bbl\b|\/t\b|tonnes?\b|mmbtu\b|per (?:barrel|tonne|ton)\b))?/gi

function figures(text: string): Figure[] {
  const result: Figure[] = []
  for (const match of text.replace(DATE, ' ').matchAll(NUMBER)) {
    const currency = match[1] ?? ''
    const whole = match[2]!.replaceAll(',', '')
    const fraction = match[3] ?? ''
    const unit = match[4]?.trim() ?? ''
    const value = Number(`${whole}${fraction}`)
    if (!Number.isFinite(value)) continue
    // Bare integers are mostly counts, durations, years and codes (HS 8542, 2026, 3-5 years); only figures
    // with a fraction, a unit or a currency are claims about a measured quantity.
    if (!fraction && !unit && !currency) continue
    // A whole number's trailing zeros are its precision: 14000 is a figure rounded to the thousand.
    const trailingZeros = fraction ? 0 : (/0+$/.exec(whole)?.[0].length ?? 0)
    result.push({ raw: match[0].trim(), value, decimals: fraction ? fraction.length - 1 : -Math.min(trailingZeros, Math.max(0, whole.length - 1)) })
  }
  return result
}

const roundTo = (value: number, decimals: number) => (decimals >= 0 ? Number(value.toFixed(decimals)) : Math.round(value / 10 ** -decimals) * 10 ** -decimals)

/** Two figures agree when one is the other rounded to its own precision (11.7 matches 11.71; 6.45 matches 6.5). */
function agree(a: Figure, b: Figure): boolean {
  return roundTo(a.value, b.decimals) === b.value || roundTo(b.value, a.decimals) === a.value
}

export function unverifiedFigures(statement: string, evidenceTexts: string[]): string[] {
  const available = evidenceTexts.flatMap(figures)
  const missing = figures(statement).filter((figure) => !available.some((candidate) => agree(figure, candidate)))
  return [...new Set(missing.map((figure) => figure.raw))]
}
