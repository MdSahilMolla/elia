import { isMissing, isoDate, parseDateMs, toDateMs, toNumber, type Row, type Scalar } from './values.ts'

/**
 * A small, safe expression language for filters, derived columns, and simulation formulas.
 * It is parsed into an AST and interpreted; nothing is ever passed to `eval` or `Function`,
 * so a model-written expression cannot reach the host. Identifiers name columns (or
 * variables); backticks quote names with spaces: `order total` * 1.2.
 *
 * Nulls: arithmetic with null is null and an ordering comparison (<, >, between) with null
 * is false. Equality treats null as a value, as pandas does: `null == null` is true and
 * `status != "cancelled"` keeps rows whose status is missing. `is_null(x)` is explicit.
 */

type Node =
  | { kind: 'literal'; value: Scalar }
  | { kind: 'ident'; name: string }
  | { kind: 'list'; items: Node[] }
  | { kind: 'unary'; op: '-' | 'not'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }

interface Token {
  type: 'number' | 'string' | 'ident' | 'op' | 'eof'
  value: string
  position: number
}

const MAX_EXPRESSION_LENGTH = 4_000
const MAX_DEPTH = 64

function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new Error(`expression exceeds ${MAX_EXPRESSION_LENGTH} characters`)
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]!
    if (/\s/.test(character)) {
      index++
      continue
    }
    const start = index
    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index))!
      tokens.push({ type: 'number', value: match[0], position: start })
      index += match[0].length
      continue
    }
    if (character === '"' || character === "'") {
      let value = ''
      index++
      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1]!
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          index += 2
        } else {
          value += source[index]
          index++
        }
      }
      if (source[index] !== character) throw new Error(`unterminated string starting at position ${start}`)
      index++
      tokens.push({ type: 'string', value, position: start })
      continue
    }
    if (character === '`') {
      const end = source.indexOf('`', index + 1)
      if (end === -1) throw new Error(`unterminated \`quoted\` name at position ${start}`)
      tokens.push({ type: 'ident', value: source.slice(index + 1, end), position: start })
      index = end + 1
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index))!
      tokens.push({ type: 'ident', value: match[0], position: start })
      index += match[0].length
      continue
    }
    const two = source.slice(index, index + 2)
    if (['==', '!=', '<=', '>=', '&&', '||', '**', '<>'].includes(two)) {
      tokens.push({ type: 'op', value: two === '<>' ? '!=' : two, position: start })
      index += 2
      continue
    }
    if ('+-*/%^()<>=!,[]?:'.includes(character)) {
      tokens.push({ type: 'op', value: character === '=' ? '==' : character, position: start })
      index++
      continue
    }
    throw new Error(`unexpected character "${character}" at position ${start}`)
  }
  tokens.push({ type: 'eof', value: '', position: source.length })
  return tokens
}

