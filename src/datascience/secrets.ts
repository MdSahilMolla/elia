import { PROVIDER_PRESET_NAMES, providerPresetApiKeyEnv } from '../providers/registry.ts'

/**
 * Environment variables an analysis may never forward — into an HTTP header, a connection,
 * or Python code. A data source's own credential (a DSN, an API token for that source) is
 * referenced by name and allowed; these are elia's own model-provider, search, GitHub,
 * deployment, and cloud keys, and sending one to an arbitrary endpoint would leak it.
 */
const PROVIDER_KEYS = new Set(PROVIDER_PRESET_NAMES.map(providerPresetApiKeyEnv).filter((name): name is string => Boolean(name)))
const PROTECTED = /^(ELIA_|ANTHROPIC_|OPENAI_|GITHUB_|GH_|EXA_|SERPER_|BRAVE_|VERCEL_|NETLIFY_|NPM_|AWS_SECRET|AWS_SESSION|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS)/

export function isProtectedSecret(name: string): boolean {
  return PROVIDER_KEYS.has(name) || PROTECTED.test(name)
}

export function assertForwardableEnv(name: string, where: string): void {
  if (isProtectedSecret(name)) throw new Error(`${name} is one of elia's own credentials and is never forwarded to ${where}; put the data source's credential in its own environment variable`)
}
