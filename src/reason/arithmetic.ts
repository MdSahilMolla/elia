/**
 * Recomputes the arithmetic an answer states.
 *
 * "12 × 4 = 50" is a claim a calculator settles in microseconds, and a model
 * working a question through makes this kind of slip fluently enough that it
 * goes unchecked. The idea is AION's `CalculationVerifier`: pull the computed
 * claims out of a proposal and re-run them. What AION did not do, and this
 * does, is refuse to guess. Only a claim whose left side is pure arithmetic and
 * whose right side is one bare number is checked. A claim with units, a
 * percentage, a variable, a scale word ("6 million") or anything the parser is
 * unsure of is skipped. A false alarm costs the user a model turn, and a missed
 * check costs nothing it did not already cost.
 *
 * Like reason/grounding.ts, this can fail an answer and can never pass one. A
 * clean result means the stated sums add up, not that the answer is right.
 *
 * No `eval`: the expression goes through a small recursive-descent parser that
 * knows numbers, + − × ÷ ^ and parentheses, and nothing else.
 */

export interface Calculation {
  /** The claim as written, e.g. `12 × 4 = 50`. */
  raw: string
  expression: string
  stated: number
  /** The right side as written, which carries the precision it was stated to. */
  statedText: string
  /** `≈` and `~=` claims are checked loosely; `=` is checked to the stated precision. */
  approximate: boolean
}

export interface WrongCalculation {
  calculation: Calculation
  actual: number
}

export interface CalculationCheck {
  checked: number
  wrong: WrongCalculation[]
}

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' } | { kind: 'paren'; value: '(' | ')' }

const NUMBER = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/

const OPERATORS: Record<string, '+' | '-' | '*' | '/' | '^'> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '⋅': '*',
  x: '*',
  X: '*',
  '/': '/',
  '÷': '/',
  '^': '^',
}

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = []
  let index = 0
  while (index < expression.length) {
    const char = expression[index]!
    if (/\s/.test(char) || '$€£₹'.includes(char)) {
      index += 1
      continue
    }
    const number = NUMBER.exec(expression.slice(index))
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0].replace(/,/g, '')) })
      index += number[0].length
      continue
    }
    if (expression.startsWith('**', index)) {
      tokens.push({ kind: 'op', value: '^' })
      index += 2
      continue
    }
    const op = OPERATORS[char]
    if (op) {
      tokens.push({ kind: 'op', value: op })
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char })
      index += 1
      continue
    }
    return undefined
  }
  return tokens
}

/**
 * The value of a pure arithmetic expression, or undefined when it is not one —
 * a parse error, a division by zero, or no operator at all (a bare number is
 * not a calculation, so `5 = 5` is not a claim worth checking).
 */
export function evaluateArithmetic(expression: string): number | undefined {
  const tokens = tokenize(expression)
  if (!tokens || tokens.length === 0) return undefined
  let position = 0
  let binaryOps = 0
  let failed = false

  const peek = (): Token | undefined => tokens[position]
  const isOp = (token: Token | undefined, ...values: string[]): boolean => token?.kind === 'op' && values.includes(token.value)

  // expr := term (('+' | '-') term)*
  const expr = (): number => {
    let value = term()
    while (isOp(peek(), '+', '-')) {
      const op = (tokens[position++] as { value: string }).value
      const right = term()
      value = op === '+' ? value + right : value - right
      binaryOps += 1
    }
    return value
  }
  // term := unary (('*' | '/') unary)*
  const term = (): number => {
    let value = unary()
    while (isOp(peek(), '*', '/')) {
      const op = (tokens[position++] as { value: string }).value
      const right = unary()
      if (op === '/' && right === 0) failed = true
      value = op === '*' ? value * right : value / right
      binaryOps += 1
    }
    return value
  }
  // unary := ('-' | '+') unary | power — so -2^2 is -(2^2), as written maths reads it.
  const unary = (): number => {
    if (isOp(peek(), '-', '+')) {
      const op = (tokens[position++] as { value: string }).value
      const value = unary()
      return op === '-' ? -value : value
    }
    return power()
  }
  // power := primary ('^' unary)? — right-associative.
  const power = (): number => {
    const base = primary()
    if (isOp(peek(), '^')) {
      position += 1
      binaryOps += 1
      return base ** unary()
    }
    return base
  }
  const primary = (): number => {
    const token = tokens[position++]
    if (token?.kind === 'number') return token.value
    if (token?.kind === 'paren' && token.value === '(') {
      const value = expr()
      const close = tokens[position++]
      if (close?.kind !== 'paren' || close.value !== ')') failed = true
      return value
    }
    failed = true
    return Number.NaN
  }

  const value = expr()
  if (failed || position !== tokens.length || binaryOps === 0 || !Number.isFinite(value)) return undefined
  return value
}

