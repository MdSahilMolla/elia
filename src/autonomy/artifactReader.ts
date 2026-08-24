import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface ArtifactInfo {
  name: string
  path: string
  updatedAt: number
  sizeBytes: number
}

export function getArtifactsDir(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'artifacts')
}

export function listArtifacts(cwd = process.cwd()): ArtifactInfo[] {
  const results: ArtifactInfo[] = []
  const artifactsDir = getArtifactsDir(cwd)

  if (existsSync(artifactsDir)) {
    try {
      for (const file of readdirSync(artifactsDir)) {
        if (!file.endsWith('.md')) continue
        const path = join(artifactsDir, file)
        const stats = statSync(path)
        results.push({ name: file, path, updatedAt: stats.mtimeMs, sizeBytes: stats.size })
      }
    } catch {
      // Artifact listing is best effort; an explicit read still reports failure.
    }
  }

  const runsDir = join(cwd, '.elia', 'runs')
  if (existsSync(runsDir)) {
    try {
      for (const run of readdirSync(runsDir)) {
        for (const file of ['plan.md', 'receipt.md']) {
          const path = join(runsDir, run, file)
          if (!existsSync(path)) continue
          const stats = statSync(path)
          results.push({ name: `runs/${run}/${file}`, path, updatedAt: stats.mtimeMs, sizeBytes: stats.size })
        }
      }
    } catch {
      // Ignore malformed or concurrently removed run artifacts.
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function readArtifact(target?: string, cwd = process.cwd()): { path: string; content: string } | null {
  const artifactsDir = getArtifactsDir(cwd)
  const stateDir = resolve(cwd, '.elia')
  if (!target || target.trim() === '' || target === 'plan' || target === 'plan.md') {
    const defaultPlanPath = join(artifactsDir, 'plan.md')
    if (existsSync(defaultPlanPath)) return { path: defaultPlanPath, content: readFileSync(defaultPlanPath, 'utf8') }
  }

  if (target) {
    const artifactName = target.endsWith('.md') ? target : `${target}.md`
    const direct = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
    for (const candidate of [direct, resolve(artifactsDir, artifactName), resolve(stateDir, target)]) {
      const fromState = relative(stateDir, candidate)
      if (fromState.startsWith('..') || isAbsolute(fromState) || !candidate.endsWith('.md')) continue
      if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, content: readFileSync(candidate, 'utf8') }
    }
    return null
  }

  const latest = listArtifacts(cwd)[0]
  return latest ? { path: latest.path, content: readFileSync(latest.path, 'utf8') } : null
}
