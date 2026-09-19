import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile } from '../securePersistence.ts'
import { redactSecrets } from '../ui/redact.ts'
import { currentAgent } from '../autonomy/context.ts'
import { clampOutput, runShell } from '../shell.ts'
import type { Tool } from './types.ts'

type DeploymentProvider = 'vercel' | 'netlify' | 'docker'
type DeploymentAction = 'plan' | 'build' | 'deploy' | 'verify'
type DeploymentTarget = 'preview' | 'production'

// A loose but real image-reference shape: optional registry host (with a dot
// or port, the way `docker` itself tells a registry apart from a Docker Hub
// user/org), then path segments. Rejects anything with shell/argv-hostile
// characters before it ever reaches a spawned docker command.
const IMAGE_REF_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$/

const DEPLOYMENT_TIMEOUT_MS = 10 * 60_000
const VERIFY_TIMEOUT_MS = 20_000
const MAX_RECEIPT_OUTPUT = 4_000
const MAX_VERIFY_BODY = 2_000
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/

interface DeploymentReceipt {
  at: string
  action: DeploymentAction
  provider: DeploymentProvider
  target?: DeploymentTarget
  cwd: string
  command?: string
  status: 'planned' | 'built' | 'deployed' | 'verified' | 'failed'
  url?: string
  httpStatus?: number
  output?: string
  error?: string
}

export const deploymentTool: Tool = {
  name: 'deployment',
  description:
    'Plan, build, deploy, and verify a web project through an explicitly linked Vercel/Netlify project, or a container image through an explicitly configured Docker registry (ELIA_DOCKER_REGISTRY). Preview deploys may proceed under the normal review policy; production deploys are critical external side effects and require Elia’s exact approval boundary. This tool never creates or links a new project/registry, changes environment variables, manages domains, exposes credentials, or deploys without an explicit link.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'build', 'deploy', 'verify'], description: 'Deployment lifecycle action' },
      provider: { type: 'string', enum: ['vercel', 'netlify', 'docker'], description: 'Deployment provider' },
      target: { type: 'string', enum: ['preview', 'production'], description: 'Deployment environment; required for deploy and optional for plan/build. For docker: preview builds/pushes the "preview" tag, production the "latest" tag.' },
      url: { type: 'string', description: 'The exact deployment URL to verify; required for verify on vercel/netlify (docker verify instead checks the pushed image exists in the registry — no url needed)' },
    },
    required: ['action', 'provider'],
  },
  async execute(input) {
    const action = parseAction(input.action)
    const provider = parseProvider(input.provider)
    const target = input.target === undefined ? undefined : parseTarget(input.target)
    const cwd = currentAgent().cwd ?? process.cwd()

    if (action === 'plan') {
      const result = planDeployment(provider, cwd, target)
      recordReceipt({ ...result, action, provider, target, cwd })
      return JSON.stringify(result, null, 2)
    }

    if (action === 'verify') {
      if (provider === 'docker') {
        if (!target) throw new Error('target is required for docker deployment verify (which tag to check)')
        const result = await verifyDockerImage(target, cwd, currentAgent().signal)
        recordReceipt({ ...result, action, provider, target, cwd })
        return JSON.stringify(result, null, 2)
      }
      if (typeof input.url !== 'string' || input.url.trim().length === 0) throw new Error('url is required for deployment verify')
      const result = await verifyDeployment(input.url, provider, cwd)
      recordReceipt({ ...result, action, provider, target, cwd })
      return JSON.stringify(result, null, 2)
    }

    if (action === 'deploy' && !target) throw new Error('target is required for deployment deploy')
    const plan = planDeployment(provider, cwd, target)
    if (action === 'deploy' && plan.status === 'failed') {
      recordReceipt({ ...plan, action, provider, target, cwd })
      return JSON.stringify(plan, null, 2)
    }

    const command = action === 'build' ? buildCommand(provider, plan, cwd) : deployCommand(provider, target!, plan, cwd)
    if (!command) {
      const result: DeploymentReceipt = {
        at: new Date().toISOString(),
        action,
        provider,
        target,
        cwd,
        status: 'failed',
        error: action === 'build' ? 'No declared local build command was found.' : 'Provider project link is missing or invalid.',
      }
      recordReceipt(result)
      return JSON.stringify(result, null, 2)
    }

    const shellResult = await runShell(command, DEPLOYMENT_TIMEOUT_MS, cwd, currentAgent().signal)
    const url = action === 'deploy' ? deploymentUrl(provider, shellResult.stdout, shellResult.stderr) : undefined
    const successful = shellResult.exitCode === 0 && !shellResult.timedOut
    const result: DeploymentReceipt = {
      at: new Date().toISOString(),
      action,
      provider,
      target,
      cwd,
      command,
      status: successful ? (action === 'deploy' ? 'deployed' : 'built') : 'failed',
      ...(url ? { url } : {}),
      output: clampOutput([shellResult.stdout, shellResult.stderr].filter(Boolean).join('\n'), MAX_RECEIPT_OUTPUT),
      ...(successful ? {} : { error: shellResult.timedOut ? `command timed out after ${DEPLOYMENT_TIMEOUT_MS}ms` : `command exited with code ${shellResult.exitCode}` }),
    }
    recordReceipt(result)
    return JSON.stringify(result, null, 2)
  },
}

