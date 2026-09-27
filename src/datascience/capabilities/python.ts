import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { currentAgent } from '../../autonomy/context.ts'
import { runProcess } from '../../shell.ts'
import { containerSandboxConfigured } from '../../sandbox/container.ts'
import { registerCapability } from '../engine.ts'
import { frameToCsv } from '../powerbi/project.ts'
import { detectPython, KNOWN_PACKAGES, minimalEnv, PYTHON_PROFILES, resetPythonCache, runPythonJob } from '../python.ts'
import { assertForwardableEnv } from '../secrets.ts'
import { datascienceRoot } from '../workspace.ts'
import { list, str } from './common.ts'

registerCapability({
  tool: 'ds_python',
  action: 'capabilities',
  summary: 'detect the Python interpreter and which data-science packages are installed (pandas, scikit-learn, statsmodels, xgboost, lightgbm, catboost, shap, prophet, torch, pyarrow, database drivers, …) and whether a container sandbox is configured',
  effect: 'process',
  params: { refresh: { type: 'boolean', description: 're-detect instead of using the 5-minute cache' } },
  async run(ctx) {
    const runtime = await detectPython({ refresh: ctx.params.refresh === true })
    ctx.record.check('runtime detected', runtime ? 'pass' : 'warn', runtime ? `${runtime.executable} (Python ${runtime.version})` : 'no Python 3.9+ interpreter found')
    return {
      python: runtime ? { executable: runtime.executable, version: runtime.version, managed: runtime.managed } : null,
      installed: runtime ? Object.entries(runtime.packages).filter(([, v]) => v).map(([name, version]) => `${name} ${version}`) : [],
      missing: runtime ? Object.entries(runtime.packages).filter(([, v]) => !v).map(([name]) => name) : [...KNOWN_PACKAGES],
      profiles: PYTHON_PROFILES,
      sandbox: containerSandboxConfigured() ? `container (${process.env.ELIA_SANDBOX_IMAGE})` : 'separate process with a scrubbed environment, timeout, and CPU/memory limits — not a container; set ELIA_SANDBOX=container and ELIA_SANDBOX_IMAGE for isolation',
      note: 'The TypeScript engine (ds_data/ds_stats/ds_ml/ds_timeseries/ds_analytics/ds_report) needs no Python. Use ds_python for methods it does not implement (XGBoost/LightGBM/CatBoost, SHAP, Prophet, UMAP/HDBSCAN, deep learning, Parquet I/O).',
    }
  },
})

registerCapability({
  tool: 'ds_python',
  action: 'run',
  summary: 'run Python analysis code in an isolated job: datasets you name are available via load_dataset(name) (pandas DataFrame when pandas is installed), INPUT holds your input object, files written to OUTPUT_DIR become recorded artifacts, and emit(result) returns a JSON result. The code is saved in the execution record',
  effect: 'process',
  params: { code: { type: 'string', required: true, description: 'Python 3 source; call emit({...}) once with the results' }, datasets: { type: 'string|array', description: 'workspace datasets to export for load_dataset()' }, input: { type: 'object', description: 'JSON-serialisable parameters available as INPUT' }, timeoutMs: { type: 'integer', description: 'wall-clock limit (default 300,000; max 3,600,000)' }, memoryMb: { type: 'integer', description: 'memory limit on Linux (default 4096)' }, passEnv: { type: 'array', description: 'NAMES of environment variables the code may read (e.g. a DSN); values never enter the record' } },
  example: { action: 'run', datasets: ['customers'], code: "import xgboost as xgb\ndf = load_dataset('customers')\n...\nemit({'auc': float(auc)})" },
  async run(ctx) {
    const code = str(ctx, 'code')
    ctx.record.code('python', code)
    const datasets: Record<string, { csv: string; types: Record<string, string> }> = {}
    for (const ref of list(ctx.params.datasets, 'datasets')) {
      const { entry, frame } = ctx.dataset(ref, { where: '' })
      datasets[entry.name] = { csv: frameToCsv(frame), types: frame.types }
    }
    const passEnv = Array.isArray(ctx.params.passEnv) ? (ctx.params.passEnv as unknown[]).map(String).filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)) : []
    for (const name of passEnv) assertForwardableEnv(name, 'analysis code')
    const job = await runPythonJob({ code, datasets, input: ctx.params.input ?? {}, passEnv, ...(typeof ctx.params.timeoutMs === 'number' ? { timeoutMs: ctx.params.timeoutMs } : {}), ...(typeof ctx.params.memoryMb === 'number' ? { memoryMb: ctx.params.memoryMb } : {}) })
    ctx.record.expect('process succeeded', job.exitCode === 0 && !job.timedOut, job.timedOut ? `timed out after ${job.elapsedMs} ms` : `exit code ${job.exitCode}`)
    ctx.record.expect('result emitted', job.result !== null && job.result !== undefined, job.result === null ? 'the code did not call emit(); nothing structured was returned' : 'emit() returned a result', 'warn')
    const artifacts = job.outputs.map((output) => {
      const name = relative(join(job.jobDir, 'outputs'), output.path).split('\\').join('/')
      const target = ctx.workspace.artifactPath(`python/${ctx.record.id}/${name}`)
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(output.path, target)
      const entry = ctx.workspace.recordArtifact(target, 'python-output', ctx.record.id, name)
      ctx.record.outputArtifact(entry.path, entry.sha256, entry.bytes)
      return entry.path
    })
    ctx.record.metric('elapsedMs', job.elapsedMs)
    return { ok: job.ok, result: job.result, artifacts, stdout: job.stdout.slice(-4000), stderr: job.stderr.slice(-4000), sandbox: job.sandbox, elapsedMs: job.elapsedMs, validationReminder: 'Code that ran without an exception is not a validated result: check the numbers (baselines, holdout, sanity ranges) before reporting them.' }
  },
})

