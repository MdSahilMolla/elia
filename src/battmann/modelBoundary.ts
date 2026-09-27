import { config, type TierConfig } from '../config.ts'
import { ollamaHost } from '../providers/ollama.ts'
import { providerCapabilities } from '../providers/registry.ts'

/**
 * Which Battmann records may enter a model's context, decided from where the model runs.
 *
 * A record's securityClassification is only a label until something enforces it. Here the rule is: when
 * every model route this process can use (deep and fast tiers, role overrides, and auto fallbacks) runs on
 * this machine, the Battmann tool may carry anything; when any route is a cloud model, the tool carries
 * nothing above the cloud ceiling — `internal` by default, `public` or `confidential` by explicit choice in
 * ELIA_BATTMANN_CLOUD_CLEARANCE, and never `restricted`. Reads are clamped to the ceiling and writes above it
 * are refused, because content a cloud model composes has already left the machine.
 *
 * What this does not cover: files the agent reads with other tools. The store file itself is a protected path
 * (autonomy/sensitivePaths.ts), so the Battmann tool is the only way a model reaches its records.
 */

export const CLEARANCE_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const
export type Clearance = (typeof CLEARANCE_LEVELS)[number]

export interface ModelBoundary {
  ceiling: Clearance
  allLocal: boolean
  /** Labels of the routes that are not on this machine. */
  cloudRoutes: string[]
}

/** Test seam: pins the boundary. Never set outside tests. */
export const modelBoundaryTestHooks: { override?: ModelBoundary } = {}

function isLoopback(url: string): boolean {
  try {
    const name = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name)
  } catch {
    return false
  }
}

function routeIsLocal(route: TierConfig): boolean {
  // Local runs on the machine's own server (presets like ollama), where the
  // host is still checked for loopback — a remote Ollama is cloud egress too.
  if (providerCapabilities(route.providerName).local) {
    return route.providerName === 'ollama' ? isLoopback(ollamaHost()) : true
  }
  if (route.providerName === 'custom') {
    // A tier does not record which base-URL variable built it, so every
    // configured one must be loopback.
    const baseUrls = Object.entries(process.env).filter(([name, value]) => /^ELIA_(?:[A-Z]+_)?BASE_URL$/.test(name) && value).map(([, value]) => value!)
    return baseUrls.length > 0 && baseUrls.every(isLoopback)
  }
  return false
}

export function modelBoundary(): ModelBoundary {
  if (modelBoundaryTestHooks.override) return modelBoundaryTestHooks.override
  const routes = [config.tiers.deep, config.tiers.fast, ...Object.values(config.roleOverrides), ...(config.routingMode === 'auto' ? config.fallbacks : [])]
    .filter((route): route is TierConfig => Boolean(route))
  const cloudRoutes = [...new Set(routes.filter((route) => !routeIsLocal(route)).map((route) => route.label))]
  if (!cloudRoutes.length) return { ceiling: 'restricted', allLocal: true, cloudRoutes: [] }
  const configured = process.env.ELIA_BATTMANN_CLOUD_CLEARANCE?.trim().toLowerCase()
  const ceiling: Clearance = configured === 'public' || configured === 'confidential' ? configured : 'internal'
  return { ceiling, allLocal: false, cloudRoutes }
}

export function clearanceRank(value: unknown): number {
  return Math.max(0, CLEARANCE_LEVELS.indexOf(String(value ?? 'internal') as Clearance))
}

/** The lower of a requested clearance and the ceiling; an absent request means "as much as the ceiling allows". */
export function clampClearance(requested: unknown, ceiling: Clearance): Clearance {
  if (requested === undefined || requested === null || requested === '') return ceiling
  if (!CLEARANCE_LEVELS.includes(requested as Clearance)) throw new Error('clearance must be public, internal, confidential, or restricted')
  return clearanceRank(requested) <= clearanceRank(ceiling) ? requested as Clearance : ceiling
}
