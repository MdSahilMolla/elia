import { analyzeAbTest, analyzeDag, designExperiment, differenceInDifferences, propensityAnalysis, regressionDiscontinuity, syntheticControl, twoStageLeastSquares, type VariantData } from '../causal.ts'
import { registerCapability, type ActionContext } from '../engine.ts'
import { assertColumns, type Frame } from '../frame.ts'
import { summarize } from '../stats/describe.ts'
import { binaryTarget, buildDesign } from '../stats/design.ts'
import { huberRegression, logisticRegression, negativeBinomialRegression, ols, poissonRegression, randomInterceptModel, type RegressionResult } from '../stats/glm.ts'
import { adjustPValues, CORRECTION_METHODS, parseCorrection } from '../stats/multiple.ts'
import { anovaPower, anovaSampleSize, chiSquarePower, chiSquareSampleSize, correlationPower, correlationSampleSize, proportionsPower, proportionsSampleSize, tTestPower, tTestSampleSize } from '../stats/power.ts'
import { bootstrap, bootstrapTwoSample, permutationTest, STATISTICS, statisticFunction, type StatisticName } from '../stats/resample.ts'
import { parseAlternative } from '../stats/special.ts'
import * as T from '../stats/tests.ts'
import { heatmapChart, histogramChart, boxChart } from '../viz.ts'
import { isMissing, scalarKey, toDateMs, toNumber } from '../values.ts'
import { refOf } from '../workspace.ts'
import { DATASET, list, saveChart, SEED, str, WHERE } from './common.ts'

function numbers(frame: Frame, column: string, rows = frame.rows): number[] {
  return rows.map((row) => toNumber(row[column])).filter((v): v is number => v !== undefined)
}

function groupsOf(frame: Frame, value: string, group: string, only?: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const row of frame.rows) {
    const key = row[group]
    if (isMissing(key)) continue
    const label = String(key)
    if (only && !only.includes(label)) continue
    const v = toNumber(row[value])
    if (v === undefined) continue
    ;(out[label] ??= []).push(v)
  }
  return out
}

function recordAssumptions(ctx: ActionContext, result: { assumptions: T.Assumption[] }): void {
  for (const assumption of result.assumptions) {
    if (assumption.status === 'violated') ctx.record.check(`assumption: ${assumption.name}`, 'warn', assumption.detail)
    else if (assumption.status === 'met') ctx.record.check(`assumption: ${assumption.name}`, 'pass', assumption.detail)
  }
}

function interpret(result: T.TestResult, alpha: number): string {
  const significant = result.pValue < alpha
  const effect = result.effectSize ? `${result.effectSize.name} = ${result.effectSize.value.toPrecision(3)}${result.effectSize.magnitude ? ` (${result.effectSize.magnitude})` : ''}` : ''
  const p = result.pValue < 1e-4 ? result.pValue.toExponential(2) : result.pValue.toPrecision(3)
  return `${result.test}: ${result.statisticName} = ${result.statistic.toPrecision(4)}, p = ${p} — ${significant ? `statistically significant at α = ${alpha}` : `not statistically significant at α = ${alpha} (absence of evidence is not evidence of absence)`}.${effect ? ` Effect size: ${effect}; ${significant && result.effectSize?.magnitude === 'negligible' ? 'significant but practically negligible' : !significant && (result.effectSize?.magnitude === 'medium' || result.effectSize?.magnitude === 'large') ? 'a sizeable effect that this sample cannot confirm — likely underpowered' : 'judge practical importance against a business-relevant threshold'}.` : ''}`
}