/** Characters that may appear in the left side of a checked claim. `x`, `,` and `.` are handled separately. */
const LHS_CHARS = /[\d\s+\-−*/×÷·⋅^()$€£₹]/
/** A right side followed by one of these is not the plain number it looks like. */
const SCALE_WORD = /^\s*(?:thousand|million|billion|trillion|lakh|lakhs|crore|crores|hundred|dozen|k|m|bn|mn|per\s?cent)\b/i
/** "close (2026-09-24) = 95.96" labels a value with a date; it does not subtract. */
const DATE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function neighbour(text: string, from: number, step: 1 | -1): string | undefined {
  let index = from + step
  while (index >= 0 && index < text.length && text[index] === ' ') index += step
  return text[index]
}

/** Scans left from just before a relation sign and returns where the arithmetic starts, or undefined. */
function leftStart(text: string, end: number): number | undefined {
  let index = end - 1
  while (index >= 0) {
    const char = text[index]!
    if (char === ',') {
      // Only a thousands separator: a digit on the left, exactly three on the right.
      if (!(isDigit(text[index - 1]) && /^\d{3}(?!\d)/.test(text.slice(index + 1)))) break
    } else if (char === '.') {
      // A decimal point, not the full stop that ended the sentence before the sum.
      if (!isDigit(text[index + 1])) break
    } else if (char === 'x' || char === 'X') {
      // "3 x 4" as multiplication, never the x of "so x = 5" or "0x1f".
      const left = neighbour(text, index, -1)
      const right = neighbour(text, index, 1)
      if (text[index - 1] !== ' ' || text[index + 1] !== ' ' || !(isDigit(left) || left === ')') || !(isDigit(right) || right === '(')) break
    } else if (!LHS_CHARS.test(char)) {
      break
    }
    index -= 1
  }
  const start = index + 1
  const glued = index >= 0 && start < end && !/\s/.test(text[start]!)
  // A number glued to a word ("Q2", "v1.2", "COVID-19") is part of a name, and
  // one glued to a colon is a clock or a ratio ("10:30"), not a sum.
  if (glued && (/[\p{L}\p{N}_]/u.test(text[index]!) || text[index] === ':')) return undefined
  return start
}

/** Reads the right side: one bare number, or undefined when it is anything more. */
function rightNumber(text: string, from: number): { value: number; end: number } | undefined {
  let index = from
  while (text[index] === ' ') index += 1
  let sign = 1
  if (text[index] === '-' || text[index] === '−') {
    sign = -1
    index += 1
  }
  while ('$€£₹'.includes(text[index] ?? '#')) index += 1
  const match = NUMBER.exec(text.slice(index))
  if (!match) return undefined
  const end = index + match[0].length
  // Markdown emphasis closing straight after the number is not multiplication.
  let after = end
  while (text[after] === '*' || text[after] === '_') after += 1
  const next = text[after]
  if (after > end && (isDigit(next) || next === '(')) return undefined
  if (after === end && next !== undefined && /[\p{L}\p{N}_%]/u.test(next)) return undefined
  if ((next === '.' || next === ':') && isDigit(text[after + 1])) return undefined
  const rest = text.slice(after)
  if (/^\s*[+\-−*/×÷^(%]/.test(rest)) return undefined
  if (/^\s*[xX]\s+\d/.test(rest)) return undefined
  if (SCALE_WORD.test(rest)) return undefined
  return { value: sign * Number(match[0].replace(/,/g, '')), end: after }
}

/** Fenced code is left alone: `x = 2 * 3` there is an assignment, not a claim. */
function withoutFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, (block) => block.replace(/[^\n]/g, ' '))
}

/** LaTeX an answer might carry, reduced to the operators the parser knows. */
function normaliseLatex(text: string): string {
  return text.replace(/\\times/g, ' ×').replace(/\\cdot/g, ' ·').replace(/\\div/g, ' ÷').replace(/\\approx/g, '≈')
}

