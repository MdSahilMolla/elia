/**
 * How each data-science action touches the world. This table is the single source the
 * action governor reads (without importing the engine), and the engine refuses to register
 * a capability whose declared effect disagrees with it.
 */

export type Effect = 'compute' | 'local-write' | 'artifact-write' | 'network-read' | 'database-read' | 'process' | 'install'

type Params = Record<string, unknown>
type Rule = Effect | ((params: Params) => Effect)

function sourceEffect(params: Params): Effect {
  const connection = typeof params.connection === 'string' ? params.connection.toLowerCase() : ''
  if (connection && connection !== 'sqlite') return 'database-read'
  if (typeof params.url === 'string' || typeof params.urlEnv === 'string') return 'network-read'
  return 'local-write'
}

export const EFFECTS: Record<string, Rule> = {
  'ds_data.load': sourceEffect,
  'ds_data.schema': sourceEffect,
  'ds_data.list': 'compute',
  'ds_data.inspect': 'compute',
  'ds_data.quality': 'compute',
  'ds_data.relationships': 'compute',
  'ds_data.transform': 'local-write',
  'ds_data.sql': 'compute',
  'ds_data.export': (params) => (typeof params.path === 'string' ? 'local-write' : 'artifact-write'),
  'ds_data.lineage': 'compute',
  'ds_data.preview': 'compute',
  'ds_stats.describe': 'compute',
  'ds_stats.test': 'compute',
  'ds_stats.correlations': 'compute',
  'ds_stats.regression': 'compute',
  'ds_stats.power': 'compute',
  'ds_stats.multiple_testing': 'compute',
  'ds_stats.bootstrap': 'compute',
  'ds_stats.ab_test': 'compute',
  'ds_stats.design_experiment': 'compute',
  'ds_stats.causal': 'compute',
  'ds_ml.train': 'local-write',
  'ds_ml.predict': 'local-write',
  'ds_ml.explain': 'compute',
  'ds_ml.models': 'compute',
  'ds_ml.promote': 'local-write',
  'ds_ml.model_card': 'artifact-write',
  'ds_ml.cluster': 'local-write',
  'ds_ml.reduce': 'local-write',
  'ds_ml.anomalies': 'local-write',
  'ds_ml.drift': 'compute',
  'ds_ml.recommend': 'local-write',
  'ds_timeseries.analyze': 'compute',
  'ds_timeseries.forecast': 'local-write',
  'ds_analytics.root_cause': 'compute',
  'ds_analytics.cohorts': 'compute',
  'ds_analytics.funnel': 'compute',
  'ds_analytics.rfm': 'local-write',
  'ds_analytics.clv': 'compute',
  'ds_analytics.kpis': 'compute',
  'ds_analytics.simulate': 'compute',
  'ds_analytics.queue': 'compute',
  'ds_analytics.optimize': 'compute',
  'ds_analytics.graph': 'local-write',
  'ds_analytics.geo': 'local-write',
  'ds_analytics.text': 'local-write',
  'ds_analytics.llm_eval': 'compute',
  'ds_report.plan': 'local-write',
  'ds_report.chart': 'artifact-write',
  'ds_report.report': 'artifact-write',
  'ds_report.powerbi': 'artifact-write',
  'ds_report.records': 'compute',
  'ds_report.deliver': 'compute',
  'ds_python.capabilities': 'process',
  'ds_python.run': 'process',
  'ds_python.setup': 'install',
}

export function datascienceEffect(tool: string, action: string, params: Params): Effect | undefined {
  const rule = EFFECTS[`${tool}.${action}`]
  if (rule === undefined) return undefined
  return typeof rule === 'function' ? rule(params) : rule
}

export const DATASCIENCE_TOOLS = ['ds_data', 'ds_stats', 'ds_ml', 'ds_timeseries', 'ds_analytics', 'ds_report', 'ds_python'] as const
