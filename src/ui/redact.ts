const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|session|private[_-]?key|access[_-]?key|client[_-]?secret|webhook)/i
const SECRET_VALUE = /((?:sk|pk|rk|xox[baprs]-|gh[pousr]_|AIza|AKIA)[A-Za-z0-9_\-/]{8,}|Bearer\s+[A-Za-z0-9._\-/+=]{8,}|\b[A-Za-z0-9+/]{32,}={0,2}\b)/g

/** Redacts credential-like values without flattening or truncating the surrounding evidence. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE, '[REDACTED]')
}

export function redactText(text: string, maxLength = 300): string {
  const redacted = redactSecrets(text)
  const flattened = redacted.replace(/\s+/g, ' ').trim()
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactText(value, 160)
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]))
  }
  return value
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactValue(value, key)]))
}

/** Archive redaction preserves multiline evidence and full non-secret tool arguments. */
export function redactArchiveValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactArchiveValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactArchiveValue(item, name)]))
  }
  return value
}
