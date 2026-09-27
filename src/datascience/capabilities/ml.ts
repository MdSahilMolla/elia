import { registerCapability, type ActionContext } from '../engine.ts'
import { assertColumns, frameFromRows, type Frame } from '../frame.ts'
import { driftAgainstProfile, predictWithArtifact, trainAutoML, trainingProfile, binShares, populationStabilityIndex, type ModelArtifact } from '../ml/automl.ts'
import { explainPrediction, partialDependence } from '../ml/explain.ts'
import { classificationMetrics, regressionMetrics, LOWER_IS_BETTER, metricValue } from '../ml/metrics.ts'
import { ALGORITHMS, type Algorithm } from '../ml/models.ts'
import { fitPreprocessor, transformRows } from '../ml/preprocess.ts'
import { dbscan, gaussianMixture, isolationForest, kMeans, localOutlierFactor, mahalanobis, nmf, pca, robustZ, silhouette, spectralClustering, suggestEps, tsne, wardHierarchical } from '../ml/unsupervised.ts'
import { evaluateRecommenders, buildRecommender, type RecommenderMethod } from '../recsys.ts'
import { createRng } from '../rng.ts'
import { mean } from '../stats/describe.ts'
import { kolmogorovSmirnov2 } from '../stats/tests.ts'
import { understandDataset } from '../understand.ts'
import { barChart, lineChart, scatterChart } from '../viz.ts'
import { isMissing, toDateMs, toNumber, type Row } from '../values.ts'
import { assertDatasetName, refOf } from '../workspace.ts'
import { DATASET, list, outputName, preview, saveChart, SEED, str, WHERE } from './common.ts'

function seedOf(ctx: ActionContext): number {
  const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
  ctx.record.seed(seed)
  return seed
}

function numericMatrix(frame: Frame, features: string[], standardize: boolean): { x: number[][]; rows: number[]; names: string[] } {
  const rows = frame.rows.map((_, i) => i)
  const pre = fitPreprocessor(frame, rows, features, { scale: standardize })
  return { x: transformRows(pre, frame, rows), rows, names: pre.outputNames }
}

function defaultFeatures(frame: Frame, given: string[]): string[] {
  if (given.length) return given
  const u = understandDataset(frame)
  return u.profiles.filter((p) => p.role === 'measure' || (p.role === 'flag' && p.type !== 'string')).map((p) => p.name)
}