registerCapability({
  tool: 'ds_stats',
  action: 'describe',
  summary: 'descriptive statistics (count, mean, sd, quantiles, IQR, skewness, kurtosis, CI of the mean) for numeric columns, optionally by group; frequencies for categorical columns',
  effect: 'compute',
  params: { dataset: DATASET, columns: { type: 'string|array', description: 'columns (default: all numeric)' }, groupBy: { type: 'string', description: 'group column' }, where: WHERE, chart: { type: 'boolean', description: 'draw a histogram (one column) or box plot (grouped)' } },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const cols = list(ctx.params.columns, 'columns')
    assertColumns(frame, cols, 'columns')
    const numeric = (cols.length ? cols : frame.columns).filter((c) => frame.types[c] === 'integer' || frame.types[c] === 'number')
    const categorical = cols.filter((c) => !numeric.includes(c))
    const groupBy = typeof ctx.params.groupBy === 'string' ? ctx.params.groupBy : undefined
    if (groupBy) assertColumns(frame, [groupBy], 'groupBy')
    const describeRows = (rows: Frame['rows']) => Object.fromEntries(numeric.map((c) => { const v = numbers(frame, c, rows); return [c, v.length ? summarize(v) : { count: 0 }] }))
    const result: Record<string, unknown> = { dataset: refOf(entry), rows: frame.rows.length }
    if (groupBy) {
      const groups = new Map<string, Frame['rows']>()
      for (const row of frame.rows) { const key = String(row[groupBy] ?? '(missing)'); groups.set(key, [...(groups.get(key) ?? []), row]) }
      result.byGroup = Object.fromEntries([...groups.entries()].slice(0, 50).map(([key, rows]) => [key, describeRows(rows)]))
    } else result.numeric = describeRows(frame.rows)
    result.categorical = Object.fromEntries(categorical.map((c) => { const counts = new Map<string, number>(); for (const row of frame.rows) counts.set(String(row[c] ?? '(missing)'), (counts.get(String(row[c] ?? '(missing)')) ?? 0) + 1); return [c, [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count, share: count / frame.rows.length }))] }))
    if (ctx.params.chart === true && numeric[0]) {
      const chart = groupBy ? boxChart({ title: `${numeric[0]} by ${groupBy}`, groups: Object.entries(groupsOf(frame, numeric[0], groupBy)).slice(0, 12).map(([name, values]) => ({ name, values })) }) : histogramChart({ title: `Distribution of ${numeric[0]}`, values: numbers(frame, numeric[0]) })
      result.chart = saveChart(ctx, chart)
    }
    ctx.record.check('computed on non-missing values', 'pass', `${numeric.length} numeric and ${categorical.length} categorical columns`)
    return result
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'test',
  summary: 'hypothesis test with assumption checks, effect size, CI, and interpretation. test "auto" picks Welch t / Mann-Whitney / ANOVA / Kruskal / chi-square / Fisher from the data; post-hoc pairwise tests with correction for >2 groups',
  effect: 'compute',
  params: {
    dataset: DATASET,
    test: { type: 'string', enum: ['auto', 'welch_t', 'student_t', 'paired_t', 'one_sample_t', 'mann_whitney', 'wilcoxon', 'anova', 'welch_anova', 'kruskal', 'chi_square', 'fisher', 'two_proportion', 'shapiro', 'dagostino', 'jarque_bera', 'levene', 'bartlett', 'ks', 'correlation', 'manova'], description: 'test to run (default auto)' },
    value: { type: 'string', description: 'numeric outcome column (or categorical outcome for chi-square)' },
    group: { type: 'string', description: 'grouping column' },
    groups: { type: 'array', description: 'the group levels to compare (default: all; two-sample tests use the first two)' },
    pair: { type: 'array', description: 'two columns measured on the same rows, for paired tests' },
    x: { type: 'string', description: 'first variable (correlation)' },
    y: { type: 'string', description: 'second variable (correlation)' },
    values: { type: 'array', description: 'several outcome columns (MANOVA)' },
    method: { type: 'string', enum: ['pearson', 'spearman', 'kendall'], description: 'correlation method' },
    mu: { type: 'number', description: 'hypothesised mean for a one-sample test' },
    alternative: { type: 'string', enum: ['two-sided', 'less', 'greater'], description: 'direction of the alternative hypothesis' },
    alpha: { type: 'number', description: 'significance level (default 0.05)' },
    correction: { type: 'string', enum: CORRECTION_METHODS, description: 'multiple-comparison correction for post-hoc tests (default holm)' },
    where: WHERE,
    chart: { type: 'boolean', description: 'draw the groups being compared' },
  },
  example: { action: 'test', dataset: 'orders', value: 'amount', group: 'variant' },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const alpha = typeof ctx.params.alpha === 'number' ? ctx.params.alpha : 0.05
    const alternative = parseAlternative(ctx.params.alternative)
    let test = str(ctx, 'test', 'auto')
    const value = typeof ctx.params.value === 'string' ? ctx.params.value : undefined
    const group = typeof ctx.params.group === 'string' ? ctx.params.group : undefined
    for (const c of [value, group, ctx.params.x, ctx.params.y].filter((c): c is string => typeof c === 'string')) assertColumns(frame, [c], 'test')
    const onlyGroups = Array.isArray(ctx.params.groups) ? (ctx.params.groups as unknown[]).map(String) : undefined
    const selection: string[] = []
    let result: T.TestResult
    let posthoc: unknown
    // A 0/1 or boolean outcome compares proportions, not means.
    const categoricalValue = value ? frame.types[value] === 'boolean' || frame.rows.every((r) => isMissing(r[value]) || r[value] === 0 || r[value] === 1) : false
    const autoSelected = test === 'auto'
    if (test === 'auto') {
      if (Array.isArray(ctx.params.pair)) test = 'paired_t'
      else if (ctx.params.x && ctx.params.y) test = 'correlation'
      else if (value && group) {
        const levels = Object.keys(groupsOf(frame, value, group, onlyGroups))
        const isNumeric = frame.types[value] === 'integer' || frame.types[value] === 'number'
        if (!isNumeric || categoricalValue) test = 'chi_square'
        else if ((onlyGroups ?? levels).length === 2 || levels.length === 2) {
          const g = groupsOf(frame, value, group, onlyGroups)
          const [a, b] = Object.values(g)
          const normalish = [a!, b!].every((values) => T.normalityAssumption(values, 'x').status !== 'violated' && T.normalityAssumption(values, 'x').status !== 'questionable')
          test = normalish ? 'welch_t' : 'mann_whitney'
          selection.push(normalish ? 'both groups look approximately normal (or n ≥ 30 without heavy skew) → Welch t test (robust to unequal variances)' : 'a group is non-normal or heavily skewed with small n → Mann–Whitney U (rank-based)')
        } else {
          const g = groupsOf(frame, value, group, onlyGroups)
          const normalish = Object.values(g).every((values) => T.normalityAssumption(values, 'x').status === 'met')
          const equalVar = T.levene(g).pValue >= 0.05
          test = normalish ? (equalVar ? 'anova' : 'welch_anova') : 'kruskal'
          selection.push(normalish ? (equalVar ? 'groups approximately normal with similar variances → one-way ANOVA' : 'groups approximately normal but variances differ (Levene p < 0.05) → Welch ANOVA') : 'a group is non-normal → Kruskal–Wallis')
        }
      } else if (value) test = 'one_sample_t'
      else throw new Error('auto needs value + group (compare groups), pair (paired), x + y (association), or value alone (one-sample)')
    }
    const twoGroups = () => {
      if (!value || !group) throw new Error(`${test} needs value and group`)
      const g = groupsOf(frame, value, group, onlyGroups)
      const names = onlyGroups ?? Object.keys(g).sort()
      if (names.length < 2) throw new Error(`need two groups in ${group}; found ${names.join(', ') || 'none'}`)
      if (names.length > 2) ctx.record.warn(`${group} has ${names.length} levels; comparing the first two (${names[0]} vs ${names[1]}) — pass groups to choose`)
      return { a: g[names[0]!] ?? [], b: g[names[1]!] ?? [], names: [names[0]!, names[1]!] }
    }
    switch (test) {
      case 'welch_t':
      case 'student_t': { const { a, b, names } = twoGroups(); result = T.twoSampleT(a, b, { equalVariance: test === 'student_t', alternative }); selection.push(`difference = ${names[0]} − ${names[1]}`); break }
      case 'mann_whitney': { const { a, b, names } = twoGroups(); result = T.mannWhitney(a, b, alternative); selection.push(`U refers to ${names[0]}`); break }
      case 'ks': { const { a, b } = twoGroups(); result = T.kolmogorovSmirnov2(a, b); break }
      case 'paired_t':
      case 'wilcoxon': {
        const pair = Array.isArray(ctx.params.pair) ? (ctx.params.pair as string[]) : []
        if (pair.length !== 2) throw new Error(`${test} needs pair: [columnBefore, columnAfter]`)
        assertColumns(frame, pair, 'pair')
        const rows = frame.rows.filter((r) => toNumber(r[pair[0]!]) !== undefined && toNumber(r[pair[1]!]) !== undefined)
        const a = rows.map((r) => toNumber(r[pair[0]!])!)
        const b = rows.map((r) => toNumber(r[pair[1]!])!)
        result = test === 'paired_t' ? T.pairedT(a, b, alternative) : T.wilcoxonSignedRank(a, b, { alternative })
        break
      }
      case 'one_sample_t': { if (!value) throw new Error('one_sample_t needs value'); result = T.oneSampleT(numbers(frame, value), typeof ctx.params.mu === 'number' ? ctx.params.mu : 0, alternative); break }
      case 'anova':
      case 'welch_anova':
      case 'kruskal':
      case 'levene':
      case 'bartlett': {
        if (!value || !group) throw new Error(`${test} needs value and group`)
        const g = groupsOf(frame, value, group, onlyGroups)
        result = test === 'anova' ? T.oneWayAnova(g) : test === 'welch_anova' ? T.welchAnova(g) : test === 'kruskal' ? T.kruskalWallis(g) : test === 'levene' ? T.levene(g) : T.bartlett(g)
        if ((test === 'anova' || test === 'welch_anova' || test === 'kruskal') && Object.keys(g).length > 2) {
          const names = Object.keys(g).sort()
          const pairs: Array<{ a: string; b: string; p: number; estimate: number }> = []
          for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
            const r = test === 'kruskal' ? T.mannWhitney(g[names[i]!]!, g[names[j]!]!) : T.twoSampleT(g[names[i]!]!, g[names[j]!]!)
            pairs.push({ a: names[i]!, b: names[j]!, p: r.pValue, estimate: test === 'kruskal' ? r.effectSize!.value : r.estimate!.difference! })
          }
          const method = parseCorrection(ctx.params.correction)
          const adjusted = adjustPValues(pairs.map((pair) => pair.p), method)
          posthoc = { method: `${test === 'kruskal' ? 'pairwise Mann–Whitney' : 'pairwise Welch t'} with ${method} correction`, comparisons: pairs.map((pair, index) => ({ ...pair, adjustedP: adjusted[index], significant: adjusted[index]! < alpha })) }
        }
        break
      }
      case 'chi_square':
      case 'fisher':
      case 'two_proportion': {
        if (!value || !group) throw new Error(`${test} needs value (categorical outcome) and group`)
        const rowLevels = [...new Set(frame.rows.map((r) => r[group]).filter((v) => !isMissing(v)).map(String))].filter((l) => !onlyGroups || onlyGroups.includes(l)).sort()
        const colLevels = [...new Set(frame.rows.map((r) => r[value]).filter((v) => !isMissing(v)).map(String))].sort()
        const table = rowLevels.map((r) => colLevels.map((c) => frame.rows.filter((row) => String(row[group]) === r && String(row[value]) === c).length))
        if (rowLevels.length > 40 || colLevels.length > 40) throw new Error('the contingency table is too large (> 40 levels); group rare levels first')
        const chi = T.chiSquareIndependence(table)
        if (test === 'chi_square') {
          result = chi
          if (rowLevels.length === 2 && colLevels.length === 2 && chi.assumptions[0]!.status !== 'met') {
            if (autoSelected) { result = T.fisherExact(table, alternative); selection.push("expected counts < 5 in a 2×2 table → Fisher's exact test") }
            else ctx.record.check('chi-square validity', 'warn', "expected counts < 5 in a 2×2 table; Fisher's exact test is the valid choice")
          }
        } else if (test === 'fisher') {
          if (rowLevels.length !== 2 || colLevels.length !== 2) throw new Error("Fisher's exact test needs a 2×2 table")
          result = T.fisherExact(table, alternative)
        } else {
          if (rowLevels.length !== 2 || colLevels.length !== 2) throw new Error('two_proportion needs a binary outcome and two groups')
          result = T.twoProportionZ(table[0]![1]!, table[0]![0]! + table[0]![1]!, table[1]![1]!, table[1]![0]! + table[1]![1]!, alternative)
          selection.push(`proportion of "${colLevels[1]}" in ${rowLevels[0]} vs ${rowLevels[1]}`)
        }
        ;(result as T.TestResult & { table?: unknown }).table = { rows: rowLevels, columns: colLevels, counts: table }
        break
      }
      case 'shapiro':
      case 'dagostino':
      case 'jarque_bera': { if (!value) throw new Error(`${test} needs value`); const v = numbers(frame, value); result = test === 'shapiro' ? T.shapiroWilk(v.length > 5000 ? v.slice(0, 5000) : v) : test === 'dagostino' ? T.dagostinoPearson(v) : T.jarqueBera(v); break }
      case 'correlation': {
        const x = str(ctx, 'x')
        const y = str(ctx, 'y')
        const rows = frame.rows.filter((r) => toNumber(r[x]) !== undefined && toNumber(r[y]) !== undefined)
        result = T.correlationTest(rows.map((r) => toNumber(r[x])!), rows.map((r) => toNumber(r[y])!), (ctx.params.method as 'pearson' | 'spearman' | 'kendall') ?? 'pearson')
        break
      }
      case 'manova': {
        const outcome = list(ctx.params.values, 'values')
        if (!group || outcome.length < 2) throw new Error('manova needs group and values (two or more outcome columns)')
        assertColumns(frame, outcome, 'values')
        const g: Record<string, number[][]> = {}
        for (const row of frame.rows) { const vs = outcome.map((c) => toNumber(row[c])); if (vs.some((v) => v === undefined) || isMissing(row[group])) continue; (g[String(row[group])] ??= []).push(vs as number[]) }
        result = T.manova(g)
        break
      }
      default: throw new Error(`unknown test ${test}`)
    }
    recordAssumptions(ctx, result)
    ctx.record.check('test computed', 'pass', `${result.test}, p = ${result.pValue.toPrecision(3)}`)
    ctx.record.metric('pValue', result.pValue)
    let chart: unknown
    if (ctx.params.chart === true && value && group && (frame.types[value] === 'integer' || frame.types[value] === 'number')) chart = saveChart(ctx, boxChart({ title: `${value} by ${group}`, groups: Object.entries(groupsOf(frame, value, group, onlyGroups)).slice(0, 12).map(([name, values]) => ({ name, values })) }))
    return { dataset: refOf(entry), testUsed: test, selection, ...result, interpretation: interpret(result, alpha), ...(posthoc ? { posthoc } : {}), ...(chart ? { chart } : {}) }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'correlations',
  summary: 'correlation matrix (Pearson/Spearman/Kendall) with p-values corrected for multiple testing and a heatmap',
  effect: 'compute',
  params: { dataset: DATASET, columns: { type: 'string|array', description: 'numeric columns (default: all numeric, up to 30)' }, method: { type: 'string', enum: ['pearson', 'spearman', 'kendall'], description: 'default spearman (robust to outliers and monotone non-linearity)' }, correction: { type: 'string', enum: CORRECTION_METHODS, description: 'default fdr_bh' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const cols = list(ctx.params.columns, 'columns')
    assertColumns(frame, cols, 'columns')
    const numeric = (cols.length ? cols : frame.columns.filter((c) => frame.types[c] === 'integer' || frame.types[c] === 'number')).slice(0, 30)
    if (numeric.length < 2) throw new Error('need at least two numeric columns')
    const method = (ctx.params.method as 'pearson' | 'spearman' | 'kendall') ?? 'spearman'
    const pairs: Array<{ a: string; b: string; r: number; p: number; n: number }> = []
    const matrix = numeric.map(() => numeric.map(() => null as number | null))
    numeric.forEach((a, i) => { matrix[i]![i] = 1; numeric.forEach((b, j) => {
      if (j <= i) return
      const rows = frame.rows.filter((r) => toNumber(r[a]) !== undefined && toNumber(r[b]) !== undefined)
      if (rows.length < 4) return
      const t = T.correlationTest(rows.map((r) => toNumber(r[a])!), rows.map((r) => toNumber(r[b])!), method)
      matrix[i]![j] = t.statistic; matrix[j]![i] = t.statistic
      pairs.push({ a, b, r: t.statistic, p: t.pValue, n: rows.length })
    }) })
    const correction = ctx.params.correction ? parseCorrection(ctx.params.correction) : 'fdr_bh'
    const adjusted = adjustPValues(pairs.map((p) => p.p), correction)
    const ranked = pairs.map((p, i) => ({ ...p, adjustedP: adjusted[i]! })).sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
    const chart = saveChart(ctx, heatmapChart({ title: `${method[0]!.toUpperCase()}${method.slice(1)} correlations`, subtitle: `${entry.name}; association, not causation`, xLabels: numeric, yLabels: numeric, values: matrix, diverging: true, domain: [-1, 1] }))
    ctx.record.check('pairwise complete cases', 'pass', `${pairs.length} pairs, ${correction} correction`)
    const strong = ranked.filter((p) => Math.abs(p.r) > 0.9)
    if (strong.length) ctx.record.check('near-collinear pairs', 'warn', strong.map((p) => `${p.a}~${p.b} (${p.r.toFixed(2)})`).join(', '))
    return { dataset: refOf(entry), method, correction, strongest: ranked.slice(0, 25), chart, note: 'Correlation measures association in this sample; it does not establish causation and can be driven by confounders or outliers.' }
  },
})

