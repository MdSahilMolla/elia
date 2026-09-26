import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { currentAgent } from '../autonomy/context.ts'
import { runProcess, type ShellResult } from '../shell.ts'
import { containerSandboxConfigured, ContainerUnavailable, runShellInContainer } from '../sandbox/container.ts'
import { datascienceRoot, sha256File } from './workspace.ts'

/**
 * The optional Python execution backend. The TypeScript engine covers the core methods on
 * every machine with no install; Python unlocks the long tail (Parquet/Avro/XLS readers,
 * scikit-learn, XGBoost/LightGBM/CatBoost, statsmodels, SHAP, Prophet, PyTorch …) when the
 * packages are actually present. Capabilities are detected at runtime and reported
 * honestly; a missing package is an explicit failure with the install command, never a
 * silent fallback that pretends the method ran.
 *
 * Jobs run as a separate process in a job directory under `.elia/datascience/jobs/`, with
 * isolated-mode Python (-I: no user site-packages, no PYTHON* env), a scrubbed environment
 * (no API keys or tokens), a wall-clock timeout, and POSIX CPU/memory rlimits. When
 * ELIA_SANDBOX=container is configured they run inside that container instead. Without a
 * container the process still runs as the user on this machine — that limitation is
 * stated, not hidden.
 */

export const KNOWN_PACKAGES = ['numpy', 'pandas', 'scipy', 'sklearn', 'statsmodels', 'polars', 'pyarrow', 'fastavro', 'openpyxl', 'xlrd', 'duckdb', 'xgboost', 'lightgbm', 'catboost', 'shap', 'prophet', 'torch', 'matplotlib', 'networkx', 'geopandas', 'shapely', 'umap', 'hdbscan', 'psycopg', 'psycopg2', 'pymysql', 'pyodbc', 'oracledb', 'snowflake.connector', 'google.cloud.bigquery', 'pytesseract', 'PIL', 'sentence_transformers', 'transformers'] as const

/** Named install profiles for the managed environment. */
export const PYTHON_PROFILES: Record<string, string[]> = {
  core: ['numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels', 'pyarrow', 'openpyxl', 'xlrd', 'fastavro'],
  ml: ['numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels', 'pyarrow', 'xgboost', 'lightgbm', 'shap'],
  timeseries: ['numpy', 'pandas', 'statsmodels', 'prophet'],
  sql: ['duckdb', 'psycopg[binary]', 'pymysql'],
  geo: ['geopandas', 'shapely'],
  graph: ['networkx'],
  deep: ['torch'],
  nlp: ['scikit-learn', 'sentence-transformers'],
}

export interface PythonRuntime {
  executable: string
  version: string
  managed: boolean
  packages: Record<string, string | null>
}

let cached: { key: string; runtime: PythonRuntime | null; at: number } | undefined

function managedPython(cwd: string): string {
  const venv = join(datascienceRoot(cwd), 'venv')
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}

function candidates(cwd: string): string[] {
  const list: string[] = []
  if (process.env.ELIA_DS_PYTHON) list.push(process.env.ELIA_DS_PYTHON)
  const managed = managedPython(cwd)
  if (existsSync(managed)) list.push(managed)
  for (const name of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const found = Bun.which(name)
    if (found) list.push(found)
  }
  return [...new Set(list)]
}

const PROBE = `import json, sys, importlib
out = {"version": sys.version.split()[0], "packages": {}}
for name in ${JSON.stringify(KNOWN_PACKAGES)}:
    try:
        module = importlib.import_module(name)
        out["packages"][name] = str(getattr(module, "__version__", "installed"))
    except Exception:
        out["packages"][name] = None
print(json.dumps(out))`

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  const keep = process.platform === 'win32' ? ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER']
  for (const key of keep) if (process.env[key]) env[key] = process.env[key]!
  return { ...env, PYTHONHASHSEED: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg', OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4', ...extra }
}

/** Finds a Python interpreter and which data packages it has. Cached for five minutes. */
export async function detectPython(options: { refresh?: boolean; cwd?: string } = {}): Promise<PythonRuntime | null> {
  const cwd = options.cwd ?? currentAgent().cwd ?? process.cwd()
  const key = `${cwd}|${process.env.ELIA_DS_PYTHON ?? ''}`
  if (!options.refresh && cached && cached.key === key && Date.now() - cached.at < 300_000) return cached.runtime
  let runtime: PythonRuntime | null = null
  for (const executable of candidates(cwd)) {
    const args = executable.endsWith('py') || executable.endsWith('py.exe') ? ['-3', '-I', '-c', PROBE] : ['-I', '-c', PROBE]
    const result = await runProcess({ executable, args, timeoutMs: 60_000, env: minimalEnv() })
    if (result.exitCode !== 0) continue
    try {
      const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { version: string; packages: Record<string, string | null> }
      if (!/^3\.(\d+)/.test(parsed.version) || Number(/^3\.(\d+)/.exec(parsed.version)![1]) < 9) continue
      runtime = { executable, version: parsed.version, managed: executable === managedPython(cwd), packages: parsed.packages }
      break
    } catch {
      continue
    }
  }
  cached = { key, runtime, at: Date.now() }
  return runtime
}