registerCapability({
  tool: 'ds_ml',
  action: 'train',
  summary: 'AutoML: detect the task, screen leakage, choose a CV plan (stratified/grouped/time-series), compare models on the same folds, select with the one-standard-error rule, score once on an untouched holdout vs a baseline, check calibration/overfitting/fairness, explain with permutation importance, and register a versioned model',
  effect: 'local-write',
  params: {
    dataset: DATASET,
    target: { type: 'string', required: true, description: 'column to predict' },
    name: { type: 'string', description: 'model name in the registry (default <target>_model)' },
    features: { type: 'string|array', description: 'feature columns (default: every usable column; identifiers, constants, text, and leakage suspects are excluded with reasons)' },
    task: { type: 'string', enum: ['auto', 'regression', 'binary', 'multiclass'], description: 'default auto' },
    algorithms: { type: 'array', description: `candidates from ${Object.keys(ALGORITHMS).join(', ')} (default: a task-appropriate set)` },
    metric: { type: 'string', description: 'selection metric, e.g. rmse, mae, r2, rocAuc, prAuc, f1, macroF1, logLoss, accuracy (default chosen by task and class balance)' },
    cvStrategy: { type: 'string', enum: ['kfold', 'stratified', 'group', 'timeseries'], description: 'default: timeseries when timeColumn is given, group when groupColumn is given, stratified for classification' },
    folds: { type: 'integer', description: 'CV folds (default 5; 3 below 200 rows)' },
    groupColumn: { type: 'string', description: 'rows sharing this value stay in the same fold (e.g. customer_id)' },
    timeColumn: { type: 'string', description: 'order rows by time: train on the past, validate on the future' },
    gap: { type: 'integer', description: 'rows skipped between train and test in time-series CV' },
    testFraction: { type: 'number', description: 'holdout share (default 0.2)' },
    params: { type: 'object', description: 'hyperparameters per algorithm, e.g. { "gradient_boosting": { "nEstimators": 500 } }' },
    tune: { type: 'boolean', description: 'random-search hyperparameters on the CV folds' },
    tuneIterations: { type: 'integer', description: 'search iterations per algorithm (default 6)' },
    positiveClass: { type: 'string', description: 'binary: the class treated as positive' },
    sensitive: { type: 'string|array', description: 'columns to audit for group fairness (never inferred)' },
    classWeight: { type: 'string', enum: ['balanced'], description: 'reweight classes for imbalanced targets' },
    costs: { type: 'object', description: 'binary: { "falsePositive": 1, "falseNegative": 5 } for cost-optimal thresholds' },
    keepLeakageSuspects: { type: 'boolean', description: 'keep features flagged as likely leakage (not recommended)' },
    seed: SEED,
    where: WHERE,
  },
  example: { action: 'train', dataset: 'customers', target: 'churned', groupColumn: 'account_id', sensitive: ['gender'] },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const target = str(ctx, 'target')
    const seed = seedOf(ctx)
    const profiles = understandDataset(frame).profiles
    const result = trainAutoML({
      frame, target, profiles, seed,
      ...(ctx.params.features ? { features: list(ctx.params.features, 'features') } : {}),
      ...(typeof ctx.params.task === 'string' ? { task: ctx.params.task as 'auto' } : {}),
      ...(Array.isArray(ctx.params.algorithms) ? { algorithms: ctx.params.algorithms as Algorithm[] } : {}),
      ...(typeof ctx.params.metric === 'string' ? { metric: ctx.params.metric } : {}),
      ...(typeof ctx.params.cvStrategy === 'string' ? { cvStrategy: ctx.params.cvStrategy as 'kfold' } : {}),
      ...(typeof ctx.params.folds === 'number' ? { folds: ctx.params.folds } : {}),
      ...(typeof ctx.params.groupColumn === 'string' ? { groupColumn: ctx.params.groupColumn } : {}),
      ...(typeof ctx.params.timeColumn === 'string' ? { timeColumn: ctx.params.timeColumn } : {}),
      ...(typeof ctx.params.gap === 'number' ? { gap: ctx.params.gap } : {}),
      ...(typeof ctx.params.testFraction === 'number' ? { testFraction: ctx.params.testFraction } : {}),
      ...(ctx.params.params && typeof ctx.params.params === 'object' ? { params: ctx.params.params as Record<string, Record<string, unknown>> } : {}),
      ...(ctx.params.tune === true ? { tune: true } : {}),
      ...(typeof ctx.params.tuneIterations === 'number' ? { tuneIterations: ctx.params.tuneIterations } : {}),
      ...(typeof ctx.params.positiveClass === 'string' ? { positiveClass: ctx.params.positiveClass } : {}),
      ...(ctx.params.sensitive ? { sensitive: list(ctx.params.sensitive, 'sensitive') } : {}),
      ...(ctx.params.classWeight === 'balanced' ? { classWeight: 'balanced' as const } : {}),
      ...(ctx.params.costs && typeof ctx.params.costs === 'object' ? { costs: ctx.params.costs as { falsePositive: number; falseNegative: number } } : {}),
      ...(ctx.params.keepLeakageSuspects === true ? { keepLeakageSuspects: true } : {}),
    })
    for (const check of result.checks) ctx.record.check(check.name, check.status, check.detail)
    for (const warning of result.warnings) ctx.record.warn(warning)
    const name = assertDatasetName(typeof ctx.params.name === 'string' ? ctx.params.name : `${target}_model`.replace(/[^A-Za-z0-9_-]/g, '_'), 'name')
    const model = ctx.workspace.registerModel({ name, task: result.task, algorithm: result.selected.algorithm, target, features: result.features, dataset: refOf(entry), datasetFingerprint: entry.fingerprint, params: result.selected.params, metrics: result.artifact.metrics, seed, runId: ctx.record.id }, result.artifact)
    ctx.record.outputModel(`${model.name}@${model.version}`)
    ctx.record.metric(result.primaryMetric, (result.test.selected as Record<string, number>)[result.primaryMetric])
    const charts = [saveChart(ctx, barChart({ title: `What drives ${target}`, subtitle: `permutation importance on the holdout: drop in ${result.primaryMetric} when a feature is shuffled`, categories: result.permutationImportance.slice(0, 15).map((p) => p.feature), series: [{ name: 'importance', values: result.permutationImportance.slice(0, 15).map((p) => p.importance) }], horizontal: true }))]
    charts.push(saveChart(ctx, barChart({ title: `Model comparison (${result.primaryMetric}, ${result.validation.folds}-fold CV)`, subtitle: LOWER_IS_BETTER.has(result.primaryMetric) ? 'lower is better' : 'higher is better', categories: result.leaderboard.map((row) => row.algorithm), series: [{ name: result.primaryMetric, values: result.leaderboard.map((row) => (Number.isFinite(row.cvMean) ? row.cvMean : null)) }], horizontal: true, format: 'plain' })))
    if (result.calibration) charts.push(saveChart(ctx, lineChart({ title: 'Calibration on the holdout', subtitle: `expected calibration error ${result.calibration.ece.toFixed(3)}; the diagonal is perfect calibration`, x: result.calibration.bins.map((b) => b.meanPredicted.toFixed(2)), series: [{ name: 'observed rate', values: result.calibration.bins.map((b) => b.observedRate) }, { name: 'predicted', values: result.calibration.bins.map((b) => b.meanPredicted) }], format: 'percent', zeroBaseline: true })))
    return {
      model: `${model.name}@${model.version}`,
      task: result.task,
      dataset: refOf(entry),
      classLabels: result.classLabels,
      features: result.features,
      excluded: result.excluded,
      leakage: result.leakage,
      validation: result.validation,
      primaryMetric: result.primaryMetric,
      leaderboard: result.leaderboard.map((row) => ({ algorithm: row.algorithm, cvMean: row.cvMean, cvSd: row.cvSd, beatsBaseline: row.beatsBaseline, secondary: row.secondary, fitSeconds: row.fitSeconds, predictMsPer1k: row.predictMsPer1k, sizeKb: row.sizeKb, interpretability: row.interpretability, params: row.params })),
      selected: result.selected,
      holdout: { selected: result.test.selected, baseline: result.test.baseline, train: result.test.train },
      permutationImportance: result.permutationImportance.slice(0, 20),
      nativeImportance: result.nativeImportance.slice(0, 20),
      ...(result.calibration ? { calibration: { ece: result.calibration.ece, maxError: result.calibration.maxCalibrationError } } : {}),
      ...(result.thresholds ? { thresholds: { bestF1: result.thresholds.bestF1, bestYouden: result.thresholds.bestYouden, ...(result.thresholds.minimumCost ? { minimumCost: result.thresholds.minimumCost } : {}) } } : {}),
      ...(result.lift ? { lift: result.lift.slice(0, 3) } : {}),
      ...(result.fairness ? { fairness: result.fairness } : {}),
      notes: result.notes,
      charts,
    }
  },
})

