import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'
import { userPreauthSecret } from '../autonomy/preauth.ts'

/**
 * Encryption for the cookie jar at rest.
 *
 * The jar holds live bearer credentials, and `0600` only stops other *users* on
 * the machine. It does nothing about the path that actually matters here: elia
 * is a tool-using agent whose `read_file` can open any path in the workspace, so
 * a plaintext jar hands every session cookie to the model on sight — and the
 * redaction in `ui/redact.ts` does not help, because it filters strings elia
 * *renders*, not bytes it reads off disk.
 *
 * So the values are sealed. AES-256-GCM, with the key derived from the
 * pre-existing per-user preauth secret via scrypt and bound to this engagement's
 * path, so a jar copied to another project does not decrypt there. Salt and IV
 * are stored beside the ciphertext, which is correct for GCM — they are not
 * secret, and reusing either is what breaks GCM, so each write draws a fresh IV.
 *
 * What this is *not*: it does not defend against an attacker who can already run
 * code as this user, because they can reach the preauth secret too. It raises the
 * bar from "the model reads the cookie jar" to "the model reads the cookie jar
 * and also has the user's home directory". That is the boundary worth having
 * while the jar sits inside the agent's own reach.
 */

/** Bumped when the on-disk shape changes, so an old jar is recognised, not misread. */
export const SEALED_JAR_VERSION = 2

interface SealedJar {
  version: number
  sealed: true
  /** scrypt salt, base64. */
  salt: string
  /** GCM initialisation vector, base64. Never reused across writes. */
  iv: string
  /** AES-256-GCM ciphertext over the plaintext jar JSON, base64. */
  data: string
  /** GCM auth tag, base64. */
  tag: string
}

const SCRYPT_KEYLEN = 32
const IV_BYTES = 12

/** AAD binds the ciphertext to this file's path: a jar moved elsewhere fails to open. */
function aad(path: string): Buffer {
  return Buffer.from(`elia:http-session:${path.replaceAll('\\', '/')}`, 'utf8')
}

function deriveKey(salt: Buffer, path: string): Buffer {
  // The preauth secret is already a high-entropy machine secret; scrypt is here
  // to slow an offline guess if the jar is ever separated from the secret, and
  // the path in the AAD means the derived key is not portable between projects.
  return scryptSync(`${userPreauthSecret()}\u0000${path}`, salt, SCRYPT_KEYLEN)
}

export function isSealedJar(parsed: unknown): parsed is SealedJar {
  if (!parsed || typeof parsed !== 'object') return false
  const candidate = parsed as Partial<SealedJar>
  return candidate.version === SEALED_JAR_VERSION && candidate.sealed === true
    && typeof candidate.salt === 'string' && typeof candidate.iv === 'string'
    && typeof candidate.data === 'string' && typeof candidate.tag === 'string'
}

export function sealJar(plaintext: string, path: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(salt, path)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(path))
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const sealed: SealedJar = {
    version: SEALED_JAR_VERSION,
    sealed: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
  return `${JSON.stringify(sealed, null, 2)}\n`
}

/** `undefined` when the ciphertext does not authenticate — wrong machine, moved file, or tampering. */
export function openSealedJar(sealed: SealedJar, path: string): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(Buffer.from(sealed.salt, 'base64'), path), Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(aad(path))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Write the sealing key material alongside the jar when it is first created.
 *
 * No key file is needed: the key is derived from the per-user preauth secret
 * (`~/.config/elia/preauth.secret`), which elia already creates and protects, so
 * there is no second secret for the operator to manage or lose. Exposed for the
 * tests to assert the derivation is stable and path-bound.
 */
export function sealingFingerprint(path: string): string {
  return createHmac('sha256', deriveKey(Buffer.alloc(16), path)).digest('hex').slice(0, 16)
}