export function resetPythonCache(): void {
  cached = undefined
}

export function missingPackages(runtime: PythonRuntime | null, needed: string[]): string[] {
  if (!runtime) return needed
  return needed.filter((name) => !runtime.packages[name])
}

const PIP_NAMES: Record<string, string> = { sklearn: 'scikit-learn', PIL: 'pillow', 'snowflake.connector': 'snowflake-connector-python', 'google.cloud.bigquery': 'google-cloud-bigquery', psycopg: 'psycopg[binary]', umap: 'umap-learn' }

/** A precise, honest explanation for a capability that needs Python packages that are not present. */
export function requirementMessage(capability: string, needed: string[], runtime: PythonRuntime | null): string {
  const missing = missingPackages(runtime, needed)
  const pip = missing.map((name) => PIP_NAMES[name] ?? name).join(' ')
  if (!runtime) return `${capability} needs Python 3.9+ with ${needed.join(', ')}, and no Python interpreter was found. Install Python, or set ELIA_DS_PYTHON to one, then run ds_python action "setup" (creates a managed environment under .elia/datascience/venv after your approval).`
  return `${capability} needs the Python package(s) ${missing.join(', ')}, which ${runtime.executable} (Python ${runtime.version}) does not have. Run ds_python action "setup" with packages ["${missing.map((name) => PIP_NAMES[name] ?? name).join('", "')}"] to install them into the managed environment (requires approval), or install them yourself: pip install ${pip}. Nothing was computed.`
}

export interface PythonJobResult {
  ok: boolean
  result: unknown
  stdout: string
  stderr: string
  elapsedMs: number
  timedOut: boolean
  exitCode: number
  jobDir: string
  outputs: Array<{ path: string; sha256: string; bytes: number }>
  sandbox: 'container' | 'process'
}

const HARNESS = `
import json, os, sys, time
_job = sys.argv[1]
_limit_s = int(sys.argv[2])
_mem_mb = int(sys.argv[3])
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (_limit_s, _limit_s + 5))
    if sys.platform.startswith("linux") and _mem_mb > 0:
        resource.setrlimit(resource.RLIMIT_AS, (_mem_mb * 1024 * 1024, _mem_mb * 1024 * 1024))
except Exception:
    pass
os.chdir(_job)
with open(os.path.join(_job, "input.json"), "r", encoding="utf-8") as _f:
    INPUT = json.load(_f)
OUTPUT_DIR = os.path.join(_job, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)
DATA_DIR = os.path.join(_job, "data")
_result = {"emitted": None}

def _default(value):
    try:
        import numpy as _np
        if isinstance(value, _np.generic):
            return value.item()
        if isinstance(value, _np.ndarray):
            return value.tolist()
    except Exception:
        pass
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "to_dict"):
        try:
            return value.to_dict()
        except Exception:
            pass
    return str(value)

def emit(value):
    """Return a JSON-serialisable result to elia. Call once, at the end."""
    _result["emitted"] = json.loads(json.dumps(value, default=_default, allow_nan=False) if value is not None else "null")

def load_dataset(name):
    """Load a dataset elia exported for this job, as a pandas DataFrame when pandas is installed, else a list of dicts."""
    path = os.path.join(DATA_DIR, name + ".csv")
    try:
        import pandas as _pd
        meta_path = os.path.join(DATA_DIR, name + ".types.json")
        frame = _pd.read_csv(path, keep_default_na=False, na_values=[""])
        if os.path.exists(meta_path):
            with open(meta_path, encoding="utf-8") as _m:
                types = json.load(_m)
            for column, kind in types.items():
                if column in frame.columns and kind in ("date", "datetime"):
                    frame[column] = _pd.to_datetime(frame[column], errors="coerce", utc=(kind == "datetime"))
        return frame
    except ImportError:
        import csv
        with open(path, newline="", encoding="utf-8") as _c:
            return list(csv.DictReader(_c))

_started = time.time()
_code = open(os.path.join(_job, "job.py"), encoding="utf-8").read()
exec(compile(_code, "job.py", "exec"), {"INPUT": INPUT, "OUTPUT_DIR": OUTPUT_DIR, "DATA_DIR": DATA_DIR, "emit": emit, "load_dataset": load_dataset, "__name__": "__main__"})
with open(os.path.join(_job, "result.json"), "w", encoding="utf-8") as _o:
    json.dump({"result": _result["emitted"], "seconds": time.time() - _started}, _o, default=_default)
`

