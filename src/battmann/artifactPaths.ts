/**
 * Where Battmann writes its artifacts when a call names no outputPath. Shared by the tool and the governor so
 * the path the governor assesses is the path the tool writes.
 */
export const DEFAULT_ARTIFACT_PATHS: Record<string, string> = {
  report: '.elia/artifacts/battmann-brief.md',
  report_from_store: '.elia/artifacts/battmann-report.md',
  dashboard: '.elia/artifacts/battmann-dashboard.html',
}