function parseAction(value: unknown): DeploymentAction {
  if (value === 'plan' || value === 'build' || value === 'deploy' || value === 'verify') return value
  throw new Error('action must be one of: plan, build, deploy, verify')
}

function parseProvider(value: unknown): DeploymentProvider {
  if (value === 'vercel' || value === 'netlify' || value === 'docker') return value
  throw new Error('provider must be one of: vercel, netlify, docker')
}

function parseTarget(value: unknown): DeploymentTarget {
  if (value === 'preview' || value === 'production') return value
  throw new Error('target must be one of: preview, production')
}

function planDeployment(provider: DeploymentProvider, cwd: string, target?: DeploymentTarget): DeploymentReceipt & { available: boolean; linked: boolean; buildCommand?: string; notes: string[] } {
  const cli = Bun.which(provider === 'docker' ? 'docker' : provider)
  const linked = provider === 'vercel' ? vercelLinked(cwd) : provider === 'netlify' ? netlifyLinked(cwd) : dockerLinked()
  const packageInfo = readPackage(cwd)
  const build = provider === 'docker' ? (dockerfileExists(cwd) ? dockerBuildCommand(target) : undefined) : packageInfo?.scripts?.build ? packageManager(cwd) : undefined
  const notes: string[] = []
  if (!cli) notes.push(`${provider === 'docker' ? 'docker' : provider} CLI is not installed or not on PATH`)
  if (!linked) {
    notes.push(
      provider === 'docker'
        ? 'ELIA_DOCKER_REGISTRY is not set (or is not a valid image reference); Elia will not guess a registry destination'
        : `No explicitly linked ${provider} project was found; Elia will not create or guess a destination`,
    )
  }
  if (provider === 'docker' && !dockerfileExists(cwd)) notes.push('No Dockerfile was found at the project root; build/deploy are unavailable')
  else if (!build) notes.push('No package.json build script was found; deploy may still use provider configuration, but local build action is unavailable')
  if (provider === 'vercel' && process.env.VERCEL_TOKEN) notes.push('VERCEL_TOKEN is present without exposing its value; authorization and project access remain unverified')
  if (provider === 'netlify' && process.env.NETLIFY_AUTH_TOKEN) notes.push('NETLIFY_AUTH_TOKEN is present without exposing its value; authorization and site access remain unverified')
  if (provider === 'docker' && linked) notes.push(`Registry auth (docker login) is assumed already configured outside Elia; pushing to ${dockerImageRef()} remains unverified until deploy actually runs`)

  return {
    at: new Date().toISOString(),
    action: 'plan',
    provider,
    target,
    cwd,
    status: cli && linked ? 'planned' : 'failed',
    available: Boolean(cli),
    linked,
    ...(build ? { buildCommand: build } : {}),
    notes,
    ...(cli && linked ? {} : { error: notes.join('; ') }),
  }
}