export interface RunPythonOptions {
  code: string
  input?: unknown
  /** Datasets to export as CSV into the job's data/ directory, by name. */
  datasets?: Record<string, { csv: string; types: Record<string, string> }>
  timeoutMs?: number
  memoryMb?: number
  cwd?: string
  /** Names of environment variables to pass through (e.g. a DSN env for a DB driver). Values never enter the record. */
  passEnv?: string[]
  signal?: AbortSignal
}

function listOutputs(dir: string): Array<{ path: string; sha256: string; bytes: number }> {
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; sha256: string; bytes: number }> = []
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stats = statSync(path)
      if (stats.isDirectory()) walk(path)
      else out.push({ path, sha256: sha256File(path), bytes: stats.size })
    }
  }
  walk(dir)
  return out
}

/** Runs Python code in an isolated job directory and returns what it emitted. */
export async function runPythonJob(options: RunPythonOptions): Promise<PythonJobResult> {
  const cwd = options.cwd ?? currentAgent().cwd ?? process.cwd()
  const runtime = await detectPython({ cwd })
  if (!runtime && !containerSandboxConfigured()) throw new Error(requirementMessage('Running Python', ['python'], null))
  const id = `py-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const jobDir = join(datascienceRoot(cwd), 'jobs', id)
  const dataDir = join(jobDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(jobDir, 'input.json'), JSON.stringify(options.input ?? {}))
  writeFileSync(join(jobDir, 'job.py'), options.code)
  writeFileSync(join(jobDir, 'harness.py'), HARNESS)
  for (const [name, dataset] of Object.entries(options.datasets ?? {})) {
    writeFileSync(join(dataDir, `${name}.csv`), dataset.csv)
    writeFileSync(join(dataDir, `${name}.types.json`), JSON.stringify(dataset.types))
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 300_000, 1_000), 3_600_000)
  const limitSeconds = Math.ceil(timeoutMs / 1000)
  const memoryMb = options.memoryMb ?? 4096
  const passed: Record<string, string> = {}
  for (const name of options.passEnv ?? []) if (process.env[name] !== undefined) passed[name] = process.env[name]!
  let result: ShellResult
  let sandbox: PythonJobResult['sandbox'] = 'process'
  if (containerSandboxConfigured()) {
    try {
      const relativeJob = jobDir.slice(cwd.length + 1).split('\\').join('/')
      result = await runShellInContainer(`python3 -I -B ${relativeJob}/harness.py /workspace/${relativeJob} ${limitSeconds} ${memoryMb}`, timeoutMs, cwd, options.signal ?? currentAgent().signal, { ...passed, PYTHONHASHSEED: '0', MPLBACKEND: 'Agg' })
      sandbox = 'container'
    } catch (error) {
      if (!(error instanceof ContainerUnavailable)) throw error
      if (!runtime) throw new Error(`the configured container sandbox is unavailable (${error.message}) and no local Python was found`)
      result = await runProcess({ executable: runtime.executable, args: ['-I', '-B', join(jobDir, 'harness.py'), jobDir, String(limitSeconds), String(memoryMb)], timeoutMs, cwd: jobDir, env: minimalEnv(passed), signal: options.signal ?? currentAgent().signal })
    }
  } else {
    result = await runProcess({ executable: runtime!.executable, args: ['-I', '-B', join(jobDir, 'harness.py'), jobDir, String(limitSeconds), String(memoryMb)], timeoutMs, cwd: jobDir, env: minimalEnv(passed), signal: options.signal ?? currentAgent().signal })
  }
  const resultPath = join(jobDir, 'result.json')
  let emitted: unknown = null
  if (existsSync(resultPath)) {
    try {
      emitted = (JSON.parse(readFileSync(resultPath, 'utf8')) as { result: unknown }).result
    } catch (error) {
      emitted = { parseError: (error as Error).message }
    }
  }
  return {
    ok: result.exitCode === 0 && !result.timedOut && existsSync(resultPath),
    result: emitted,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    jobDir,
    outputs: listOutputs(join(jobDir, 'outputs')),
    sandbox,
  }
}
