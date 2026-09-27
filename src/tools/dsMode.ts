import '../datascience/capabilities/index.ts'
import { capabilitiesFor, formatOutcome, runCapability, type DsTool } from '../datascience/engine.ts'
import type { Tool } from './types.ts'

/**
 * The data-science mode's tools. Each tool groups related actions; every call runs through
 * the engine, which validates parameters, computes deterministically, checks the result,
 * and writes an execution record. Errors carry the exact usage of the action that failed.
 */

const DESCRIPTIONS: Record<DsTool, string> = {
  ds_data: 'Data ingestion and preparation in the analysis workspace (.elia/datascience). Load files (CSV/TSV/JSON/JSONL/XLSX/XLS/Parquet/Feather/Avro/XML/Markdown/PDF/DOCX), databases (SQLite; Postgres/MySQL/Redshift read-only; DuckDB/SQL Server/Oracle/Snowflake/BigQuery via Python drivers), REST APIs, and s3:// objects; inspect (data dictionary, grain, keys), quality (transparent score), relationships (validated by values), transform (recorded pipeline → new versioned dataset), sql (read-only, over workspace datasets), export, lineage, preview.',
  ds_stats: 'Statistics and causal inference: describe, test (auto-selected with assumption checks, effect sizes, post-hoc), correlations, regression (OLS/HC3/cluster, logistic, Poisson, negative binomial, robust, mixed), power, multiple_testing, bootstrap/permutation, ab_test (SRM, CUPED, guardrails, segments), design_experiment, causal (DiD, propensity/AIPW, RDD, IV, synthetic control, DAG).',
  ds_ml: 'Machine learning: train (AutoML with leakage screen, grouped/stratified/time-series CV, baseline, one-standard-error selection, untouched holdout, calibration, fairness, permutation importance, model registry), predict (with drift checks), explain (partial dependence, ICE, local contributions), models, promote (register/rollback), model_card, cluster, reduce (PCA/t-SNE/NMF), anomalies, drift, recommend.',
  ds_timeseries: 'Time series: analyze (regular grid, decomposition, ADF/KPSS, ACF/PACF, Ljung–Box, change points, anomalies) and forecast (naive/seasonal naive/drift/ETS/Holt-Winters/ARIMA/boosted lags compared by rolling-origin backtest, with empirical prediction intervals).',
  ds_analytics: 'Business and applied analytics: root_cause (recursive metric decomposition, mix vs rate), cohorts, funnel, rfm, clv, kpis, simulate (Monte Carlo + sensitivity), queue, optimize (LP/MILP with shadow prices), graph (centrality, communities), geo (clusters, nearest, joins, site selection, Moran I), text (keywords, sentiment, topics, clustering, search, summaries, entities), llm_eval (labels, QA, generation, grounding, retrieval, structured output, model comparison, usage).',
  ds_report: 'Planning and delivery: plan (objective, problem type → standard workflow), chart (validated-palette SVG + data table), report (HTML + Markdown from execution records; narrative numbers are traced to results), powerbi (PBIP project: TMDL star schema, DAX, Date table, PBIR pages), records (execution records), deliver (final answer scaffold with verified artifacts).',
  ds_python: 'Optional Python backend: capabilities (what is installed), run (analysis code in an isolated job with load_dataset/emit/OUTPUT_DIR; code is recorded), setup (install packages into .elia/datascience/venv — always needs approval).',
}

function makeTool(name: DsTool): Tool {
  const capabilities = capabilitiesFor(name)
  const actions = capabilities.map((capability) => capability.action)
  const properties: Record<string, unknown> = { action: { type: 'string', enum: actions, description: capabilities.map((c) => `${c.action}: ${c.summary}`).join(' | ') } }
  for (const capability of capabilities) {
    for (const [param, doc] of Object.entries(capability.params)) {
      if (properties[param]) continue
      const type = doc.type === 'string|array' ? undefined : doc.type === 'integer' ? 'number' : doc.type
      properties[param] = { ...(type ? { type } : {}), description: doc.description, ...(doc.enum && capabilities.filter((c) => c.params[param]).length === 1 ? { enum: [...doc.enum] } : {}) }
    }
  }
  return {
    name,
    description: `${DESCRIPTIONS[name]} Every call writes an execution record; the result's "status" says whether its validation checks passed. Pass "action" plus that action's parameters; a wrong call returns the action's exact usage.`,
    input_schema: { type: 'object', properties, required: ['action'] },
    async execute(input) {
      return formatOutcome(await runCapability(name, input))
    },
  }
}

export const DATASCIENCE_TOOL_NAMES: DsTool[] = ['ds_data', 'ds_stats', 'ds_ml', 'ds_timeseries', 'ds_analytics', 'ds_report', 'ds_python']
export const datascienceTools: Tool[] = DATASCIENCE_TOOL_NAMES.map(makeTool)
