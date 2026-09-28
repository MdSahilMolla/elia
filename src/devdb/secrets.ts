/**
 * Passwords in SQL without the password in the conversation.
 *
 * A DBA creating a login role has to put a password somewhere. Written into the
 * SQL, it lands in the model's context, the session transcript and the action
 * ledger — and, on Postgres, in pg_stat_activity and any statement log on the
 * server. Instead the SQL names an environment variable:
 *
 *   CREATE ROLE app LOGIN PASSWORD ${env:APP_DB_PASSWORD}
 *
 * and elia fills the value in just before the statement runs, from the process
 * environment or the project's own env files. Postgres is handed a
 * SCRAM-SHA-256 verifier computed here instead of the password, so the plain
 * text never reaches the server either. Everything the tool prints afterwards
 * has the value scrubbed out.
 *
 * Placeholders are only filled in where a database stores a credential — a
 * role's password, a user mapping, a foreign server's options. Anywhere else (a
 * SELECT, an INSERT) filling one in would read the secret straight back out.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProtectedSecret } from '../datascience/secrets.ts'
import { quoteLiteral } from './common.ts'
import { ENV_FILES, parseEnvFile } from './detect.ts'
import { splitSqlText, stripSqlNoise } from './sql.ts'
import type { DatabaseEngine } from './url.ts'

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const CREDENTIAL_STATEMENT = /^(?:CREATE|ALTER) (?:ROLE|USER|GROUP)\b|^(?:CREATE|ALTER) SERVER\b|^SET PASSWORD\b/
const ROLE_STATEMENT = /^(?:CREATE|ALTER) (?:ROLE|USER|GROUP)\b(?! MAPPING\b)/

export function hasSecretPlaceholders(sql: string): boolean {
  return /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/.test(sql)
}

/** A variable from the process environment, else from the project's own (non-example) env files. */
export function lookupEnv(root: string, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromProcess = env[name]
  if (fromProcess) return fromProcess
  for (const file of ENV_FILES) {
    if (/\.(?:example|sample|template)$/.test(file)) continue
    const path = join(root, file)
    if (!existsSync(path)) continue
    try {
      const value = parseEnvFile(readFileSync(path, 'utf8'))[name]
      if (value) return value
    } catch {
      // an unreadable env file holds nothing we can use
    }
  }
  return undefined
}

/**
 * The verifier Postgres stores for a SCRAM-SHA-256 password (RFC 5802/7677).
 * Sent as the role's PASSWORD, Postgres keeps it as-is: the server never sees
 * the password itself. Callers only use it for printable ASCII, where SASLprep
 * (which Postgres applies to the password first) changes nothing.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

export type SecretResolution = { ok: true; sql: string; secrets: string[] } | { ok: false; error: string }

/** Fills `${env:NAME}` placeholders in credential statements; the result is for running, never for printing. */
export function resolveSecretPlaceholders(sql: string, engine: DatabaseEngine, lookup: (name: string) => string | undefined): SecretResolution {
  if (!hasSecretPlaceholders(sql)) return { ok: true, sql, secrets: [] }
  const secrets: string[] = []
  const statements: string[] = []
  for (const statement of splitSqlText(sql, engine)) {
    const placeholders = [...statement.matchAll(PLACEHOLDER)]
    if (placeholders.length === 0) {
      statements.push(statement)
      continue
    }
    const bare = stripSqlNoise(statement, { engine })
    if ([...bare.matchAll(PLACEHOLDER)].length !== placeholders.length) {
      return { ok: false, error: 'Write ${env:NAME} without quotes around it — elia quotes the value itself.' }
    }
    const upper = bare.trim().replace(/\s+/g, ' ').toUpperCase()
    if (!CREDENTIAL_STATEMENT.test(upper)) {
      return {
        ok: false,
        error: `\${env:NAME} is only filled in where a database stores a credential: CREATE/ALTER ROLE or USER … PASSWORD, a USER MAPPING, a SERVER's options, SET PASSWORD. In "${upper.slice(0, 60)}${upper.length > 60 ? '…' : ''}" it would hand the secret back.`,
      }
    }
    let failure: string | undefined
    const filled = statement.replace(PLACEHOLDER, (whole: string, name: string, offset: number) => {
      if (failure) return whole
      if (isProtectedSecret(name)) {
        failure = `${name} is one of elia's own credentials and is never written into a database; keep the database password in its own variable.`
        return whole
      }
      const value = lookup(name)
      if (value === undefined) {
        failure = `Environment variable ${name} is not set (checked the process environment and the project's env files). Ask the user to set it there — never to paste the value into the conversation.`
        return whole
      }
      secrets.push(value)
      const hashable = engine === 'postgres' && ROLE_STATEMENT.test(upper) && /\bPASSWORD\s*$/i.test(statement.slice(0, offset)) &&
        /^[\x20-\x7e]+$/.test(value) && !value.startsWith('SCRAM-SHA-256$') && !/^md5[0-9a-f]{32}$/.test(value)
      return quoteLiteral(hashable ? scramSha256Verifier(value) : value, engine)
    })
    if (failure) return { ok: false, error: failure }
    statements.push(filled)
  }
  // The separator on its own line: a trailing `--` comment cannot swallow it.
  return { ok: true, sql: statements.join('\n;\n'), secrets }
}

/** Replaces every filled-in secret in text that is about to be shown. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    out = out.split(secret).join('***')
    const doubled = secret.replace(/'/g, "''")
    if (doubled !== secret) out = out.split(doubled).join('***')
  }
  return out
}