function buildCommand(provider: DeploymentProvider, plan: ReturnType<typeof planDeployment>, cwd: string): string | undefined {
  if (plan.buildCommand) return plan.buildCommand
  if (!plan.available) return undefined
  if (provider === 'docker') return dockerfileExists(cwd) ? dockerBuildCommand(plan.target) : undefined
  return provider === 'vercel' ? 'vercel build' : 'netlify build'
}

function deployCommand(provider: DeploymentProvider, target: DeploymentTarget, plan: ReturnType<typeof planDeployment>, cwd: string): string | undefined {
  if (!plan.available || !plan.linked) return undefined
  if (provider === 'docker') return dockerfileExists(cwd) ? `docker push ${dockerImageRef()}:${dockerTagFor(target)}` : undefined
  if (provider === 'vercel') return target === 'production' ? withCiEnv('vercel deploy --prod --yes') : withCiEnv('vercel deploy --yes')

  const siteId = netlifySiteId(cwd)
  const siteFlag = siteId ? ` --site ${siteId}` : ''
  return target === 'production' ? withCiEnv(`netlify deploy --prod --json${siteFlag}`) : withCiEnv(`netlify deploy --json${siteFlag}`)
}

/** Vercel/Netlify CLIs refuse to run outside a TTY unless CI is set. `CI=1 name` is POSIX shell syntax; on Windows `cmd.exe` it is not an env prefix at all — it names `CI` as the program to run, so the deploy fails before the CLI starts. `set CI=1&& ` is the cmd equivalent. */
function withCiEnv(command: string): string {
  return process.platform === 'win32' ? `set CI=1&& ${command}` : `CI=1 ${command}`
}

/** The registry+image the operator explicitly configured — the docker equivalent of a linked Vercel/Netlify project. Never guessed. */
function dockerImageRef(): string | undefined {
  const value = process.env.ELIA_DOCKER_REGISTRY?.trim()
  return value && IMAGE_REF_PATTERN.test(value) ? value : undefined
}

function dockerLinked(): boolean {
  return dockerImageRef() !== undefined
}

function dockerfileExists(cwd: string): boolean {
  return existsSync(join(cwd, 'Dockerfile'))
}

/** No git-sha versioning here (unlike a real CI pipeline) — deliberately simple and predictable, matching how Vercel/Netlify's own tagging is opaque to this tool too. The receipt always records the exact tag used. */
function dockerTagFor(target?: DeploymentTarget): string {
  return target === 'production' ? 'latest' : 'preview'
}

/** Tags with the configured registry reference when one is set (so a later `deploy` pushes exactly what this built); otherwise builds untagged — a build validates the Dockerfile and doesn't itself need a destination, matching how `vercel build`/`netlify build` don't require a linked project either. */
function dockerBuildCommand(target?: DeploymentTarget): string {
  const ref = dockerImageRef()
  return ref ? `docker build -t ${ref}:${dockerTagFor(target)} .` : 'docker build .'
}

function packageManager(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm run build'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn build'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun run build'
  return 'npm run build'
}

function readPackage(cwd: string): { scripts?: Record<string, unknown> } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const scripts = (parsed as { scripts?: unknown }).scripts
    return { scripts: typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? scripts as Record<string, unknown> : undefined }
  } catch {
    return undefined
  }
}

/**
 * Docker's postcondition check, parallel to verifyDeployment's HTTP fetch —
 * there is no default deployed URL to hit, so "verified" instead means the
 * registry actually has the image `deploy` was supposed to push, confirmed
 * against the registry itself rather than trusting the push command's own
 * exit code.
 */
async function verifyDockerImage(target: DeploymentTarget, cwd: string, signal: AbortSignal | undefined): Promise<DeploymentReceipt> {
  const ref = dockerImageRef()
  if (!ref) {
    return { at: new Date().toISOString(), action: 'verify', provider: 'docker', target, cwd, status: 'failed', error: 'ELIA_DOCKER_REGISTRY is not set (or is not a valid image reference).' }
  }
  const image = `${ref}:${dockerTagFor(target)}`
  const result = await runShell(`docker manifest inspect ${image}`, VERIFY_TIMEOUT_MS, cwd, signal)
  const successful = result.exitCode === 0 && !result.timedOut
  return {
    at: new Date().toISOString(),
    action: 'verify',
    provider: 'docker',
    target,
    cwd,
    status: successful ? 'verified' : 'failed',
    url: image,
    output: clampOutput([result.stdout, result.stderr].filter(Boolean).join('\n'), MAX_VERIFY_BODY),
    ...(successful ? {} : { error: result.timedOut ? `manifest inspect timed out after ${VERIFY_TIMEOUT_MS}ms` : `${image} was not found in the registry (exit ${result.exitCode})` }),
  }
}