function regressionOutput(ctx: ActionContext, result: RegressionResult, dropped: number, total: number) {
  for (const assumption of result.assumptions) ctx.record.check(`assumption: ${assumption.name}`, assumption.status === 'violated' ? 'warn' : assumption.status === 'questionable' ? 'warn' : 'pass', assumption.detail)
  ctx.record.check('rows used', dropped / Math.max(1, total) > 0.2 ? 'warn' : 'pass', `${total - dropped} of ${total} rows complete (${dropped} dropped listwise)`)
  if (result.diagnostics.converged === false) ctx.record.check('model converged', 'fail', 'the fitting algorithm did not converge')
  const { fitted: _f, residuals: _r, ...rest } = result
  return { ...rest, rowsUsed: total - dropped, rowsDropped: dropped }
}

registerCapability({
  tool: 'ds_stats',
  action: 'regression',
  summary: 'regression with inference: OLS (classical/HC3/cluster-robust SEs, VIF, residual diagnostics), logistic (odds ratios), Poisson / negative binomial (rate ratios, offsets), Huber robust, random-intercept mixed model',
  effect: 'compute',
  params: {
    dataset: DATASET,
    target: { type: 'string', required: true, description: 'outcome column' },
    features: { type: 'string|array', required: true, description: 'predictor columns (categoricals are dummy-coded against their most common level)' },
    model: { type: 'string', enum: ['ols', 'logistic', 'poisson', 'negative_binomial', 'robust', 'mixed'], description: 'default: ols for numeric targets, logistic for binary ones' },
    covariance: { type: 'string', enum: ['classical', 'HC3', 'cluster'], description: 'OLS standard errors (default classical; HC3 when heteroskedastic)' },
    cluster: { type: 'string', description: 'cluster column for cluster-robust SEs' },
    group: { type: 'string', description: 'grouping column for the mixed model' },
    categorical: { type: 'string|array', description: 'numeric columns to treat as categories' },
    reference: { type: 'object', description: 'reference level per categorical feature' },
    interactions: { type: 'array', description: 'pairs of features, e.g. [["price", "region"]]' },
    offset: { type: 'string', description: 'exposure column for count models (its log is used as the offset)' },
    positiveClass: { type: 'string', description: 'the outcome value counted as 1 for logistic regression' },
    level: { type: 'number', description: 'confidence level (default 0.95)' },
    where: WHERE,
  },
  example: { action: 'regression', dataset: 'orders', target: 'amount', features: ['discount', 'region'], covariance: 'HC3' },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const target = str(ctx, 'target')
    const features = list(ctx.params.features, 'features')
    const isBinary = new Set(frame.rows.map((r) => r[target]).filter((v) => !isMissing(v)).map((v) => scalarKey(v ?? null))).size === 2
    const model = str(ctx, 'model', isBinary ? 'logistic' : 'ols')
    const level = typeof ctx.params.level === 'number' ? ctx.params.level : 0.95
    const spec = { target, features, categorical: list(ctx.params.categorical, 'categorical'), ...(ctx.params.reference ? { reference: ctx.params.reference as Record<string, string> } : {}), ...(Array.isArray(ctx.params.interactions) ? { interactions: ctx.params.interactions as Array<[string, string]> } : {}) }
    const transform = model === 'logistic' ? binaryTarget(frame, target, typeof ctx.params.positiveClass === 'string' ? ctx.params.positiveClass : undefined) : undefined
    const design = buildDesign(frame, spec, transform?.transform)
    ctx.record.code('expression', `${target} ~ ${design.names.filter((n) => n !== '(Intercept)').join(' + ')}`)
    let result: RegressionResult
    const rowsAt = (column: string) => design.rowIndex.map((i) => frame.rows[i]![column])
    switch (model) {
      case 'ols': {
        const covariance = (ctx.params.covariance as 'classical' | 'HC3' | 'cluster') ?? 'classical'
        const clusterColumn = typeof ctx.params.cluster === 'string' ? ctx.params.cluster : undefined
        if (covariance === 'cluster' && !clusterColumn) throw new Error('cluster covariance needs cluster (the clustering column)')
        result = ols(design.x, design.y!, design.names, { level, covariance, ...(clusterColumn ? { clusters: rowsAt(clusterColumn).map(String) } : {}) })
        break
      }
      case 'logistic': result = logisticRegression(design.x, design.y!, design.names, { level }); break
      case 'poisson':
      case 'negative_binomial': {
        const offsetColumn = typeof ctx.params.offset === 'string' ? ctx.params.offset : undefined
        const offset = offsetColumn ? rowsAt(offsetColumn).map((v) => { const n = toNumber(v); if (!n || n <= 0) throw new Error(`offset column ${offsetColumn} must be positive`); return Math.log(n) }) : undefined
        result = model === 'poisson' ? poissonRegression(design.x, design.y!, design.names, { level, ...(offset ? { offset } : {}) }) : negativeBinomialRegression(design.x, design.y!, design.names, { level, ...(offset ? { offset } : {}) })
        break
      }
      case 'robust': result = huberRegression(design.x, design.y!, design.names, { level }); break
      case 'mixed': result = randomInterceptModel(design.x, design.y!, design.names, rowsAt(str(ctx, 'group')).map(String), { level }); break
      default: throw new Error(`unknown model ${model}`)
    }
    ctx.record.metric('parameters', result.parameters)
    return { dataset: refOf(entry), ...regressionOutput(ctx, result, design.droppedRows, frame.rows.length), modelKind: model, ...(transform ? { positiveClass: transform.positive } : {}), encoding: design.categorical }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'power',
  summary: 'statistical power or required sample size for t-tests, two proportions, ANOVA, correlation, and chi-square',
  effect: 'compute',
  params: {
    kind: { type: 'string', required: true, enum: ['t_test', 'proportions', 'anova', 'correlation', 'chi_square'], description: 'test family' },
    effectSize: { type: 'number', description: "Cohen's d (t_test), f (anova), w (chi_square)" },
    p1: { type: 'number', description: 'baseline proportion' },
    p2: { type: 'number', description: 'alternative proportion' },
    r: { type: 'number', description: 'correlation to detect' },
    n: { type: 'integer', description: 'sample size per group (to compute power)' },
    power: { type: 'number', description: 'target power (to compute n), e.g. 0.8' },
    alpha: { type: 'number', description: 'default 0.05' },
    design: { type: 'string', enum: ['two-sample', 'one-sample', 'paired'], description: 't-test design' },
    alternative: { type: 'string', enum: ['two-sided', 'less', 'greater'], description: 'default two-sided' },
    ratio: { type: 'number', description: 'n2/n1 allocation ratio' },
    groups: { type: 'integer', description: 'number of groups (anova)' },
    df: { type: 'integer', description: 'degrees of freedom (chi_square)' },
  },
  run(ctx) {
    const kind = str(ctx, 'kind')
    const alpha = typeof ctx.params.alpha === 'number' ? ctx.params.alpha : 0.05
    const n = typeof ctx.params.n === 'number' ? ctx.params.n : undefined
    const target = typeof ctx.params.power === 'number' ? ctx.params.power : undefined
    if (n === undefined && target === undefined) throw new Error('give n (to compute power) or power (to compute the sample size)')
    const alternative = parseAlternative(ctx.params.alternative)
    let out: Record<string, unknown>
    switch (kind) {
      case 't_test': {
        const d = typeof ctx.params.effectSize === 'number' ? ctx.params.effectSize : undefined
        if (d === undefined) throw new Error("t_test needs effectSize (Cohen's d)")
        const options = { alpha, alternative, design: (ctx.params.design as 'two-sample' | 'one-sample' | 'paired') ?? 'two-sample', ...(typeof ctx.params.ratio === 'number' ? { ratio: ctx.params.ratio } : {}) }
        out = n !== undefined ? { power: tTestPower(d, n, options) } : { ...tTestSampleSize(d, target!, options) }
        out.method = 'exact noncentral t'
        break
      }
      case 'proportions': {
        const p1 = typeof ctx.params.p1 === 'number' ? ctx.params.p1 : NaN
        const p2 = typeof ctx.params.p2 === 'number' ? ctx.params.p2 : NaN
        if (!Number.isFinite(p1) || !Number.isFinite(p2)) throw new Error('proportions needs p1 and p2')
        out = n !== undefined ? { power: proportionsPower(p1, p2, n, { alpha, alternative }) } : { ...proportionsSampleSize(p1, p2, target!, { alpha, alternative }) }
        out.method = 'normal approximation (pooled null variance)'
        break
      }
      case 'anova': { const f = Number(ctx.params.effectSize); const k = Number(ctx.params.groups ?? 3); out = n !== undefined ? { power: anovaPower(f, k, n, alpha) } : { ...anovaSampleSize(f, k, target!, alpha) }; out.method = 'noncentral F'; break }
      case 'correlation': { const r = Number(ctx.params.r); out = n !== undefined ? { power: correlationPower(r, n, alpha) } : { ...correlationSampleSize(r, target!, alpha) }; out.method = 'Fisher z approximation'; break }
      case 'chi_square': { const w = Number(ctx.params.effectSize); const df = Number(ctx.params.df ?? 1); out = n !== undefined ? { power: chiSquarePower(w, df, n, alpha) } : { ...chiSquareSampleSize(w, df, target!, alpha) }; out.method = 'noncentral chi-square'; break }
      default: throw new Error(`unknown kind ${kind}`)
    }
    ctx.record.check('power computed', 'pass', JSON.stringify(out).slice(0, 200))
    return { kind, alpha, ...out, note: 'Power depends on the assumed effect size; justify it from prior data or the smallest effect that matters, not from what would make the study look feasible.' }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'multiple_testing',
  summary: 'adjust a list of p-values (Bonferroni, Holm, Hochberg, Benjamini–Hochberg, Benjamini–Yekutieli)',
  effect: 'compute',
  params: { pValues: { type: 'array', required: true, description: 'p-values' }, labels: { type: 'array', description: 'names for each p-value' }, method: { type: 'string', enum: CORRECTION_METHODS, description: 'default holm (family-wise); fdr_bh for many exploratory tests' }, alpha: { type: 'number', description: 'default 0.05' } },
  run(ctx) {
    const p = (ctx.params.pValues as unknown[]).map(Number)
    const method = parseCorrection(ctx.params.method)
    const alpha = typeof ctx.params.alpha === 'number' ? ctx.params.alpha : 0.05
    const adjusted = adjustPValues(p, method)
    const labels = Array.isArray(ctx.params.labels) ? (ctx.params.labels as unknown[]).map(String) : p.map((_, i) => `test ${i + 1}`)
    ctx.record.check('adjusted', 'pass', `${p.length} p-values, ${method}`)
    return { method, results: p.map((value, i) => ({ label: labels[i], p: value, adjusted: adjusted[i], significant: adjusted[i]! < alpha })) }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'bootstrap',
  summary: 'bootstrap confidence interval (BCa) for a statistic of one column, or for the difference/ratio between two groups; optional permutation test',
  effect: 'compute',
  params: { dataset: DATASET, column: { type: 'string', required: true, description: 'numeric column' }, statistic: { type: 'string', enum: STATISTICS, description: 'default mean' }, group: { type: 'string', description: 'group column for a two-sample comparison' }, groups: { type: 'array', description: 'the two group levels' }, comparison: { type: 'string', enum: ['difference', 'ratio'], description: 'two-sample comparison' }, permutation: { type: 'boolean', description: 'also run a permutation test of the group difference' }, resamples: { type: 'integer', description: 'default 5000' }, level: { type: 'number', description: 'default 0.95' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const column = str(ctx, 'column')
    assertColumns(frame, [column], 'column')
    const statistic = (ctx.params.statistic as StatisticName) ?? 'mean'
    const fn = statisticFunction(statistic)
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    ctx.record.seed(seed)
    const options = { seed, ...(typeof ctx.params.resamples === 'number' ? { resamples: ctx.params.resamples } : {}), ...(typeof ctx.params.level === 'number' ? { level: ctx.params.level } : {}) }
    if (typeof ctx.params.group === 'string') {
      const g = groupsOf(frame, column, ctx.params.group, Array.isArray(ctx.params.groups) ? (ctx.params.groups as string[]).map(String) : undefined)
      const names = Array.isArray(ctx.params.groups) ? (ctx.params.groups as string[]).map(String) : Object.keys(g).sort().slice(0, 2)
      const a = g[names[0]!] ?? []
      const b = g[names[1]!] ?? []
      const result = bootstrapTwoSample(a, b, fn, { ...options, comparison: (ctx.params.comparison as 'difference' | 'ratio') ?? 'difference' })
      const permutation = ctx.params.permutation === true ? permutationTest(a, b, fn, { seed }) : undefined
      ctx.record.check('resamples', 'pass', `${result.resamples} resamples, seed ${seed}`)
      return { dataset: refOf(entry), statistic, groups: names, ...result, ...(permutation ? { permutation } : {}) }
    }
    const result = bootstrap(numbers(frame, column), fn, options)
    ctx.record.check('resamples', 'pass', `${result.resamples} resamples, seed ${seed}`)
    return { dataset: refOf(entry), statistic, ...result }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'ab_test',
  summary: 'analyse an experiment: lift with CIs, p-values, sample-ratio-mismatch check, CUPED variance reduction, multiple-variant correction, per-segment effects, guardrail metrics, and power',
  effect: 'compute',
  params: {
    dataset: { type: 'string', description: 'unit-level data (one row per randomised unit); or pass variants with summary counts' },
    variant: { type: 'string', description: 'variant/assignment column' },
    metric: { type: 'string', description: 'outcome column (0/1 for conversion, numeric for means)' },
    metricType: { type: 'string', enum: ['proportion', 'mean'], description: 'default: proportion for 0/1 metrics' },
    control: { type: 'string', required: true, description: 'control variant label' },
    covariate: { type: 'string', description: 'pre-experiment covariate for CUPED' },
    variants: { type: 'array', description: 'summary data instead of a dataset: [{ "name": "A", "successes": 500, "n": 10000 }, …]' },
    expectedShares: { type: 'array', description: 'designed allocation shares (default equal)' },
    minimumEffect: { type: 'number', description: 'smallest absolute effect that matters (practical significance)' },
    alpha: { type: 'number', description: 'default 0.05' },
    correction: { type: 'string', enum: ['holm', 'bonferroni', 'fdr_bh'], description: 'for several treatments' },
    segment: { type: 'string', description: 'segment column for heterogeneous effects (Holm-corrected)' },
    guardrails: { type: 'array', description: '[{ "metric": "refund_rate", "harmful": "increase", "tolerance": 0.002 }]' },
    where: WHERE,
  },
  run(ctx) {
    const control = str(ctx, 'control')
    const alpha = typeof ctx.params.alpha === 'number' ? ctx.params.alpha : 0.05
    let variants: VariantData[]
    let metricType = ctx.params.metricType as 'proportion' | 'mean' | undefined
    let frame: Frame | undefined
    let datasetRef: string | undefined
    if (Array.isArray(ctx.params.variants)) {
      variants = (ctx.params.variants as Array<Record<string, unknown>>).map((v) => ({ name: String(v.name), ...(typeof v.successes === 'number' ? { successes: v.successes } : {}), ...(typeof v.n === 'number' ? { n: v.n } : {}) }))
      metricType ??= 'proportion'
    } else {
      const loaded = ctx.dataset(str(ctx, 'dataset'))
      frame = loaded.frame
      datasetRef = refOf(loaded.entry)
      const variantColumn = str(ctx, 'variant')
      const metric = str(ctx, 'metric')
      assertColumns(frame, [variantColumn, metric], 'ab_test')
      const values = frame.rows.map((r) => toNumber(r[metric])).filter((v): v is number => v !== undefined)
      metricType ??= values.every((v) => v === 0 || v === 1) ? 'proportion' : 'mean'
      const covariate = typeof ctx.params.covariate === 'string' ? ctx.params.covariate : undefined
      const byVariant = new Map<string, { values: number[]; covariate: number[] }>()
      for (const row of frame.rows) {
        const v = toNumber(row[metric])
        const c = covariate ? toNumber(row[covariate]) : 0
        if (v === undefined || c === undefined || isMissing(row[variantColumn])) continue
        const entry = byVariant.get(String(row[variantColumn])) ?? { values: [], covariate: [] }
        entry.values.push(v)
        entry.covariate.push(c)
        byVariant.set(String(row[variantColumn]), entry)
      }
      variants = [...byVariant.entries()].map(([name, data]) => ({ name, values: data.values, ...(covariate ? { covariate: data.covariate } : {}) }))
    }
    const result = analyzeAbTest({ variants, control, metricType, alpha, ...(Array.isArray(ctx.params.expectedShares) ? { expectedShares: (ctx.params.expectedShares as number[]).map(Number) } : {}), ...(typeof ctx.params.minimumEffect === 'number' ? { minimumEffect: ctx.params.minimumEffect } : {}), ...(ctx.params.correction ? { correction: ctx.params.correction as 'holm' } : {}) })
    if (result.srm) ctx.record.check('sample ratio', result.srm.failed ? 'fail' : 'pass', `chi-square p = ${result.srm.pValue.toPrecision(3)} for allocation ${result.srm.observed.join('/')}`)
    for (const row of result.results) if (row.power !== null && row.power < 0.8) ctx.record.check(`power (${row.treatment})`, 'warn', `${(row.power * 100).toFixed(0)}% power for the minimum effect`)
    let segments: unknown
    if (frame && typeof ctx.params.segment === 'string') {
      const segmentColumn = ctx.params.segment
      assertColumns(frame, [segmentColumn], 'segment')
      const levels = [...new Set(frame.rows.map((r) => String(r[segmentColumn] ?? '(missing)')))].slice(0, 30)
      const variantColumn = str(ctx, 'variant')
      const metric = str(ctx, 'metric')
      const perSegment = levels.map((level) => {
        const rows = frame!.rows.filter((r) => String(r[segmentColumn] ?? '(missing)') === level)
        const vs = [...new Set(rows.map((r) => String(r[variantColumn])))].map((name) => ({ name, values: rows.filter((r) => String(r[variantColumn]) === name).map((r) => toNumber(r[metric])).filter((v): v is number => v !== undefined) }))
        try { const r = analyzeAbTest({ variants: vs, control, metricType: metricType!, alpha }).results[0]!; return { segment: level, n: rows.length, lift: r.absoluteLift, relativeLift: r.relativeLift, ci: r.ci, p: r.pValue } } catch (error) { return { segment: level, n: rows.length, error: (error as Error).message } }
      })
      const ps = perSegment.map((s) => ('p' in s && typeof s.p === 'number' ? s.p : 1))
      const adjusted = adjustPValues(ps, 'holm')
      segments = { note: 'Segment effects are exploratory; with many segments some will look different by chance (Holm-adjusted p shown).', results: perSegment.map((s, i) => ({ ...s, adjustedP: adjusted[i] })) }
    }
    let guardrails: unknown
    if (frame && Array.isArray(ctx.params.guardrails)) {
      const variantColumn = str(ctx, 'variant')
      guardrails = (ctx.params.guardrails as Array<Record<string, unknown>>).map((g) => {
        const metric = String(g.metric)
        assertColumns(frame!, [metric], 'guardrail')
        const vs = [...new Set(frame!.rows.map((r) => String(r[variantColumn])))].map((name) => ({ name, values: frame!.rows.filter((r) => String(r[variantColumn]) === name).map((r) => toNumber(r[metric])).filter((v): v is number => v !== undefined) }))
        const type = vs.every((v) => v.values.every((x) => x === 0 || x === 1)) ? 'proportion' : 'mean'
        const r = analyzeAbTest({ variants: vs, control, metricType: type, alpha }).results
        const tolerance = typeof g.tolerance === 'number' ? g.tolerance : 0
        const harmful = g.harmful === 'decrease' ? 'decrease' : 'increase'
        const breaches = r.filter((row) => (harmful === 'increase' ? row.ci[0] > tolerance : row.ci[1] < -tolerance))
        const possible = r.filter((row) => (harmful === 'increase' ? row.ci[1] > tolerance : row.ci[0] < -tolerance))
        ctx.record.check(`guardrail ${metric}`, breaches.length ? 'fail' : possible.length ? 'warn' : 'pass', breaches.length ? `${breaches.map((b) => b.treatment).join(', ')} harm ${metric} beyond the tolerance` : possible.length ? `cannot rule out harm to ${metric} beyond ${tolerance}` : `${metric} not harmed beyond ${tolerance}`)
        return { metric, harmful, tolerance, results: r.map((row) => ({ treatment: row.treatment, lift: row.absoluteLift, ci: row.ci })) }
      })
    }
    ctx.record.check('effects estimated', 'pass', `${result.results.length} comparison(s)`)
    return { ...(datasetRef ? { dataset: datasetRef } : {}), ...result, ...(segments ? { segments } : {}), ...(guardrails ? { guardrails } : {}), structure: 'Hypothesis → Method → Sample → Result → Statistical evidence → Interpretation → Limitations' }
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'design_experiment',
  summary: 'plan an experiment: sample size per variant, duration from traffic, multiple-variant alpha, MDE at four weeks, and guardrail guidance',
  effect: 'compute',
  params: { metricType: { type: 'string', required: true, enum: ['proportion', 'mean'], description: 'conversion rate or continuous mean' }, baseline: { type: 'number', required: true, description: 'baseline rate or mean' }, minimumEffect: { type: 'number', required: true, description: 'smallest effect worth detecting' }, relative: { type: 'boolean', description: 'minimumEffect is relative (e.g. 0.05 = +5%)' }, sd: { type: 'number', description: 'standard deviation (mean metrics)' }, alpha: { type: 'number', description: 'default 0.05' }, power: { type: 'number', description: 'default 0.8' }, variants: { type: 'integer', description: 'arms including control (default 2)' }, dailyTraffic: { type: 'number', description: 'eligible units per day' }, allocation: { type: 'number', description: 'share of traffic in the experiment (default 1)' } },
  run(ctx) {
    const plan = designExperiment({ metricType: ctx.params.metricType as 'proportion' | 'mean', baseline: Number(ctx.params.baseline), minimumEffect: Number(ctx.params.minimumEffect), ...(ctx.params.relative === true ? { relative: true } : {}), ...(typeof ctx.params.sd === 'number' ? { sd: ctx.params.sd } : {}), ...(typeof ctx.params.alpha === 'number' ? { alpha: ctx.params.alpha } : {}), ...(typeof ctx.params.power === 'number' ? { power: ctx.params.power } : {}), ...(typeof ctx.params.variants === 'number' ? { variants: ctx.params.variants } : {}), ...(typeof ctx.params.dailyTraffic === 'number' ? { dailyTraffic: ctx.params.dailyTraffic } : {}), ...(typeof ctx.params.allocation === 'number' ? { allocation: ctx.params.allocation } : {}) })
    ctx.record.check('design computed', 'pass', `${plan.perVariant} per variant`)
    return plan
  },
})

registerCapability({
  tool: 'ds_stats',
  action: 'causal',
  summary: 'causal estimation with explicit assumptions: difference-in-differences, propensity scores (IPW, matching, doubly robust AIPW), regression discontinuity, instrumental variables (2SLS), synthetic control, DAG adjustment-set analysis',
  effect: 'compute',
  params: {
    method: { type: 'string', required: true, enum: ['did', 'propensity', 'rdd', 'iv', 'synthetic_control', 'dag'], description: 'estimator' },
    dataset: { type: 'string', description: 'dataset (not needed for dag)' },
    outcome: { type: 'string', description: 'outcome column' },
    treatment: { type: 'string', description: 'treatment indicator (0/1) column, or the treatment node for dag' },
    post: { type: 'string', description: 'did: post-period indicator column (0/1)' },
    time: { type: 'string', description: 'did: period column for the pre-trend test; synthetic_control: time column' },
    unit: { type: 'string', description: 'did: unit id for cluster-robust errors; synthetic_control: unit column' },
    covariates: { type: 'string|array', description: 'confounders (propensity) or exogenous controls (did/iv)' },
    running: { type: 'string', description: 'rdd: running variable' },
    cutoff: { type: 'number', description: 'rdd: threshold' },
    bandwidth: { type: 'number', description: 'rdd: bandwidth (default rule of thumb)' },
    endogenous: { type: 'string', description: 'iv: endogenous regressor' },
    instruments: { type: 'string|array', description: 'iv: instrument columns' },
    treatedUnit: { type: 'string', description: 'synthetic_control: the treated unit label' },
    treatmentStart: { type: 'string', description: 'synthetic_control: first treated period (value of the time column)' },
    edges: { type: 'array', description: 'dag: [["age", "treatment"], ["age", "outcome"], …]' },
    controls: { type: 'string|array', description: 'dag: variables you plan to adjust for (checked for bad controls)' },
    seed: SEED,
    where: WHERE,
  },
  run(ctx) {
    const method = str(ctx, 'method')
    if (method === 'dag') {
      const result = analyzeDag({ edges: (ctx.params.edges as Array<[string, string]>) ?? [], treatment: str(ctx, 'treatment'), outcome: str(ctx, 'outcome'), controls: list(ctx.params.controls, 'controls') })
      ctx.record.check('graph is acyclic', 'pass', `${result.nodes.length} nodes`)
      if (result.badControls.length) ctx.record.check('bad controls', 'warn', result.badControls.map((b) => `${b.variable}: ${b.reason}`).join('; '))
      return result
    }
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const num = (row: Record<string, unknown>, c: string) => toNumber(row[c])
    const needed = (cols: string[]) => { assertColumns(frame, cols, method); return frame.rows.filter((row) => cols.every((c) => num(row, c) !== undefined)) }
    const covariates = list(ctx.params.covariates, 'covariates')
    let result: Record<string, unknown>
    if (method === 'did') {
      const outcome = str(ctx, 'outcome'); const treatment = str(ctx, 'treatment'); const post = str(ctx, 'post')
      const time = typeof ctx.params.time === 'string' ? ctx.params.time : undefined
      const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : undefined
      const rows = needed([outcome, treatment, post, ...covariates, ...(time ? [] : [])])
      const r = differenceInDifferences({ y: rows.map((row) => num(row, outcome)!), treated: rows.map((row) => num(row, treatment)!), post: rows.map((row) => num(row, post)!), ...(covariates.length ? { controls: rows.map((row) => covariates.map((c) => num(row, c)!)), controlNames: covariates } : {}), ...(unit ? { clusters: rows.map((row) => String(row[unit])) } : {}), ...(time ? { time: rows.map((row) => num(row, time) ?? toDateMs(row[time]) ?? 0) } : {}) })
      result = r
      for (const a of r.assumptions) if (a.status !== 'not-checked') ctx.record.check(`assumption: ${a.name}`, a.status === 'violated' ? 'fail' : 'pass', a.detail)
    } else if (method === 'propensity') {
      const outcome = str(ctx, 'outcome'); const treatment = str(ctx, 'treatment')
      if (!covariates.length) throw new Error('propensity needs covariates (the confounders)')
      const rows = needed([outcome, treatment, ...covariates])
      const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
      ctx.record.seed(seed)
      const r = propensityAnalysis({ y: rows.map((row) => num(row, outcome)!), treated: rows.map((row) => num(row, treatment)!), x: rows.map((row) => covariates.map((c) => num(row, c)!)), names: covariates, seed })
      result = r as unknown as Record<string, unknown>
      for (const a of r.assumptions) if (a.status !== 'not-checked') ctx.record.check(`assumption: ${a.name}`, a.status === 'violated' ? 'warn' : a.status === 'questionable' ? 'warn' : 'pass', a.detail)
    } else if (method === 'rdd') {
      const outcome = str(ctx, 'outcome'); const running = str(ctx, 'running')
      const rows = needed([outcome, running])
      const r = regressionDiscontinuity({ y: rows.map((row) => num(row, outcome)!), running: rows.map((row) => num(row, running)!), cutoff: Number(ctx.params.cutoff), ...(typeof ctx.params.bandwidth === 'number' ? { bandwidth: ctx.params.bandwidth } : {}) })
      result = r as unknown as Record<string, unknown>
      for (const a of r.assumptions) if (a.status !== 'not-checked') ctx.record.check(`assumption: ${a.name}`, a.status === 'violated' ? 'warn' : 'pass', a.detail)
    } else if (method === 'iv') {
      const outcome = str(ctx, 'outcome'); const endogenous = str(ctx, 'endogenous'); const instruments = list(ctx.params.instruments, 'instruments')
      if (!instruments.length) throw new Error('iv needs instruments')
      const rows = needed([outcome, endogenous, ...instruments, ...covariates])
      const r = twoStageLeastSquares({ y: rows.map((row) => num(row, outcome)!), endogenous: rows.map((row) => num(row, endogenous)!), instruments: rows.map((row) => instruments.map((c) => num(row, c)!)), ...(covariates.length ? { exogenous: rows.map((row) => covariates.map((c) => num(row, c)!)) } : {}) })
      result = r as unknown as Record<string, unknown>
      ctx.record.check('instrument strength', r.weakInstruments ? 'fail' : 'pass', `first-stage F = ${r.firstStageF.toFixed(2)}`)
    } else if (method === 'synthetic_control') {
      const outcome = str(ctx, 'outcome'); const unit = str(ctx, 'unit'); const time = str(ctx, 'time'); const treatedUnit = str(ctx, 'treatedUnit'); const start = str(ctx, 'treatmentStart')
      assertColumns(frame, [outcome, unit, time], 'synthetic_control')
      const periods = [...new Set(frame.rows.map((r) => String(r[time])))].sort()
      const series = new Map<string, number[]>()
      for (const row of frame.rows) { const u = String(row[unit]); const i = periods.indexOf(String(row[time])); const v = num(row, outcome); if (v === undefined) continue; const s = series.get(u) ?? new Array<number>(periods.length).fill(Number.NaN); s[i] = v; series.set(u, s) }
      const complete = [...series.entries()].filter(([, s]) => s.every(Number.isFinite))
      const treated = complete.find(([u]) => u === treatedUnit)
      if (!treated) throw new Error(`treated unit "${treatedUnit}" has no complete series`)
      const preperiods = periods.indexOf(start)
      if (preperiods < 3) throw new Error('synthetic control needs at least 3 pre-treatment periods')
      const r = syntheticControl({ treated: treated[1], donors: Object.fromEntries(complete.filter(([u]) => u !== treatedUnit)), preperiods })
      result = { ...r, periods }
      ctx.record.check('placebo inference', r.placebo.pValue <= 0.1 ? 'pass' : 'warn', `rank ${r.placebo.rank} of ${r.placebo.of}`)
    } else throw new Error(`unknown method ${method}`)
    ctx.record.check('estimate computed', 'pass', method)
    return { dataset: refOf(entry), method, ...result, caution: 'This estimate is causal only if the listed assumptions hold; untestable assumptions (no unmeasured confounding, exclusion restriction, parallel trends) must be argued from domain knowledge, not from this output.' }
  },
})