class Parser {
  private index = 0
  private depth = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.ternary()
    if (this.peek().type !== 'eof') throw new Error(`unexpected "${this.peek().value}" at position ${this.peek().position}`)
    return node
  }

  private peek(): Token {
    return this.tokens[this.index]!
  }

  private take(): Token {
    return this.tokens[this.index++]!
  }

  private isWord(word: string): boolean {
    const token = this.peek()
    return token.type === 'ident' && token.value.toLowerCase() === word
  }

  private isOp(op: string): boolean {
    const token = this.peek()
    return token.type === 'op' && token.value === op
  }

  private expectOp(op: string): void {
    if (!this.isOp(op)) throw new Error(`expected "${op}" at position ${this.peek().position}, found "${this.peek().value || 'end of expression'}"`)
    this.take()
  }

  private nested<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Error('expression is nested too deeply')
    try {
      return fn()
    } finally {
      this.depth--
    }
  }

  /** `cond ? a : b` — the same as if(cond, a, b); right-associative, lowest precedence. */
  private ternary(): Node {
    const condition = this.or()
    if (!this.isOp('?')) return condition
    this.take()
    const whenTrue = this.nested(() => this.ternary())
    this.expectOp(':')
    const whenFalse = this.nested(() => this.ternary())
    return { kind: 'call', name: 'if', args: [condition, whenTrue, whenFalse] }
  }

  private or(): Node {
    let left = this.and()
    while (this.isWord('or') || this.isOp('||')) {
      this.take()
      left = { kind: 'binary', op: 'or', left, right: this.and() }
    }
    return left
  }

  private and(): Node {
    let left = this.not()
    while (this.isWord('and') || this.isOp('&&')) {
      this.take()
      left = { kind: 'binary', op: 'and', left, right: this.not() }
    }
    return left
  }

  private not(): Node {
    if (this.isWord('not') || this.isOp('!')) {
      this.take()
      return this.nested(() => ({ kind: 'unary', op: 'not', operand: this.not() }))
    }
    return this.comparison()
  }

  private comparison(): Node {
    const left = this.additive()
    const token = this.peek()
    if (token.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      this.take()
      return { kind: 'binary', op: token.value, left, right: this.additive() }
    }
    if (this.isWord('in')) {
      this.take()
      return { kind: 'binary', op: 'in', left, right: this.additive() }
    }
    if (this.isWord('not') && this.tokens[this.index + 1]?.type === 'ident' && this.tokens[this.index + 1]!.value.toLowerCase() === 'in') {
      this.take()
      this.take()
      return { kind: 'unary', op: 'not', operand: { kind: 'binary', op: 'in', left, right: this.additive() } }
    }
    if (this.isWord('between')) {
      this.take()
      const low = this.additive()
      if (!this.isWord('and')) throw new Error('between needs "and": x between 1 and 5')
      this.take()
      const high = this.additive()
      return { kind: 'binary', op: 'and', left: { kind: 'binary', op: '>=', left, right: low }, right: { kind: 'binary', op: '<=', left, right: high } }
    }
    return left
  }

  private additive(): Node {
    let left = this.multiplicative()
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.take().value
      left = { kind: 'binary', op, left, right: this.multiplicative() }
    }
    return left
  }

  private multiplicative(): Node {
    let left = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.take().value
      left = { kind: 'binary', op, left, right: this.unary() }
    }
    return left
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.take()
      return this.nested(() => ({ kind: 'unary', op: '-', operand: this.unary() }))
    }
    if (this.isOp('+')) {
      this.take()
      return this.unary()
    }
    return this.power()
  }

  private power(): Node {
    const base = this.primary()
    if (this.isOp('^') || this.isOp('**')) {
      this.take()
      return this.nested(() => ({ kind: 'binary', op: '^', left: base, right: this.unary() }))
    }
    return base
  }

  private primary(): Node {
    const token = this.take()
    if (token.type === 'number') return { kind: 'literal', value: Number(token.value) }
    if (token.type === 'string') return { kind: 'literal', value: token.value }
    if (token.type === 'op' && token.value === '(') {
      const node = this.nested(() => this.ternary())
      this.expectOp(')')
      return node
    }
    if (token.type === 'op' && token.value === '[') {
      const items: Node[] = []
      if (!this.isOp(']')) {
        do items.push(this.nested(() => this.ternary()))
        while (this.isOp(',') && this.take())
      }
      this.expectOp(']')
      return { kind: 'list', items }
    }
    if (token.type === 'ident') {
      const lower = token.value.toLowerCase()
      if (lower === 'true' || lower === 'false') return { kind: 'literal', value: lower === 'true' }
      if (lower === 'null') return { kind: 'literal', value: null }
      if (this.isOp('(') && FUNCTIONS[lower]) {
        this.take()
        const args: Node[] = []
        if (!this.isOp(')')) {
          do args.push(this.nested(() => this.ternary()))
          while (this.isOp(',') && this.take())
        }
        this.expectOp(')')
        const spec = FUNCTIONS[lower]!
        if (args.length < spec.min || args.length > spec.max) throw new Error(`${lower}() takes ${spec.min === spec.max ? spec.min : `${spec.min}-${spec.max === Infinity ? 'any' : spec.max}`} arguments, got ${args.length}`)
        return { kind: 'call', name: lower, args }
      }
      if (this.isOp('(')) throw new Error(`unknown function "${token.value}". Available: ${Object.keys(FUNCTIONS).sort().join(', ')}`)
      return { kind: 'ident', name: token.value }
    }
    throw new Error(`unexpected "${token.value || 'end of expression'}" at position ${token.position}`)
  }
}

type Value = Scalar | Scalar[]

function num(value: Value): number | null {
  if (Array.isArray(value) || isMissing(value)) return null
  return toNumber(value) ?? null
}

function str(value: Value): string | null {
  if (Array.isArray(value) || isMissing(value)) return null
  return String(value)
}

function dateMs(value: Value): number | null {
  if (Array.isArray(value) || isMissing(value)) return null
  return typeof value === 'string' ? parseDateMs(value) ?? null : toDateMs(value) ?? null
}

function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isMissing(value)) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return value.length > 0
}