function loadModel(ctx: ActionContext): { ref: string; artifact: ModelArtifact; entry: ReturnType<ActionContext['workspace']['resolveModel']> } {
  const entry = ctx.workspace.resolveModel(str(ctx, 'model'))
  const artifact = ctx.workspace.loadModelArtifact(entry) as ModelArtifact
  if (artifact.format !== 'elia-model/1') throw new Error(`model file ${entry.path} is not an elia model artifact`)
  return { ref: `${entry.name}@${entry.version}`, artifact, entry }
}

registerCapability({
  tool: 'ds_ml',
  action: 'predict',
  summary: 'score a dataset with a registered model; writes a dataset with predictions (and class probabilities) and checks input drift against the training data',
  effect: 'local-write',
  params: { model: { type: 'string', required: true, description: 'model name or name@version' }, dataset: DATASET, output: { type: 'string', description: 'name of the scored dataset' }, threshold: { type: 'number', description: 'binary decision threshold (default the model threshold, 0.5)' }, where: WHERE },
  run(ctx) {
    const { ref, artifact } = loadModel(ctx)
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const { prediction, missingFeatures } = predictWithArtifact(artifact, frame)
    ctx.record.expect('features present', missingFeatures.length === 0, missingFeatures.length ? `missing features ${missingFeatures.join(', ')} were imputed with training medians/modes — predictions are unreliable` : 'every training feature is present')
    const drift = driftAgainstProfile(artifact.trainingProfile, frame).sort((a, b) => b.psi - a.psi)
    const significant = drift.filter((d) => d.level === 'significant')
    ctx.record.check('input drift', significant.length ? 'warn' : 'pass', significant.length ? `PSI ≥ 0.25 for ${significant.map((d) => d.feature).join(', ')}: the data no longer looks like the training data` : 'all features within PSI 0.25 of training')
    const threshold = typeof ctx.params.threshold === 'number' ? ctx.params.threshold : artifact.threshold ?? 0.5
    const column = `predicted_${artifact.target}`
    const rows: Row[] = frame.rows.map((row, i) => {
      const out: Row = { ...row }
      if (artifact.task === 'regression') out[column] = prediction.values[i]!
      else if (artifact.task === 'binary') { const p = prediction.probabilities![i]![1]!; out[`probability_${artifact.positiveClass}`] = p; out[column] = p >= threshold ? artifact.classLabels[1]! : artifact.classLabels[0]! }
      else { artifact.classLabels.forEach((label, c) => { out[`probability_${label}`] = prediction.probabilities![i]![c]! }); out[column] = artifact.classLabels[prediction.values[i]!]! }
      return out
    })
    const scored = frameFromRows(rows)
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_scored`), scored, 'predict', [refOf(entry)], [{ model: ref, threshold }])
    const predictionShares = artifact.task === 'regression' ? binShares(prediction.values, artifact.predictionProfile.edges) : binShares(prediction.probabilities!.map((p) => (artifact.task === 'binary' ? p[1]! : Math.max(...p))), artifact.predictionProfile.edges)
    const predictionPsi = populationStabilityIndex(artifact.predictionProfile.shares, predictionShares)
    ctx.record.check('prediction drift', predictionPsi >= 0.25 ? 'warn' : 'pass', `PSI ${predictionPsi.toFixed(3)} vs training predictions`)
    let performance: unknown
    if (frame.columns.includes(artifact.target)) {
      const labelled = frame.rows.map((row, i) => ({ row, i })).filter(({ row }) => !isMissing(row[artifact.target]))
      if (labelled.length >= 20) {
        const metrics = artifact.task === 'regression' ? regressionMetrics(labelled.map(({ row }) => toNumber(row[artifact.target])!), labelled.map(({ i }) => prediction.values[i]!)) : classificationMetrics(labelled.map(({ row }) => artifact.classLabels.indexOf(String(row[artifact.target]))), labelled.map(({ i }) => prediction.values[i]!), labelled.map(({ i }) => prediction.probabilities![i]!), artifact.classLabels)
        const metricName = String((artifact.metrics as { primaryMetric: string }).primaryMetric)
        const current = metricValue(metrics, metricName)
        const reference = metricValue((artifact.metrics as { holdout: Record<string, unknown> }).holdout, metricName)
        const degradation = LOWER_IS_BETTER.has(metricName) ? (current - reference) / Math.abs(reference) : (reference - current) / Math.abs(reference)
        ctx.record.check('performance vs holdout', degradation > 0.1 ? 'warn' : 'pass', `${metricName} ${current.toPrecision(4)} now vs ${reference.toPrecision(4)} at training (${(degradation * 100).toFixed(1)}% worse)`)
        performance = { metric: metricName, current, atTraining: reference, relativeDegradation: degradation, labelledRows: labelled.length }
      }
    }
    return { model: ref, output: refOf(saved), predictionColumn: column, threshold: artifact.task === 'binary' ? threshold : undefined, inputDrift: drift.slice(0, 15), predictionDriftPsi: predictionPsi, ...(performance ? { performance } : {}), ...preview(scored, 5) }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'explain',
  summary: 'explain a model: partial dependence + ICE curves for features, and local contributions for individual rows (exact for linear models, path contributions for trees)',
  effect: 'compute',
  params: { model: { type: 'string', required: true, description: 'model name or name@version' }, dataset: DATASET, features: { type: 'string|array', description: 'features for partial dependence (default: the 3 most important)' }, rows: { type: 'array', description: 'row indices to explain individually' }, where: { type: 'string', description: 'explain the first rows matching this filter' }, seed: SEED },
  run(ctx) {
    const { ref, artifact } = loadModel(ctx)
    const { frame } = ctx.dataset(str(ctx, 'dataset'), { where: '' })
    const seed = seedOf(ctx)
    const requested = list(ctx.params.features, 'features')
    const features = requested.length ? requested : artifact.features.slice(0, 3)
    const pd = features.map((feature) => partialDependence(artifact, frame, feature, createRng(seed)))
    const charts = pd.map((curve) => saveChart(ctx, lineChart({ title: `Partial dependence: ${curve.feature}`, subtitle: curve.output, x: curve.grid.map(String), series: [{ name: 'average', values: curve.average }, ...curve.ice.slice(0, 3).map((line) => ({ name: `row ${line.row}`, values: line.values }))], format: artifact.task === 'regression' ? 'compact' : 'percent' })))
    let indices = Array.isArray(ctx.params.rows) ? (ctx.params.rows as number[]).filter((i) => Number.isInteger(i) && i >= 0 && i < frame.rows.length) : []
    if (!indices.length && typeof ctx.params.where === 'string') {
      const filtered = ctx.dataset(str(ctx, 'dataset'), { where: ctx.params.where, record: false })
      const set = new Set(filtered.frame.rows)
      indices = frame.rows.map((row, i) => (set.has(row) ? i : -1)).filter((i) => i >= 0).slice(0, 5)
    }
    const local = indices.slice(0, 10).map((i) => ({ row: i, ...explainPrediction(artifact, frame.rows[i]!) }))
    ctx.record.check('explanations computed', 'pass', `${pd.length} partial-dependence curves, ${local.length} local explanations`)
    return { model: ref, partialDependence: pd.map(({ ice, ...rest }) => ({ ...rest, iceLines: ice.length })), local, charts, caution: 'Explanations describe what the model does, not how the world works; correlated features share credit unpredictably.' }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'models',
  summary: 'list the model registry: versions, status (candidate/registered/archived), algorithm, metrics, training data fingerprint',
  effect: 'compute',
  params: {},
  run(ctx) {
    const models = ctx.workspace.read().models
    ctx.record.check('registry read', 'pass', `${models.length} model versions`)
    return { models: models.map((m) => ({ model: `${m.name}@${m.version}`, status: m.status, task: m.task, algorithm: m.algorithm, target: m.target, trainedOn: m.dataset, createdAt: m.createdAt, runId: m.runId, holdout: (m.metrics as { holdout?: unknown }).holdout, primaryMetric: (m.metrics as { primaryMetric?: string }).primaryMetric })) }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'promote',
  summary: 'set a model version\'s registry status: "registered" (the version to use; the previous one is demoted — this is also how to roll back), "candidate", or "archived"',
  effect: 'local-write',
  params: { model: { type: 'string', required: true, description: 'name@version' }, status: { type: 'string', required: true, enum: ['registered', 'candidate', 'archived'], description: 'new status' } },
  run(ctx) {
    const before = ctx.workspace.read().models.filter((m) => m.status === 'registered').map((m) => `${m.name}@${m.version}`)
    const model = ctx.workspace.setModelStatus(str(ctx, 'model'), ctx.params.status as 'registered')
    ctx.record.check('status changed', 'pass', `${model.name}@${model.version} → ${model.status}`)
    return { model: `${model.name}@${model.version}`, status: model.status, previouslyRegistered: before, note: 'This changes the local registry only; nothing is deployed anywhere.' }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'model_card',
  summary: 'write a model card and deployment bundle (model artifact, monitoring profile, card) under artifacts/models/ — a local package; deploying to infrastructure is a separate, approved step',
  effect: 'artifact-write',
  params: { model: { type: 'string', required: true, description: 'name@version' }, intendedUse: { type: 'string', description: 'what decisions the model supports' }, outOfScope: { type: 'string', description: 'uses the model is not validated for' } },
  run(ctx) {
    const { ref, artifact, entry } = loadModel(ctx)
    const metrics = artifact.metrics as { primaryMetric: string; cv: { mean: number; sd: number }; holdout: Record<string, unknown>; baselineHoldout: Record<string, unknown> }
    const card = [
      `# Model card — ${ref}`, '',
      `- Task: ${artifact.task}; target \`${artifact.target}\`${artifact.positiveClass ? ` (positive class "${artifact.positiveClass}")` : ''}`,
      `- Algorithm: ${artifact.model.algorithm} ${JSON.stringify(artifact.model.params)}`,
      `- Trained: ${artifact.trainedAt} on ${entry.dataset} (${artifact.trainingRows} rows, fingerprint ${entry.datasetFingerprint.slice(0, 16)}), seed ${artifact.seed}`,
      `- Features (${artifact.features.length}): ${artifact.features.join(', ')}`, '',
      '## Performance', '',
      `- Cross-validated ${metrics.primaryMetric}: ${metrics.cv.mean.toPrecision(4)} ± ${metrics.cv.sd.toPrecision(2)}`,
      `- Holdout ${metrics.primaryMetric}: ${String(metrics.holdout[metrics.primaryMetric])} (baseline ${String(metrics.baselineHoldout[metrics.primaryMetric])})`, '',
      '## Intended use', '', typeof ctx.params.intendedUse === 'string' ? ctx.params.intendedUse : '_Not stated — fill in before use._', '',
      '## Out of scope', '', typeof ctx.params.outOfScope === 'string' ? ctx.params.outOfScope : '_Populations, time periods, or decisions not represented in the training data._', '',
      '## Monitoring', '', 'Track input drift (PSI per feature against `monitoring-profile.json`), prediction drift, and the primary metric on labelled outcomes; retrain or roll back (ds_ml promote) when PSI ≥ 0.25 or the metric degrades by more than 10%.', '',
      '## Limitations', '', '- Predictions are probabilistic estimates, not certainties.', '- Performance was measured on historical data and may not hold under changed conditions.',
    ].join('\n')
    const base = `models/${entry.name}-v${entry.version}`
    const files = [ctx.artifact(`${base}/MODEL_CARD.md`, card, 'model-card'), ctx.artifact(`${base}/model.json`, JSON.stringify(artifact), 'model'), ctx.artifact(`${base}/monitoring-profile.json`, JSON.stringify({ trainingProfile: artifact.trainingProfile, predictionProfile: artifact.predictionProfile, metrics: artifact.metrics }, null, 1), 'monitoring-profile')]
    ctx.record.check('bundle written', 'pass', files.map((f) => f.path).join(', '))
    return { model: ref, files, note: 'Scoring uses `ds_ml predict` (or `elia ds` in a pipeline). Deployment to a serving platform is not performed by this action.' }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'cluster',
  summary: 'segment rows: k-means (k chosen by silhouette when not given), DBSCAN, Ward hierarchical, Gaussian mixture (BIC), or spectral; writes a dataset with a cluster column and profiles each cluster',
  effect: 'local-write',
  params: { dataset: DATASET, features: { type: 'string|array', description: 'features (default: numeric measures); standardized before clustering' }, method: { type: 'string', enum: ['kmeans', 'dbscan', 'hierarchical', 'gmm', 'spectral'], description: 'default kmeans' }, k: { type: 'integer', description: 'number of clusters (default: best silhouette over kRange)' }, kRange: { type: 'array', description: 'candidates for k (default [2..8])' }, eps: { type: 'number', description: 'DBSCAN radius in standardized units (default from the k-distance knee)' }, minPoints: { type: 'integer', description: 'DBSCAN minimum neighbours (default 5)' }, output: { type: 'string', description: 'output dataset name' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const features = defaultFeatures(frame, list(ctx.params.features, 'features'))
    if (features.length === 0) throw new Error('no numeric features to cluster on; pass features')
    assertColumns(frame, features, 'features')
    const seed = seedOf(ctx)
    const rng = createRng(seed)
    const { x } = numericMatrix(frame, features, true)
    const method = str(ctx, 'method', 'kmeans')
    let labels: number[]
    const selection: Array<Record<string, number>> = []
    if (method === 'kmeans' || method === 'gmm' || method === 'spectral' || method === 'hierarchical') {
      let k = typeof ctx.params.k === 'number' ? ctx.params.k : 0
      if (!k) {
        const range = Array.isArray(ctx.params.kRange) ? (ctx.params.kRange as number[]) : [2, 3, 4, 5, 6, 7, 8]
        for (const candidate of range.filter((c) => c >= 2 && c < x.length)) {
          const km = kMeans(x, candidate, rng.fork(candidate))
          selection.push({ k: candidate, inertia: km.inertia, silhouette: silhouette(x, km.labels, rng.fork(100 + candidate)), ...(method === 'gmm' ? { bic: gaussianMixture(x, candidate, rng.fork(200 + candidate)).bic } : {}) })
        }
        const best = method === 'gmm' ? selection.reduce((a, b) => (b.bic! < a.bic! ? b : a)) : selection.reduce((a, b) => (b.silhouette! > a.silhouette! ? b : a))
        k = best.k!
      }
      labels = method === 'kmeans' ? kMeans(x, k, rng).labels : method === 'gmm' ? gaussianMixture(x, k, rng).labels : method === 'spectral' ? spectralClustering(x, k, rng).labels : wardHierarchical(x, k).labels
    } else {
      const minPoints = typeof ctx.params.minPoints === 'number' ? ctx.params.minPoints : 5
      const eps = typeof ctx.params.eps === 'number' ? ctx.params.eps : suggestEps(x, minPoints, rng)
      labels = dbscan(x, eps, minPoints).labels
      selection.push({ eps, minPoints })
    }
    const sil = silhouette(x, labels, rng)
    ctx.record.check('cluster separation', sil >= 0.25 ? 'pass' : 'warn', `silhouette ${Number.isFinite(sil) ? sil.toFixed(3) : 'n/a'} (${sil >= 0.5 ? 'strong' : sil >= 0.25 ? 'reasonable' : 'weak — segments may be arbitrary cuts of a continuum'})`)
    const clusterIds = [...new Set(labels)].sort((a, b) => a - b)
    const profiles = clusterIds.map((id) => {
      const rows = frame.rows.filter((_, i) => labels[i] === id)
      return { cluster: id === -1 ? 'noise' : id, size: rows.length, share: rows.length / frame.rows.length, means: Object.fromEntries(features.filter((f) => frame.types[f] === 'integer' || frame.types[f] === 'number').map((f) => [f, mean(rows.map((r) => toNumber(r[f])).filter((v): v is number => v !== undefined))])) }
    })
    const smallest = Math.min(...profiles.map((p) => p.share))
    if (smallest < 0.02) ctx.record.check('cluster sizes', 'warn', 'a cluster holds under 2% of rows; it may be outliers rather than a segment')
    const out = frameFromRows(frame.rows.map((row, i) => ({ ...row, cluster: labels[i] === -1 ? 'noise' : `c${labels[i]}` })))
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_clusters`), out, 'cluster', [refOf(entry)], [{ method, features, seed }])
    const chart = saveChart(ctx, barChart({ title: `Cluster sizes (${method})`, categories: profiles.map((p) => String(p.cluster)), series: [{ name: 'rows', values: profiles.map((p) => p.size) }] }))
    return { output: refOf(saved), method, features, silhouette: sil, selection, profiles, chart, note: 'Clusters are descriptions of this data, not natural kinds; name them from their profiles and validate them against outcomes before acting on them.' }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'reduce',
  summary: 'dimensionality reduction: PCA (explained variance, loadings), t-SNE (≤ 2,000 rows), or NMF (non-negative data); writes component columns',
  effect: 'local-write',
  params: { dataset: DATASET, features: { type: 'string|array', description: 'features (default numeric measures)' }, method: { type: 'string', enum: ['pca', 'tsne', 'nmf'], description: 'default pca' }, components: { type: 'integer', description: 'default 2' }, output: { type: 'string', description: 'output dataset name' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const features = defaultFeatures(frame, list(ctx.params.features, 'features'))
    assertColumns(frame, features, 'features')
    const method = str(ctx, 'method', 'pca')
    const k = typeof ctx.params.components === 'number' ? ctx.params.components : 2
    const seed = seedOf(ctx)
    const { x, names } = numericMatrix(frame, features, method !== 'nmf')
    let scores: number[][]
    let extra: Record<string, unknown> = {}
    if (method === 'pca') {
      const r = pca(x, k)
      scores = r.scores
      extra = { explainedVarianceRatio: r.explainedVarianceRatio, cumulative: r.explainedVarianceRatio.reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + v], []), loadings: r.components.map((c, i) => ({ component: `PC${i + 1}`, top: c.map((w, j) => ({ feature: names[j]!, weight: w })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6) })) }
      ctx.record.check('variance captured', 'pass', `${k} components explain ${((extra.cumulative as number[]).at(-1)! * 100).toFixed(1)}%`)
    } else if (method === 'tsne') {
      scores = tsne(x, createRng(seed), { dimensions: k })
      ctx.record.check('embedding computed', 'pass', 't-SNE preserves local neighbourhoods only; distances between clusters and cluster sizes are not meaningful')
    } else {
      const r = nmf(x, k, createRng(seed))
      scores = r.W
      extra = { reconstructionError: r.reconstructionError, components: r.H.map((row, i) => ({ component: i, top: row.map((w, j) => ({ feature: names[j]!, weight: w })).sort((a, b) => b.weight - a.weight).slice(0, 6) })) }
      ctx.record.check('factorisation computed', 'pass', `reconstruction error ${r.reconstructionError.toPrecision(4)}`)
    }
    const prefix = method === 'pca' ? 'PC' : method === 'tsne' ? 'tsne_' : 'nmf_'
    const out = frameFromRows(frame.rows.map((row, i) => ({ ...row, ...Object.fromEntries(scores[i]!.map((v, j) => [`${prefix}${j + 1}`, v])) })))
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_${method}`), out, 'reduce', [refOf(entry)], [{ method, features, components: k, seed }])
    const chart = k >= 2 ? saveChart(ctx, scatterChart({ title: `${method.toUpperCase()} projection`, points: scores.slice(0, 5000).map((s) => ({ x: s[0]!, y: s[1]! })), xLabel: `${prefix}1`, yLabel: `${prefix}2` })) : undefined
    return { output: refOf(saved), method, features, ...extra, ...(chart ? { chart } : {}) }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'anomalies',
  summary: 'flag anomalous rows: isolation forest, local outlier factor, Mahalanobis distance, or robust z-score per column; writes score and flag columns',
  effect: 'local-write',
  params: { dataset: DATASET, features: { type: 'string|array', description: 'features (default numeric measures)' }, method: { type: 'string', enum: ['isolation_forest', 'lof', 'mahalanobis', 'robust_z'], description: 'default isolation_forest' }, contamination: { type: 'number', description: 'share of rows to flag (default: method threshold)' }, threshold: { type: 'number', description: 'robust_z threshold (default 3.5)' }, output: { type: 'string', description: 'output dataset name' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const features = defaultFeatures(frame, list(ctx.params.features, 'features'))
    assertColumns(frame, features, 'features')
    const method = str(ctx, 'method', 'isolation_forest')
    const seed = seedOf(ctx)
    const { x } = numericMatrix(frame, features, true)
    let scores: number[]
    let defaultCut: number
    if (method === 'isolation_forest') { scores = isolationForest(x, createRng(seed)); defaultCut = 0.6 }
    else if (method === 'lof') { scores = localOutlierFactor(x); defaultCut = 1.5 }
    else if (method === 'mahalanobis') { const m = mahalanobis(x); scores = m.pValue.map((p) => 1 - p); defaultCut = 0.999 }
    else { const threshold = typeof ctx.params.threshold === 'number' ? ctx.params.threshold : 3.5; const columns = x[0]!.map((_, j) => robustZ(x.map((row) => row[j]!))); scores = x.map((_, i) => Math.max(...columns.map((col) => Math.abs(col[i]!)))); defaultCut = threshold }
    const cut = typeof ctx.params.contamination === 'number' ? [...scores].sort((a, b) => b - a)[Math.max(0, Math.floor(ctx.params.contamination * scores.length) - 1)]! : defaultCut
    const flags = scores.map((s) => s >= cut)
    const flagged = flags.filter(Boolean).length
    ctx.record.check('anomaly rate', flagged / frame.rows.length > 0.1 ? 'warn' : 'pass', `${flagged} of ${frame.rows.length} rows flagged (${((100 * flagged) / frame.rows.length).toFixed(2)}%)${flagged / frame.rows.length > 0.1 ? ' — too many to be anomalies; the threshold or features need review' : ''}`)
    const out = frameFromRows(frame.rows.map((row, i) => ({ ...row, anomaly_score: scores[i]!, is_anomaly: flags[i]! })))
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_anomalies`), out, 'anomalies', [refOf(entry)], [{ method, features, cut, seed }])
    const top = frame.rows.map((row, i) => ({ row: i, score: scores[i]!, ...Object.fromEntries(features.slice(0, 6).map((f) => [f, row[f] ?? null])) })).sort((a, b) => b.score - a.score).slice(0, 15)
    return { output: refOf(saved), method, threshold: cut, flagged, top, note: 'An anomaly is unusual relative to this data, not necessarily wrong or fraudulent; review flagged rows before acting.' }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'drift',
  summary: 'monitor drift between a reference (a model\'s training data, or a dataset) and current data: PSI and KS per feature, schema changes, missingness changes',
  effect: 'compute',
  params: { dataset: DATASET, model: { type: 'string', description: 'use this model\'s training profile as the reference' }, reference: { type: 'string', description: 'reference dataset (instead of a model)' }, features: { type: 'string|array', description: 'features to compare (default all shared columns)' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    let rows: Array<Record<string, unknown>>
    let referenceName: string
    if (typeof ctx.params.model === 'string') {
      const { ref, artifact } = loadModel(ctx)
      referenceName = `training data of ${ref}`
      rows = driftAgainstProfile(artifact.trainingProfile, frame).map((d) => ({ ...d }))
    } else {
      const reference = ctx.dataset(str(ctx, 'reference'), { where: '' })
      referenceName = refOf(reference.entry)
      const requested = list(ctx.params.features, 'features')
      const shared = (requested.length ? requested : frame.columns).filter((c) => reference.frame.columns.includes(c))
      const profile = trainingProfile(reference.frame, reference.frame.rows.map((_, i) => i), shared)
      rows = driftAgainstProfile(profile, frame).map((d) => {
        const isNumeric = frame.types[d.feature] === 'integer' || frame.types[d.feature] === 'number'
        if (!isNumeric) return { ...d }
        const a = reference.frame.rows.map((r) => toNumber(r[d.feature])).filter((v): v is number => v !== undefined)
        const b = frame.rows.map((r) => toNumber(r[d.feature])).filter((v): v is number => v !== undefined)
        const ks = a.length && b.length ? kolmogorovSmirnov2(a, b) : undefined
        return { ...d, ...(ks ? { ksStatistic: ks.statistic, ksPValue: ks.pValue } : {}) }
      })
    }
    rows.sort((a, b) => (b.psi as number) - (a.psi as number))
    const significant = rows.filter((r) => r.level === 'significant')
    ctx.record.check('drift assessed', significant.length ? 'warn' : 'pass', significant.length ? `significant drift (PSI ≥ 0.25) in ${significant.map((r) => r.feature).join(', ')}` : 'no feature above PSI 0.25')
    const chart = saveChart(ctx, barChart({ title: 'Population stability index by feature', subtitle: '< 0.1 stable · 0.1–0.25 moderate · ≥ 0.25 significant', categories: rows.slice(0, 20).map((r) => String(r.feature)), series: [{ name: 'PSI', values: rows.slice(0, 20).map((r) => r.psi as number) }], horizontal: true, format: 'plain' }))
    return { dataset: refOf(entry), reference: referenceName, features: rows, chart }
  },
})

registerCapability({
  tool: 'ds_ml',
  action: 'recommend',
  summary: 'recommender systems on user-item interactions: evaluate popularity, item-kNN, implicit ALS, and a hybrid with precision/recall/MAP/NDCG/hit rate@k, coverage, diversity, cold start; optionally produce top-k recommendations',
  effect: 'local-write',
  params: { dataset: DATASET, user: { type: 'string', required: true, description: 'user column' }, item: { type: 'string', required: true, description: 'item column' }, weight: { type: 'string', description: 'interaction strength (default 1 per row)' }, time: { type: 'string', description: 'timestamp for time-aware holdout' }, k: { type: 'integer', description: 'list length (default 10)' }, methods: { type: 'array', description: 'popularity, item_knn, als, hybrid' }, itemFeature: { type: 'string', description: 'item category column for the diversity metric' }, recommendFor: { type: 'array', description: 'user ids to produce recommendations for with the best method' }, output: { type: 'string', description: 'dataset for produced recommendations' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const user = str(ctx, 'user'); const item = str(ctx, 'item')
    assertColumns(frame, [user, item], 'recommend')
    const weight = typeof ctx.params.weight === 'string' ? ctx.params.weight : undefined
    const time = typeof ctx.params.time === 'string' ? ctx.params.time : undefined
    const seed = seedOf(ctx)
    const interactions = frame.rows.filter((r) => !isMissing(r[user]) && !isMissing(r[item])).map((r) => ({ user: String(r[user]), item: String(r[item]), weight: weight ? toNumber(r[weight]) ?? 1 : 1, ...(time ? { time: toDateMs(r[time]) ?? toNumber(r[time]) ?? 0 } : {}) }))
    const features = typeof ctx.params.itemFeature === 'string' ? new Map(frame.rows.map((r) => [String(r[item]), String(r[ctx.params.itemFeature as string])])) : undefined
    const k = typeof ctx.params.k === 'number' ? ctx.params.k : 10
    const evaluation = evaluateRecommenders(interactions, { k, seed, ...(Array.isArray(ctx.params.methods) ? { methods: ctx.params.methods as RecommenderMethod[] } : {}), ...(features ? { itemFeatures: features } : {}) }) as { results: Array<Record<string, unknown>> }
    const best = evaluation.results.find((r) => !r.failed)
    ctx.record.check('offline evaluation', best ? 'pass' : 'fail', best ? `best ${String(best.method)} ndcg@${k} ${(best[`ndcg@${k}`] as number).toFixed(4)}` : 'no method could be evaluated')
    const popularity = evaluation.results.find((r) => r.method === 'popularity')
    if (best && popularity && best.method !== 'popularity' && (best[`ndcg@${k}`] as number) <= (popularity[`ndcg@${k}`] as number)) ctx.record.check('beats popularity', 'warn', 'no personalised method beats the popularity baseline')
    let output: string | undefined
    if (Array.isArray(ctx.params.recommendFor) && best) {
      const model = buildRecommender(best.method as RecommenderMethod, interactions, seed)
      const seen = new Map<string, Set<string>>()
      for (const i of interactions) (seen.get(i.user) ?? seen.set(i.user, new Set()).get(i.user)!).add(i.item)
      const rows = (ctx.params.recommendFor as unknown[]).map(String).flatMap((u) => model.recommend(u, k, seen.get(u) ?? new Set()).map((rec, rank) => ({ user: u, rank: rank + 1, item: rec, method: String(best.method) })))
      output = refOf(ctx.saveDataset(outputName(ctx, `${entry.name}_recommendations`), frameFromRows(rows), 'recommend', [refOf(entry)], [{ method: best.method, k }]))
    }
    return { dataset: refOf(entry), ...evaluation, ...(output ? { output } : {}) }
  },
})
