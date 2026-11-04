/**
 * What a stored report has to say about itself.
 *
 * `report_from_store` prints only what the analyst recorded. A live brief recorded one question and one forecast,
 * ran risk_assessment and consequence_chain (which return numbers and save nothing), and produced a report whose
 * judgments, scenarios, decisions, outcomes and relationship map were all "none" — next to an executive summary
 * quoting freight and congestion figures that appear in no evidence. Nothing in the report said so, and the
 * printable edition even dropped the column that flagged the forecast's ungrounded figures.
 *
 * This decides, from counts alone, which empties are the analyst's to fix and which are simply not possible yet,
 * so the report can print them, the tool result can hand them back to the model, and a hollow report cannot be
 * stamped final.
 */

export interface ReportFacts {
  claims: number
  forecasts: number
  scenarios: number
  decisions: number
  outcomes: number
  resolvedQuestions: number
  ontologyObjects: number
  citedSources: number
  /** Evidence rows in the store that nothing in this report cites, and which the ledger therefore leaves out. */
  uncitedSources: number
  summaryUnverifiedFigures: string[]
  claimsWithUnverifiedFigures: number
  forecastsWithUnverifiedFigures: number
  /** Claims whose cited evidence is all unverified (search snippets, unchecked text) or missing. */
  claimsWithoutVerifiedSources: number
}

export interface ReportIntegrity {
  /** What the analyst has to fix; each names the action that fixes it. */
  problems: string[]
  /** Empties that are not the analyst's fault, and context worth stating. */
  notes: string[]
  /** The problems that make a report unfit to be marked final: a report with no recorded judgment has nothing a reviewer could sign. */
  blocksFinal: string[]
}

const listFigures = (figures: string[]) => (figures.length > 6 ? `${figures.slice(0, 6).join(', ')} and ${figures.length - 6} more` : figures.join(', '))

export function assessReportIntegrity(facts: ReportFacts): ReportIntegrity {
  const problems: string[] = []
  const blocksFinal: string[] = []
  const blocking = (message: string) => { problems.push(message); blocksFinal.push(message) }

  if (facts.claims === 0) blocking('Key judgments: none recorded. Record three to six with register_claim, each citing evidence registered with register_evidence.')
  if (facts.forecasts === 0) problems.push('Forecast register: no forecast. Open a question with create_question and forecast it with submit_forecast.')
  if (facts.scenarios === 0) problems.push('Scenarios and signposts: none recorded. risk_assessment and consequence_chain save nothing; record a scenario with create_scenario (it needs questionIds and evidenceIds) or it will not be in the report.')
  if (facts.citedSources === 0) problems.push('This report cites no evidence at all, so nothing in it is sourced.')
  if (facts.summaryUnverifiedFigures.length > 0) {
    problems.push(`The executive summary states ${facts.summaryUnverifiedFigures.length} figure(s) that appear in none of the evidence this report cites: ${listFigures(facts.summaryUnverifiedFigures)}. Fetch the source with web_fetch and register_evidence, cite it in a claim or forecast, or label the figure a model estimate.`)
  }
  if (facts.claimsWithUnverifiedFigures > 0) problems.push(`${facts.claimsWithUnverifiedFigures} key judgment(s) state figures that are not in the evidence they cite.`)
  if (facts.forecastsWithUnverifiedFigures > 0) problems.push(`${facts.forecastsWithUnverifiedFigures} forecast rationale(s) state figures that are not in the evidence they cite.`)
  if (facts.claims > 0 && facts.claimsWithoutVerifiedSources > 0) problems.push(`${facts.claimsWithoutVerifiedSources} key judgment(s) rest only on unverified sources (search snippets or text that was not checked against a fetched page).`)

  const notes: string[] = []
  if (facts.decisions === 0) notes.push('Decisions: none recorded. A decision is the client’s to make; record it with record_decision when it is made.')
  if (facts.outcomes === 0) notes.push('Outcomes: none recorded. An outcome exists only after a decision has been acted on.')
  if (facts.resolvedQuestions === 0) notes.push('Track record: no question has resolved yet, so no calibration can be claimed.')
  if (facts.ontologyObjects === 0) notes.push('Relationship map: no objects. upsert_object and link_objects build it; it is optional for a brief.')
  if (facts.uncitedSources > 0) notes.push(`${facts.uncitedSources} other evidence record(s) in the store are cited by nothing in this report and are left out of the ledger.`)

  return { problems, notes, blocksFinal }
}