registerCapability({
  tool: 'ds_python',
  action: 'setup',
  summary: 'create or extend the managed Python environment at .elia/datascience/venv and install packages (a named profile or a list) from PyPI — downloads and runs third-party code, so it always asks for approval',
  effect: 'install',
  params: { profile: { type: 'string', enum: Object.keys(PYTHON_PROFILES), description: 'package profile' }, packages: { type: 'array', description: 'explicit pip requirement strings, e.g. ["xgboost==2.1.1"]' } },
  async run(ctx) {
    const packages = [...(typeof ctx.params.profile === 'string' ? PYTHON_PROFILES[ctx.params.profile] ?? [] : []), ...list(ctx.params.packages, 'packages')]
    if (!packages.length) throw new Error('give a profile or packages')
    for (const pkg of packages) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,_-]+\])?([=<>!~]=?[A-Za-z0-9.*+!-]+)?$/.test(pkg)) throw new Error(`"${pkg}" is not a plain requirement (no URLs, paths, or options)`)
    const cwd = currentAgent().cwd ?? process.cwd()
    const venv = join(datascienceRoot(cwd), 'venv')
    const python = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
    const uv = Bun.which('uv')
    const log: string[] = []
    if (!existsSync(python)) {
      const base = (await detectPython({ cwd }))?.executable ?? Bun.which('python3') ?? Bun.which('python')
      const create = uv ? await runProcess({ executable: uv, args: ['venv', venv, ...(base ? ['--python', base] : [])], timeoutMs: 300_000, env: minimalEnv() }) : base ? await runProcess({ executable: base, args: ['-m', 'venv', venv], timeoutMs: 300_000, env: minimalEnv() }) : undefined
      if (!create || create.exitCode !== 0) throw new Error(`could not create the environment: ${create?.stderr.slice(-800) ?? 'no Python or uv found'}`)
      log.push(`created ${relative(cwd, venv)}`)
    }
    const install = uv ? await runProcess({ executable: uv, args: ['pip', 'install', '--python', python, ...packages], timeoutMs: 1_800_000, env: minimalEnv() }) : await runProcess({ executable: python, args: ['-m', 'pip', 'install', '--disable-pip-version-check', ...packages], timeoutMs: 1_800_000, env: minimalEnv() })
    ctx.record.code('python', `${uv ? 'uv pip install' : 'pip install'} ${packages.join(' ')}`)
    ctx.record.expect('packages installed', install.exitCode === 0, install.exitCode === 0 ? packages.join(', ') : install.stderr.slice(-800))
    resetPythonCache()
    const runtime = await detectPython({ refresh: true, cwd })
    return { environment: relative(cwd, venv), python: runtime?.executable, installed: runtime ? Object.entries(runtime.packages).filter(([, v]) => v).map(([n, v]) => `${n} ${v}`) : [], log: [...log, install.stdout.slice(-2000)], note: `Packages were installed only into ${relative(cwd, venv)}; the system Python is unchanged.`, file: basename(python) }
  },
})
