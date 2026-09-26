import { expect, test } from 'bun:test'
import { calculationBriefing, checkArithmetic, describeCalculations, evaluateArithmetic, extractCalculations } from './arithmetic.ts'

const wrong = (text: string) => checkArithmetic(text).wrong.map((entry) => entry.calculation.raw)
const checked = (text: string) => extractCalculations(text).map((entry) => entry.raw)

test('evaluates + − × ÷ ^ and parentheses with the usual precedence', () => {
  expect(evaluateArithmetic('2 + 3 × 4')).toBe(14)
  expect(evaluateArithmetic('(2 + 3) × 4')).toBe(20)
  expect(evaluateArithmetic('2 ^ 3 ^ 2')).toBe(512)
  expect(evaluateArithmetic('-2^2')).toBe(-4)
  expect(evaluateArithmetic('10 ÷ 4')).toBe(2.5)
  expect(evaluateArithmetic('2 ** 10')).toBe(1024)
  expect(evaluateArithmetic('1,234 + 1')).toBe(1235)
  expect(evaluateArithmetic('$1,200 × 12')).toBe(14_400)
  expect(evaluateArithmetic('7 − 10')).toBe(-3)
})

test('a bare number, a division by zero and anything unparsable are not calculations', () => {
  expect(evaluateArithmetic('5')).toBeUndefined()
  expect(evaluateArithmetic('4 / 0')).toBeUndefined()
  expect(evaluateArithmetic('2 + abc')).toBeUndefined()
  expect(evaluateArithmetic('(2 + 3')).toBeUndefined()
  expect(evaluateArithmetic('2 +')).toBeUndefined()
})

test('a wrong product is caught, and a right one is not', () => {
  expect(wrong('So 17 × 23 = 392 in total.')).toEqual(['17 × 23 = 392'])
  expect(wrong('So 17 × 23 = 391 in total.')).toEqual([])
})

test('a whole-number result has to match exactly, off-by-one included', () => {
  expect(wrong('48 + 2 = 51')).toEqual(['48 + 2 = 51'])
  expect(wrong('7 * 8 = 56')).toEqual([])
})

test('a result stated to a precision may round or truncate at that precision', () => {
  expect(wrong('2 / 3 = 0.67, and 1 / 3 = 0.333..., and 22 / 7 = 3.14')).toEqual([])
  expect(wrong('2 / 3 = 0.76')).toEqual(['2 / 3 = 0.76'])
  expect(wrong('6 / 2 = 3.0')).toEqual([])
  expect(wrong('6 / 2 = 3.1')).toEqual(['6 / 2 = 3.1'])
})

test('an approximate claim is checked loosely', () => {
  expect(wrong('123,456 × 789 ≈ 97,400,000')).toEqual([])
  expect(wrong('123,456 × 789 ≈ 90,000,000')).toEqual(['123,456 × 789 ≈ 90,000,000'])
  expect(wrong('the ratio is 10 / 3 ~= 3.3')).toEqual([])
})

test('chained working checks each step whose right side is a bare number', () => {
  // "12 × 4 = 48 + 2" is sloppy notation, not a claim that 48 = 50 — only the
  // step ending in a bare number is checked.
  expect(checked('12 × 4 = 48 + 2 = 50')).toEqual(['48 + 2 = 50'])
  expect(wrong('3 × 4 = 12, then 12 + 5 = 18')).toEqual(['12 + 5 = 18'])
})

test('markdown, LaTeX and currency around a claim do not hide it', () => {
  expect(wrong('**12 × 4 = 50**')).toEqual(['12 × 4 = 50'])
  expect(wrong('$12 \\times 4 = 50$')).toEqual(['$12 × 4 = 50'])
  expect(wrong('Each costs $1,200 × 12 = $14,000 a year')).toEqual(['$1,200 × 12 = $14,000'])
  expect(wrong('(3 × 4 = 13)')).toEqual(['3 × 4 = 13'])
  expect(wrong('Step 1: 3 x 4 = 13')).toEqual(['3 x 4 = 13'])
})

test('a claim after a word or a full stop is still found', () => {
  expect(wrong('It costs 3 × 4 = 13 dollars.')).toEqual(['3 × 4 = 13'])
  expect(wrong('The total is 5. 3 × 4 = 13')).toEqual(['3 × 4 = 13'])
})

test('units, percentages, scale words and variables are skipped rather than guessed at', () => {
  expect(checked('3 km × 4 = 12 km')).toEqual([])
  expect(checked('20% of 50 = 10')).toEqual([])
  expect(checked('0.2 × 50 = 10%')).toEqual([])
  expect(checked('2 × 3 = 6 million')).toEqual([])
  expect(checked('1.5 × 4 = 6k')).toEqual([])
  expect(checked('so x = 5 and 2x = 10')).toEqual([])
  expect(checked('the answer is 3x4=12')).toEqual([])
})

test('names, versions, times and code are not arithmetic', () => {
  expect(checked('Q2 - 4 = 7')).toEqual([])
  expect(checked('COVID-19 + 2 = 5')).toEqual([])
  expect(checked('v1.2 + 1 = 9')).toEqual([])
  expect(checked('the meeting at 10:30 + 2 = 12:30')).toEqual([])
  expect(checked('if (a == 3 + 4) b += 2 = 9')).toEqual([])
  expect(checked('```\nconst n = 2 * 3\nconst m = 2 * 3 = 7\n```')).toEqual([])
  expect(checked('https://x.dev/?a=1+2')).toEqual([])
})

test('a date labelling a value is not a subtraction', () => {
  // Seen in a real Battmann brief: "Brent close (2026-09-24) = 95.96".
  expect(checked('Brent close (2026-09-24) = 95.96 and on 9/24/2026 = 96')).toEqual([])
  expect(wrong('Brent close (2026-09-24) = 95.96, so 95.96 + 0.616 = 96.576')).toEqual([])
})

test('a claim whose right side keeps going is not a claim about that number', () => {
  expect(checked('2 + 2 = 4 * 1')).toEqual([])
  expect(checked('1/2 + 1/3 = 5/6')).toEqual([])
  expect(checked('3 × 4 = 12.5.1')).toEqual([])
})

test('the description and the briefing name what is wrong and what it should be', () => {
  const result = checkArithmetic('17 × 23 = 392 and 2 + 2 = 4')
  expect(describeCalculations(result)).toBe('1 of 2 calculation(s) do not hold: 17 × 23 = 392 — it is 391')
  expect(calculationBriefing(result)).toContain('- 17 × 23 = 392 — it is 391')
  expect(calculationBriefing(result)).toContain('carry the corrected value through')
  expect(describeCalculations(checkArithmetic('2 + 2 = 4'))).toBe('1 calculation(s) re-computed, all hold')
})