function vercelLinked(cwd: string): boolean {
  return existsSync(join(cwd, '.vercel', 'project.json'))
}

function netlifyLinked(cwd: string): boolean {
  return existsSync(join(cwd, '.netlify', 'state.json')) || Boolean(netlifySiteId(cwd))
}

function netlifySiteId(_cwd: string): string | undefined {
  const value = process.env.NETLIFY_SITE_ID
  return value && SAFE_ID.test(value) ? value : undefined
}

function deploymentUrl(provider: DeploymentProvider, stdout: string, stderr: string): string | undefined {
  if (provider === 'vercel') {
    const candidate = [...stdout.split(/\s+/), ...stderr.split(/\s+/)].find((value) => /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value) && (value.includes('vercel.') || value.includes('vercel.sh')))
    return candidate?.replace(/[),.;]+$/, '')
  }

  const parsed = tryJson(stdout)
  for (const key of ['deploy_url', 'url', 'ssl_url', 'site_url']) {
    if (typeof parsed?.[key] === 'string' && /^https?:\/\//.test(parsed[key])) return parsed[key]
  }
  const candidate = [...stdout.split(/\s+/), ...stderr.split(/\s+/)].find((value) => /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value) && value.includes('netlify.'))
  return candidate?.replace(/[),.;]+$/, '')
}

async function verifyDeployment(urlInput: string, provider: DeploymentProvider, cwd: string): Promise<DeploymentReceipt> {
  const url = validateDeploymentUrl(urlInput, provider)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
  const signal = currentAgent().signal
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // 'manual' so a redirect to an unvalidated (potentially private/internal) host is never followed and never counted as verified.
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
    const isRedirect = response.status >= 300 && response.status < 400
    const body = isRedirect ? '' : await readBoundedBody(response, MAX_VERIFY_BODY)
    const successful = !isRedirect && response.status >= 200 && response.status < 300
    return {
      at: new Date().toISOString(),
      action: 'verify',
      provider,
      cwd,
      status: successful ? 'verified' : 'failed',
      url,
      httpStatus: response.status,
      output: body,
      ...(successful
        ? {}
        : { error: isRedirect ? `deployment responded with an unfollowed redirect (HTTP ${response.status})` : `deployment responded with HTTP ${response.status}` }),
    }
  } catch (error) {
    return {
      at: new Date().toISOString(),
      action: 'verify',
      provider,
      cwd,
      status: 'failed',
      url,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

function validateDeploymentUrl(input: string, provider: DeploymentProvider): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('url must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'https:') throw new Error('deployment verification only supports HTTPS URLs')
  if (url.username || url.password) throw new Error('deployment verification URLs may not contain credentials')
  const hostname = url.hostname.toLowerCase()
  if (isPrivateHost(hostname)) throw new Error('deployment verification refuses localhost, private-network, and link-local hosts')
  const allowed = provider === 'vercel' ? ['vercel.app', 'vercel.sh'] : ['netlify.app', 'netlify.com']
  if (!allowed.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error(`deployment verification only accepts the provider’s default ${provider} hostnames`)
  }
  return url.toString()
}

function isPrivateHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname.startsWith('127.')
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let output = ''
  try {
    while (output.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return clampOutput(output, limit)
}

function tryJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.trim()) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function recordReceipt(receipt: DeploymentReceipt): void {
  try {
    // Same hardening as every other .elia state writer: owner-only file and
    // directory, and secrets a CLI echoed into its output (deploy tokens,
    // authenticated URLs) scrubbed before they are kept on disk.
    appendSecureFile(join(receipt.cwd, '.elia', 'deployments.jsonl'), `${redactSecrets(JSON.stringify(receipt))}\n`)
  } catch {
    // A receipt failure must not transform an otherwise completed deployment into a failure.
  }
}