export function extractCalculations(text: string): Calculation[] {
  const source = withoutFencedCode(normaliseLatex(text))
  const found: Calculation[] = []
  const relation = /(~=|≈|=)/g
  for (let match = relation.exec(source); match; match = relation.exec(source)) {
    const at = match.index
    const sign = match[1]!
    const before = source[at - 1]
    const after = source[at + sign.length]
    // Code-shaped operators: ==, !=, <=, >=, =>, :=, +=, and friends.
    if (sign === '=' && before !== undefined && '=!<>:+-*/^%&|~'.includes(before)) continue
    if (after === '=' || after === '>') continue

    const start = leftStart(source, at)
    if (start === undefined) continue
    // Leading markdown emphasis or a stray operator is not part of the sum.
    let expression = source.slice(start, at).trim().replace(/^[*_/×÷·⋅^+]+/, '').trim().replace(/\s+/g, ' ')
    // An opening paren the claim sits inside, e.g. "(3 × 4 = 12)".
    let open = (expression.match(/\(/g) ?? []).length - (expression.match(/\)/g) ?? []).length
    while (open > 0 && expression.startsWith('(')) {
      expression = expression.slice(1).trim()
      open -= 1
    }
    if (open !== 0 || expression.length === 0 || expression.length > 200) continue
    if (DATE.test(expression)) continue

    const right = rightNumber(source, at + sign.length)
    if (!right) continue
    if (evaluateArithmetic(expression) === undefined) continue
    const statedText = source.slice(at + sign.length, right.end).trim().replace(/[*_]+$/, '')
    found.push({ raw: `${expression} ${sign} ${statedText}`, expression, stated: right.value, statedText, approximate: sign !== '=' })
  }
  return found
}

function decimalsOf(statedText: string): number {
  const fraction = /\.(\d+)/.exec(statedText.replace(/[eE][+-]?\d+/, ''))
  return fraction ? fraction[1]!.length : 0
}

/**
 * Whether the stated result holds.
 *
 * An exact claim may round or truncate at the precision it was written to —
 * `2 / 3 = 0.67` and `1 / 3 = 0.333` are both fine — but only when the true
 * value does not terminate there. A whole-number result has to match exactly:
 * `17 × 23 = 392` is wrong by one, and "close" is exactly the slip this exists
 * to catch.
 */
export function holds(calculation: Calculation, actual: number): boolean {
  const { stated } = calculation
  const scale = Math.max(1, Math.abs(actual))
  if (Math.abs(actual - stated) <= 1e-9 * scale) return true
  const unit = 10 ** -decimalsOf(calculation.statedText)
  if (calculation.approximate) return Math.abs(actual - stated) <= Math.max(unit, 0.02 * Math.abs(actual))
  const wholeActual = Math.abs(actual - Math.round(actual)) <= 1e-9 * scale
  if (wholeActual) return false
  return Math.abs(actual - stated) < unit + 1e-9 * scale
}

export function checkCalculations(calculations: Calculation[]): CalculationCheck {
  const wrong: WrongCalculation[] = []
  for (const calculation of calculations) {
    const actual = evaluateArithmetic(calculation.expression)
    if (actual === undefined) continue
    if (!holds(calculation, actual)) wrong.push({ calculation, actual })
  }
  return { checked: calculations.length, wrong }
}

export function checkArithmetic(text: string): CalculationCheck {
  return checkCalculations(extractCalculations(text))
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return Number(value.toPrecision(10)).toString()
}

export function describeWrong(wrong: WrongCalculation): string {
  return `${wrong.calculation.raw} — it is ${formatNumber(wrong.actual)}`
}

export function describeCalculations(result: CalculationCheck): string {
  if (result.wrong.length === 0) return `${result.checked} calculation(s) re-computed, all hold`
  const shown = result.wrong.slice(0, 3).map(describeWrong).join('; ')
  const more = result.wrong.length > 3 ? ` (+${result.wrong.length - 3} more)` : ''
  return `${result.wrong.length} of ${result.checked} calculation(s) do not hold: ${shown}${more}`
}

/** What the model is told when its arithmetic did not hold. */
export function calculationBriefing(result: CalculationCheck): string {
  const lines = result.wrong.map((wrong) => `- ${describeWrong(wrong)}`)
  return [
    'elia recomputed the arithmetic in your answer and these results do not hold:',
    ...lines,
    '',
    'Correct each one, and carry the corrected value through anything that was derived from it — a wrong intermediate result usually means the conclusion is wrong too. If one of them was deliberate (a quotation, or an example of a mistake), say so plainly instead of changing it.',
  ].join('\n')
}