function equal(a: Value, b: Value): boolean | null {
  if (Array.isArray(a) || Array.isArray(b)) return null
  if (isMissing(a) || isMissing(b)) return isMissing(a) && isMissing(b)
  if (typeof a === 'number' || typeof b === 'number') {
    const x = toNumber(a)
    const y = toNumber(b)
    if (x !== undefined && y !== undefined) return x === y
  }
  return String(a) === String(b)
}

function compare(a: Value, b: Value): number | null {
  if (Array.isArray(a) || Array.isArray(b) || isMissing(a) || isMissing(b)) return null
  const x = toNumber(a)
  const y = toNumber(b)
  if (x !== undefined && y !== undefined) return x - y
  const dx = typeof a === 'string' ? parseDateMs(a) : undefined
  const dy = typeof b === 'string' ? parseDateMs(b) : undefined
  if (dx !== undefined && dy !== undefined) return dx - dy
  const left = String(a)
  const right = String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

function datePart(value: Value, part: (date: Date) => number): number | null {
  const ms = dateMs(value)
  return ms === null ? null : part(new Date(ms))
}

const DAY_MS = 86_400_000

interface FunctionSpec {
  min: number
  max: number
  fn: (args: Value[]) => Value
}

const math1 = (op: (x: number) => number): FunctionSpec => ({ min: 1, max: 1, fn: ([x]) => { const value = num(x!); if (value === null) return null; const out = op(value); return Number.isFinite(out) ? out : null } })

const FUNCTIONS: Record<string, FunctionSpec> = {
  abs: math1(Math.abs),
  sqrt: math1((x) => (x < 0 ? Number.NaN : Math.sqrt(x))),
  log: math1((x) => (x <= 0 ? Number.NaN : Math.log(x))),
  ln: math1((x) => (x <= 0 ? Number.NaN : Math.log(x))),
  log10: math1((x) => (x <= 0 ? Number.NaN : Math.log10(x))),
  log2: math1((x) => (x <= 0 ? Number.NaN : Math.log2(x))),
  log1p: math1((x) => (x <= -1 ? Number.NaN : Math.log1p(x))),
  exp: math1(Math.exp),
  floor: math1(Math.floor),
  ceil: math1(Math.ceil),
  sign: math1(Math.sign),
  sin: math1(Math.sin),
  cos: math1(Math.cos),
  round: { min: 1, max: 2, fn: ([x, digits]) => { const value = num(x!); if (value === null) return null; const d = digits === undefined ? 0 : num(digits) ?? 0; const factor = 10 ** d; return Math.round(value * factor) / factor } },
  pow: { min: 2, max: 2, fn: ([x, y]) => { const a = num(x!); const b = num(y!); if (a === null || b === null) return null; const out = a ** b; return Number.isFinite(out) ? out : null } },
  min: { min: 1, max: Infinity, fn: (args) => { const values = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])).map((arg) => num(arg)).filter((v): v is number => v !== null); return values.length ? Math.min(...values) : null } },
  max: { min: 1, max: Infinity, fn: (args) => { const values = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])).map((arg) => num(arg)).filter((v): v is number => v !== null); return values.length ? Math.max(...values) : null } },
  clip: { min: 3, max: 3, fn: ([x, lo, hi]) => { const value = num(x!); const low = num(lo!); const high = num(hi!); if (value === null || low === null || high === null) return null; return Math.min(high, Math.max(low, value)) } },
  safe_divide: { min: 2, max: 3, fn: ([x, y, fallback]) => { const a = num(x!); const b = num(y!); if (a === null || b === null) return null; return b === 0 ? (fallback === undefined ? null : num(fallback)) : a / b } },
  is_null: { min: 1, max: 1, fn: ([x]) => isMissing(x as Scalar) },
  not_null: { min: 1, max: 1, fn: ([x]) => !isMissing(x as Scalar) },
  coalesce: { min: 1, max: Infinity, fn: (args) => (args.find((arg) => !Array.isArray(arg) && !isMissing(arg)) as Scalar | undefined) ?? null },
  if: { min: 3, max: 3, fn: () => null },
  case: { min: 2, max: Infinity, fn: () => null },
  number: { min: 1, max: 1, fn: ([x]) => num(x!) },
  parse_number: { min: 1, max: 1, fn: ([x]) => { const text = str(x!); if (text === null) return null; const negative = /^\(.*\)$/.test(text.trim()); const cleaned = text.replace(/[\s,$€£¥₹%()]/g, '').replace(/^[A-Za-z]{3}/, ''); const value = toNumber(cleaned); return value === undefined ? null : negative ? -value : value } },
  string: { min: 1, max: 1, fn: ([x]) => str(x!) },
  lower: { min: 1, max: 1, fn: ([x]) => str(x!)?.toLowerCase() ?? null },
  upper: { min: 1, max: 1, fn: ([x]) => str(x!)?.toUpperCase() ?? null },
  trim: { min: 1, max: 1, fn: ([x]) => str(x!)?.trim() ?? null },
  normalize_space: { min: 1, max: 1, fn: ([x]) => str(x!)?.replace(/\s+/g, ' ').trim() ?? null },
  len: { min: 1, max: 1, fn: ([x]) => (Array.isArray(x) ? x.length : str(x!)?.length ?? null) },
  contains: { min: 2, max: 2, fn: ([x, y]) => { const a = str(x!); const b = str(y!); return a === null || b === null ? null : a.toLowerCase().includes(b.toLowerCase()) } },
  starts_with: { min: 2, max: 2, fn: ([x, y]) => { const a = str(x!); const b = str(y!); return a === null || b === null ? null : a.startsWith(b) } },
  ends_with: { min: 2, max: 2, fn: ([x, y]) => { const a = str(x!); const b = str(y!); return a === null || b === null ? null : a.endsWith(b) } },
  replace: { min: 3, max: 3, fn: ([x, y, z]) => { const a = str(x!); const b = str(y!); const c = str(z!) ?? ''; return a === null || b === null ? null : a.split(b).join(c) } },
  substr: { min: 2, max: 3, fn: ([x, start, length]) => { const a = str(x!); const s = num(start!); if (a === null || s === null) return null; const l = length === undefined ? undefined : num(length) ?? undefined; return a.substr(Math.max(0, s), l) } },
  concat: { min: 1, max: Infinity, fn: (args) => args.map((arg) => (Array.isArray(arg) ? arg.join(',') : isMissing(arg) ? '' : String(arg))).join('') },
  split_part: { min: 3, max: 3, fn: ([x, sep, index]) => { const a = str(x!); const b = str(sep!); const i = num(index!); if (a === null || b === null || i === null) return null; return a.split(b)[i] ?? null } },
  year: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => d.getUTCFullYear()) },
  month: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => d.getUTCMonth() + 1) },
  day: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => d.getUTCDate()) },
  hour: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => d.getUTCHours()) },
  quarter: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => Math.floor(d.getUTCMonth() / 3) + 1) },
  weekday: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => (d.getUTCDay() + 6) % 7) },
  day_of_year: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1) },
  iso_week: { min: 1, max: 1, fn: ([x]) => datePart(x!, (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dayNumber = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dayNumber + 3); const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); return 1 + Math.round(((t.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7) }) },
  date: { min: 1, max: 1, fn: ([x]) => { const ms = dateMs(x!); return ms === null ? null : isoDate(ms) } },
  month_start: { min: 1, max: 1, fn: ([x]) => { const ms = dateMs(x!); if (ms === null) return null; const d = new Date(ms); return isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) } },
  week_start: { min: 1, max: 1, fn: ([x]) => { const ms = dateMs(x!); if (ms === null) return null; const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; return isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)) } },
  quarter_start: { min: 1, max: 1, fn: ([x]) => { const ms = dateMs(x!); if (ms === null) return null; const d = new Date(ms); return isoDate(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)) } },
  year_start: { min: 1, max: 1, fn: ([x]) => { const ms = dateMs(x!); if (ms === null) return null; return isoDate(Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) } },
  date_add_days: { min: 2, max: 2, fn: ([x, n]) => { const ms = dateMs(x!); const days = num(n!); return ms === null || days === null ? null : isoDate(ms + days * DAY_MS) } },
  days_between: { min: 2, max: 2, fn: ([a, b]) => { const x = dateMs(a!); const y = dateMs(b!); return x === null || y === null ? null : (y - x) / DAY_MS } },
  is_weekend: { min: 1, max: 1, fn: ([x]) => { const w = datePart(x!, (d) => d.getUTCDay()); return w === null ? null : w === 0 || w === 6 } },
}

