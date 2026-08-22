import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { currentAgent } from '../autonomy/context.ts'
import type { Tool } from './types.ts'

interface ReadinessCheck {
  id: string
  label: string
  status: 'pass' | 'review'
  evidence: string[]
  recommendation?: string
}

const ROOT_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'fly.toml',
  'render.yaml',
  'railway.json',
  'vercel.json',
  'netlify.toml',
  'Procfile',
  '.env.example',
  'Jenkinsfile',
  'azure-pipelines.yml',
]

const MAX_SCAN_FILES = 2_000

function rootPath(): string {
  return currentAgent().cwd ?? process.cwd()
}

function exists(root: string, path: string): boolean {
  return existsSync(join(root, path))
}

function filesUnder(root: string, directory: string): string[] {
  const absolute = join(root, directory)
  if (!existsSync(absolute)) return []
  const output: string[] = []
  const visit = (path: string): void => {
    if (output.length >= MAX_SCAN_FILES) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '.elia', 'dist', 'build', '.venv', 'venv'].includes(entry.name)) visit(next)
      } else {
        output.push(relative(root, next))
      }
    }
  }
  visit(absolute)
  return output
}

function rootEntries(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

function containsText(root: string, paths: string[], expression: RegExp): string[] {
  const matches: string[] = []
  for (const path of paths) {
    try {
      const text = readFileSync(join(root, path), 'utf8')
      if (expression.test(text)) matches.push(path)
    } catch {
      // A binary, unreadable, or concurrently removed file is simply not evidence.
    }
  }
  return matches
}

function check(id: string, label: string, evidence: string[], recommendation: string): ReadinessCheck {
  return evidence.length > 0
    ? { id, label, status: 'pass', evidence }
    : { id, label, status: 'review', evidence: [], recommendation }
}

function inspectProductionReadiness(): string {
  const root = rootPath()
  const entries = rootEntries(root)
  const rootFiles = ROOT_FILES.filter((file) => entries.includes(file))
  const allFiles = filesUnder(root, '.')
  const ciEvidence = [
    ...['.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml'].filter((path) => exists(root, path)),
    ...['Jenkinsfile', 'azure-pipelines.yml'].filter((path) => exists(root, path)),
  ]
  const deployEvidence = rootFiles.filter((file) => ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'fly.toml', 'render.yaml', 'railway.json', 'vercel.json', 'netlify.toml', 'Procfile'].includes(file))
  const testEvidence = rootFiles.includes('package.json')
    ? containsText(root, ['package.json'], /"(test|check|lint|build)"\s*:/)
    : []
  const testDirectories = ['test', 'tests', '__tests__', 'spec'].filter((path) => exists(root, path))
  const migrationEvidence = allFiles.filter((path) => /(^|\/)(migrations?|prisma\/migrations|drizzle)(\/|$)/i.test(path)).slice(0, 20)
  const observabilityEvidence = allFiles.filter((path) => /(observab|telemetry|opentelemetry|prometheus|grafana|sentry|health|metrics|logging)/i.test(path)).slice(0, 20)
  const rollbackEvidence = allFiles.filter((path) => /(rollback|runbook|release|deploy|incident|slo|backup)/i.test(path)).slice(0, 20)
  const secretControlEvidence = ['.env.example', '.gitignore'].filter((path) => exists(root, path))
  const databaseEvidence = allFiles.filter((path) => /(schema|migration|prisma|drizzle|alembic|knexfile|sequelize)/i.test(path)).slice(0, 20)

  const checks: ReadinessCheck[] = [
    check('ci', 'Continuous integration', ciEvidence, 'Add CI that runs tests, type checks, lint, build, and security checks on every protected-branch change.'),
    check('deployment', 'Deployment definition', deployEvidence, 'Add a versioned deployment manifest or document the target platform, environment variables, health checks, and release command.'),
    check('verification', 'Automated verification', [...testEvidence, ...testDirectories], 'Add deterministic tests and project-specific type, lint, and build gates before staging or production.'),
    check('environment', 'Environment and secret hygiene', secretControlEvidence, 'Document required environment variables with a sanitized example and ensure real secrets are excluded from version control.'),
    check('database', 'Database and migration evidence', databaseEvidence, 'If the service uses a database, add versioned migrations, rollback or forward-fix policy, backup evidence, and migration tests.'),
    check('observability', 'Observability and health', observabilityEvidence, 'Add structured logs, health/readiness checks, metrics or traces, alert ownership, and a post-deploy verification signal.'),
    check('rollback', 'Release and incident recovery', rollbackEvidence, 'Add a release runbook covering rollback, incident ownership, backups, data repair, and customer communication.'),
  ]

  const passCount = checks.filter((item) => item.status === 'pass').length
  const score = Math.round((passCount / checks.length) * 100)
  const readiness = score >= 85 ? 'ready-for-staging-review' : score >= 60 ? 'needs-production-work' : 'insufficient-evidence'

  return JSON.stringify({
    action: 'production_readiness',
    root,
    readiness,
    score,
    checks,
    evidenceSummary: {
      scannedFiles: allFiles.length,
      rootFiles,
      ci: ciEvidence,
      deployment: deployEvidence,
      tests: [...testEvidence, ...testDirectories],
      migrations: migrationEvidence,
      observability: observabilityEvidence,
      recovery: rollbackEvidence,
    },
    limitations: [
      'This is a repository-evidence audit; it does not connect to staging or production.',
      'A detected manifest or script is not proof that deployment, rollback, backups, or alerts work.',
      'Production mutation, deployment, migration, and secret operations remain separate governed actions requiring explicit approval and postcondition evidence.',
    ],
  }, null, 2)
}

export const productionReadinessTool: Tool = {
  name: 'production_readiness',
  description: 'Inspect the current repository for production SaaS delivery readiness. This read-only audit checks CI/CD, deployment manifests, verification scripts, environment/secret hygiene, database/migration evidence, observability, health checks, rollback, incident, and backup evidence. It never deploys, migrates, changes production, or claims readiness from file presence alone.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    return inspectProductionReadiness()
  },
}

export { inspectProductionReadiness }