function evaluate(node: Node, row: Row, variables?: Record<string, Scalar>): Value {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'ident':
      if (variables && node.name in variables) return variables[node.name] ?? null
      return row[node.name] ?? null
    case 'list':
      return node.items.map((item) => evaluate(item, row, variables) as Scalar)
    case 'unary': {
      const value = evaluate(node.operand, row, variables)
      if (node.op === 'not') return !truthy(value)
      const n = num(value)
      return n === null ? null : -n
    }
    case 'call': {
      if (node.name === 'if') return truthy(evaluate(node.args[0]!, row, variables)) ? evaluate(node.args[1]!, row, variables) : evaluate(node.args[2]!, row, variables)
      if (node.name === 'case') {
        for (let index = 0; index + 1 < node.args.length; index += 2) if (truthy(evaluate(node.args[index]!, row, variables))) return evaluate(node.args[index + 1]!, row, variables)
        return node.args.length % 2 === 1 ? evaluate(node.args.at(-1)!, row, variables) : null
      }
      return FUNCTIONS[node.name]!.fn(node.args.map((arg) => evaluate(arg, row, variables)))
    }
    case 'binary': {
      if (node.op === 'and') return truthy(evaluate(node.left, row, variables)) && truthy(evaluate(node.right, row, variables))
      if (node.op === 'or') return truthy(evaluate(node.left, row, variables)) || truthy(evaluate(node.right, row, variables))
      const left = evaluate(node.left, row, variables)
      const right = evaluate(node.right, row, variables)
      switch (node.op) {
        case '==': return equal(left, right) ?? false
        case '!=': return isMissing(left as Scalar) !== isMissing(right as Scalar) ? true : !(equal(left, right) ?? true)
        case '<': { const c = compare(left, right); return c !== null && c < 0 }
        case '<=': { const c = compare(left, right); return c !== null && c <= 0 }
        case '>': { const c = compare(left, right); return c !== null && c > 0 }
        case '>=': { const c = compare(left, right); return c !== null && c >= 0 }
        case 'in': return Array.isArray(right) ? right.some((item) => equal(left, item) === true) : false
        case '+': {
          if (typeof left === 'string' && typeof right === 'string' && (toNumber(left) === undefined || toNumber(right) === undefined)) return left + right
          const a = num(left); const b = num(right)
          return a === null || b === null ? null : a + b
        }
        case '-': { const a = num(left); const b = num(right); return a === null || b === null ? null : a - b }
        case '*': { const a = num(left); const b = num(right); return a === null || b === null ? null : a * b }
        case '/': { const a = num(left); const b = num(right); return a === null || b === null || b === 0 ? null : a / b }
        case '%': { const a = num(left); const b = num(right); return a === null || b === null || b === 0 ? null : a % b }
        case '^': { const a = num(left); const b = num(right); if (a === null || b === null) return null; const out = a ** b; return Number.isFinite(out) ? out : null }
      }
      throw new Error(`unknown operator ${node.op}`)
    }
  }
}

function identifiers(node: Node, out = new Set<string>()): Set<string> {
  if (node.kind === 'ident') out.add(node.name)
  else if (node.kind === 'list') node.items.forEach((item) => identifiers(item, out))
  else if (node.kind === 'unary') identifiers(node.operand, out)
  else if (node.kind === 'binary') { identifiers(node.left, out); identifiers(node.right, out) }
  else if (node.kind === 'call') node.args.forEach((arg) => identifiers(arg, out))
  return out
}

export interface CompiledExpression {
  source: string
  /** Column or variable names the expression reads. */
  references: string[]
  evaluate(row: Row, variables?: Record<string, Scalar>): Scalar
  test(row: Row, variables?: Record<string, Scalar>): boolean
}

/**
 * Parses an expression once. `known` names the columns (and variables) that exist; an
 * unknown identifier is an error naming the closest match, because a typo in a filter
 * otherwise silently evaluates to null and drops every row.
 */
export function compileExpression(source: string, known?: string[]): CompiledExpression {
  if (typeof source !== 'string' || !source.trim()) throw new Error('expression must be a non-empty string')
  let ast: Node
  try {
    ast = new Parser(tokenize(source)).parse()
  } catch (error) {
    throw new Error(`invalid expression "${source}": ${(error as Error).message}`)
  }
  const references = [...identifiers(ast)]
  if (known) {
    const unknown = references.filter((name) => !known.includes(name))
    if (unknown.length) {
      const hint = unknown.map((name) => {
        const close = known.filter((candidate) => candidate.toLowerCase() === name.toLowerCase() || candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, ''))
        return close.length ? `"${name}" (did you mean \`${close[0]}\`?)` : `"${name}"`
      })
      throw new Error(`expression "${source}" references unknown column(s) ${hint.join(', ')}. Quote names with spaces in backticks. Known: ${known.slice(0, 40).join(', ')}`)
    }
  }
  return {
    source,
    references,
    evaluate(row, variables) {
      const value = evaluate(ast, row, variables)
      if (Array.isArray(value)) return JSON.stringify(value)
      return typeof value === 'number' && !Number.isFinite(value) ? null : value
    },
    test(row, variables) {
      return truthy(evaluate(ast, row, variables))
    },
  }
}

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS).sort()
