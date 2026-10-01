/**
 * What elia is configured to be: `skills` (and the marketplace behind it),
 * `control`, and `config`.
 *
 * Grouped because each one reads or writes durable settings rather than doing
 * a piece of work — the commands you run between sessions, not during one.
 */
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { dim } from '../ui/theme.ts'
import { table } from '../ui/layout.ts'
import { redactText } from '../ui/redact.ts'
import { userConfigPath, writeUserConfig } from '../userConfig.ts'
import { removeProviderConfiguration, saveProviderConfiguration } from '../providerSettings.ts'
import { flagValue, hasFlag, positionals } from './argv.ts'
import { readSecretInput, readStdinText } from './providerSetup.ts'

/**
 * `elia trust [status|revoke]` — the one place a person says "yes, I have looked
 * at this repository's own skills / MCP servers / standing approvals /
 * schedules". Recorded in the per-user trust record (never in the repo) and
 * bound to the reviewed files' hashes, so it lapses when they change.
 */
export async function runTrust(): Promise<void> {
  const { projectTrustStatus, trustProject, untrustProject } = await import('../autonomy/projectTrust.ts')
  const root = process.cwd()
  const action = positionals()[0] ?? 'trust'
  if (action === 'status' || action === 'list') {
    for (const item of projectTrustStatus(root)) {
      writeNotice(`${item.trusted ? 'trusted ' : item.present ? 'UNTRUSTED' : 'absent   '}  ${item.label}`)
    }
    return
  }
  if (action === 'revoke' || action === 'untrust') {
    untrustProject(root)
    writeNotice(`✓ Trust for ${root} revoked.`)
    return
  }
  if (action !== 'trust') {
    writeError(`Unknown trust action "${action}". Use: elia trust [status|revoke].`)
    process.exitCode = 1
    return
  }
  const trusted = trustProject(root)
  writeNotice(`✓ Trusted in ${root}:`)
  for (const label of trusted) writeNotice(`  ${label}`)
  writeNotice('This is bound to the files as they are now; if any of them changes, run `elia trust` again after reviewing it.')
}

export async function runSkills(): Promise<void> {
  const { listSkillFiles } = await import('../skills/loader.ts')
  const { tryListSkillBundles } = await import('../skills/bundles.ts')
  const { skillCandidates } = await import('../skills/detector.ts')
  const { PROJECT_SKILLS_DIR, USER_SKILLS_DIR, SKILL_SUFFIX, SKILL_BUNDLES_FILE } = await import('../skills/paths.ts')
  const action = positionals()[0] ?? 'list'

  if (action === 'path' || action === 'folder' || action === 'folders') {
    writeNotice(`Project skills: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`User skills:    ${USER_SKILLS_DIR}`)
    writeNotice(`File contract:  create a self-contained ${SKILL_SUFFIX} module exporting a default Tool with name, description, input_schema, and execute(input).`)
    writeNotice(`Bundle file:    ${SKILL_BUNDLES_FILE}`)
    writeNotice('Skills are validated at startup; invalid modules are moved to the quarantine folder instead of stopping Elia.')
    return
  }

  if (action === 'list') {
    const files = listSkillFiles()
    if (files.length === 0) {
      writeNotice('No synthesized skills yet. Run "elia skills candidates" to see what elia keeps doing by hand.')
      return
    }
    for (const line of table([{ header: 'source' }, { header: 'file' }], files.map(({ source, file }) => [source, file]))) {
      writeUsageLine(`  ${line}`)
    }
    return
  }

  if (action === 'bundles') {
    const { bundles, error } = tryListSkillBundles()
    if (error) {
      // A failure, so it goes to stderr and the exit code says so — it used
      // to be a notice with exit 0, which a script read as success.
      writeError(`Could not read skill bundles from ${SKILL_BUNDLES_FILE}: ${error}`)
      process.exitCode = 1
      return
    }
    if (bundles.length === 0) {
      writeNotice(`No skill bundles configured. Create ${SKILL_BUNDLES_FILE} with a JSON object mapping bundle names to { skills: [...] }.`)
      return
    }
    for (const bundle of bundles) {
      const detail = bundle.description ? ` — ${bundle.description}` : ''
      writeUsageLine(`  ${bundle.name}: ${bundle.skills.join(', ')}${detail}`)
    }
    return
  }

  if (action === 'candidates') {
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      writeNotice('Nothing has repeated often enough yet. Keep using elia — it is counting.')
      return
    }
    const rows = table(
      [{ header: 'seen', align: 'right' }, { header: 'kind' }, { header: 'pattern' }],
      candidates.map((c) => [`${c.count}×`, c.kind, c.pattern]),
    )
    const [header, separator, ...dataRows] = rows
    writeUsageLine(`  ${header}`)
    writeUsageLine(`  ${separator}`)
    candidates.forEach((candidate, i) => {
      writeUsageLine(`  ${dataRows[i]}`)
      for (const example of candidate.examples) writeUsageLine(`         ${dim('e.g.')} ${example}`)
    })
    writeNotice('Turn one into a real tool with: elia skills synth [pattern]  (no pattern builds the top row)')
    return
  }

  if (action === 'synth') {
    const { synthesizeSkill } = await import('../skills/synthesize.ts')
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      writeNotice('No candidate has crossed the threshold yet.')
      return
    }
    // `elia skills synth [pattern]`. Without a pattern this took the top
    // candidate and nothing else, so whatever elia happened to repeat most
    // decided what got built — here a bare `powershell`, i.e. a tool whose
    // whole job would be to run arbitrary shell outside the command governor.
    // The counts say what elia does often; they do not say what is worth
    // encoding, and only a person can tell those apart.
    const wanted = positionals()[1]
    const candidate = wanted
      ? candidates.find((c) => c.pattern === wanted) ?? candidates.find((c) => c.pattern.includes(wanted))
      : candidates[0]
    if (!candidate) {
      writeError(`No candidate matches "${wanted}". Run "elia skills candidates" to see them.`)
      process.exitCode = 1
      return
    }

    writeNotice(`Writing a tool for "${candidate.pattern}" (seen ${candidate.count}×)…`)
    const result = await synthesizeSkill(candidate)
    if (result.ok) writeNotice(`✓ ${result.detail}`)
    else {
      writeError(`✗ ${result.detail}`)
      process.exitCode = 1
    }
    return
  }

  if (action === 'trust' || action === 'untrust') {
    const { trustProjectSkills, untrustProjectSkills } = await import('../skills/trust.ts')
    if (action === 'trust') {
      // Recorded in the per-user trust record and bound to a hash of these
      // exact files — not written into the repo, and revoked if they change.
      if (trustProjectSkills(PROJECT_SKILLS_DIR)) {
        writeNotice(`✓ Project skills in ${PROJECT_SKILLS_DIR} are now trusted and will be loaded on the next start (until a skill file changes).`)
      } else {
        writeNotice(`No ${SKILL_SUFFIX} files in ${PROJECT_SKILLS_DIR}, so there is nothing to trust.`)
      }
    } else {
      untrustProjectSkills(PROJECT_SKILLS_DIR)
      writeNotice(`✓ Project skills in ${PROJECT_SKILLS_DIR} are no longer trusted.`)
    }
    return
  }

  if (action === 'status') {
    const { isProjectSkillsTrusted, hasIgnoredRepoTrustFile } = await import('../skills/trust.ts')
    const trusted = isProjectSkillsTrusted(PROJECT_SKILLS_DIR)
    const files = listSkillFiles().filter((f) => f.source === 'project')
    writeNotice(`Project skills directory: ${PROJECT_SKILLS_DIR}`)
    writeNotice(`Trusted: ${trusted ? 'yes' : 'no'}`)
    writeNotice(`Files found: ${files.length}`)
    if (!trusted && files.length > 0) {
      writeNotice('These files were found but are not loaded. Inspect them, then run `elia skills trust` to enable them.')
    }
    if (hasIgnoredRepoTrustFile(PROJECT_SKILLS_DIR)) {
      writeNotice('A skills-trust.json inside the project was ignored: a repository cannot vouch for itself. Trust is kept in your user config.')
    }
    return
  }

  if (action === 'instructions') {
    const { elianAuthoredSlugs, readSkillMeta, rollbackInstructionSkill, INSTRUCTION_SKILLS_ROOT } = await import('../skills/instructionSkills.ts')
    const sub = positionals()[1]

    if (sub === 'history') {
      const slug = positionals()[2]
      const meta = slug ? readSkillMeta(slug) : undefined
      if (!meta) {
        writeError(slug ? `No elia-authored instruction skill named "${slug}".` : 'Usage: elia skills instructions history <slug>')
        process.exitCode = 1
        return
      }
      writeNotice(`${meta.name} (${meta.slug}) — v${meta.version}, ${meta.sourceLessonKeys.length} source lesson(s)`)
      for (const entry of meta.history) writeUsageLine(`  v${entry.version}  ${new Date(entry.at).toISOString()}  ${entry.reason}`)
      return
    }

    if (sub === 'rollback') {
      const slug = positionals()[2]
      const version = Number.parseInt(positionals()[3] ?? '', 10)
      if (!slug || !Number.isFinite(version)) {
        writeError('Usage: elia skills instructions rollback <slug> <version>')
        process.exitCode = 1
        return
      }
      const result = rollbackInstructionSkill(slug, version)
      if (result.ok) writeNotice(`✓ ${result.detail}`)
      else {
        writeError(`✗ ${result.detail}`)
        process.exitCode = 1
      }
      return
    }

    const slugs = elianAuthoredSlugs()
    if (slugs.length === 0) {
      writeNotice(`No self-authored instruction skills yet. Elia writes one under ${INSTRUCTION_SKILLS_ROOT} once enough certified lessons cluster on the same topic.`)
      return
    }
    for (const line of table(
      [{ header: 'skill' }, { header: 'v', align: 'right' }, { header: 'lessons', align: 'right' }, { header: 'updated' }],
      slugs.map((slug) => {
        const meta = readSkillMeta(slug)!
        return [meta.name, `${meta.version}`, `${meta.sourceLessonKeys.length}`, new Date(meta.updatedAt).toISOString().slice(0, 10)]
      }),
    )) {
      writeUsageLine(`  ${line}`)
    }
    writeNotice('elia keeps revising these on its own as certified lessons come and go. `elia skills instructions history <slug>` shows why each version happened; `rollback` restores an archived one.')
    return
  }

  writeError(`Unknown skills action "${action}". Use: list, bundles, path, candidates, synth, trust, untrust, status, or instructions.`)
  process.exitCode = 1
}

export async function runControl(): Promise<void> {
  const { listRuns, readEvents } = await import('../autonomy/journal.ts')
  const { readRunControl, requestRunControl, runControlPath } = await import('../autonomy/control.ts')
  const values = positionals()
  const action = values[0] ?? 'status'
  const runId = values[1]

  if (action === 'preauth') {
    const { currentBranch, listLivePreauth, revokePreauth } = await import('../autonomy/preauth.ts')
    const sub = values[1]
    const branch = await currentBranch(process.cwd())
    if (sub === 'list' || sub === undefined) {
      const grants = listLivePreauth(process.cwd(), branch)
      if (grants.length === 0) {
        writeNotice(`No live pre-authorization grants for this project on branch "${branch}".`)
        return
      }
      for (const grant of grants) {
        const uses = grant.maxUses ? `${grant.usedCount}/${grant.maxUses} uses` : `${grant.usedCount} use(s), no cap`
        writeUsageLine(`${grant.intent} · ${uses} · expires ${new Date(grant.expiresAt).toLocaleTimeString()}`)
      }
      return
    }
    if (sub === 'revoke') {
      const intent = values[2]
      if (!intent) {
        writeError('control preauth revoke requires <intent>')
        process.exitCode = 1
        return
      }
      const revokedCount = revokePreauth(intent, process.cwd(), branch)
      writeNotice(revokedCount > 0 ? `Revoked ${revokedCount} grant(s) for "${intent}" on branch "${branch}".` : `No live grant for "${intent}" on branch "${branch}" — nothing to revoke.`)
      return
    }
    writeError('Usage: elia control preauth list | elia control preauth revoke <intent>')
    process.exitCode = 1
    return
  }

  if (action === 'status') {
    const runs = listRuns(20)
    if (runs.length === 0) {
      writeNotice('No autonomous runs found in this project.')
      return
    }
    for (const run of runs) {
      const ended = readEvents(run.runId).some((event) => event.kind === 'run-end')
      const request = readRunControl(run.runId)
      const state = ended ? `finished:${run.outcome}` : request ? `control-requested:${request.action}` : 'active-or-interrupted'
      writeUsageLine(`${run.runId} · ${state} · ${redactText(run.goal, 120)}`)
    }
    return
  }

  if (action !== 'pause' && action !== 'stop') {
    writeError('Usage: elia control status | elia control pause <run-id> | elia control stop <run-id> | elia control preauth list|revoke <intent>')
    process.exitCode = 1
    return
  }
  if (!runId) {
    writeError(`control ${action} requires <run-id>`)
    process.exitCode = 1
    return
  }
  try {
    runControlPath(runId)
    if (readEvents(runId).some((event) => event.kind === 'run-end')) {
      writeError(`Run ${runId} has already finished; inspect its receipt before resuming or forking it.`)
      process.exitCode = 1
      return
    }
    if (!requestRunControl(runId, action)) {
      writeError(`No durable run found for ${runId}`)
      process.exitCode = 1
      return
    }
  } catch {
    writeError(`Invalid run id: ${runId}`)
    process.exitCode = 1
    return
  }
  writeNotice(`Supervisor ${action} requested for run ${runId}. The owning process will stop at its next control poll.`)
}

export async function runConfig(): Promise<void> {
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetApiKeyEnv, providerPresetBaseURL, providerPresetDefaultModel, providerPresetKeyOptional, providerReadiness } =
    await import('../providers/registry.ts')
  const action = positionals()[0] ?? 'status'
  const configPath = userConfigPath()

  if (action === 'status') {
    const active = process.env.ELIA_PROVIDER ?? 'anthropic'
    // Ollama has no key to look for; whether it is answering is what "configured" means for it.
    const { detectOllama } = await import('../providers/ollama.ts')
    await detectOllama()
    writeNotice(`User config: ${configPath}`)
    for (const provider of PROVIDER_PRESET_NAMES) {
      const marker = provider === active ? ' (active)' : ''
      const status = provider === 'ollama' ? providerReadiness(provider) : isProviderPresetConfigured(provider) ? 'configured' : 'not configured'
      writeUsageLine(`  ${provider}${marker}: ${status}`)
    }
    writeNotice('API key values are never displayed. Use: elia config set --provider <name>')
    return
  }

  if (action === 'remove') {
    const provider = (flagValue('--provider') || '').toLowerCase()
    if (!provider) {
      writeError('Usage: elia config remove --provider <name>')
      process.exitCode = 1
      return
    }
    try {
      const removed = removeProviderConfiguration(provider)
      writeNotice(removed.removed ? `Removed saved credentials for ${removed.provider} from ${removed.path}.` : `No saved credentials found for ${removed.provider}.`)
      writeNotice('The API key value was never displayed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  if (action !== 'set') {
    writeError('Usage: elia config [status|set|remove] [--provider <name>] [--model <id>] [--base-url <url>] [--api-key-env <NAME>|--api-key-stdin]')
    process.exitCode = 1
    return
  }

  const provider = (flagValue('--provider') || process.env.ELIA_PROVIDER || 'anthropic').toLowerCase()
  if (!PROVIDER_PRESET_NAMES.includes(provider)) {
    writeError(`Unknown provider "${provider}". Choose one of: ${PROVIDER_PRESET_NAMES.join(', ')}`)
    process.exitCode = 1
    return
  }

  const modelFlag = flagValue('--model')
  if (modelFlag === '') {
    writeError('--model requires a non-empty model id')
    process.exitCode = 1
    return
  }
  const baseURLFlag = flagValue('--base-url')
  if (baseURLFlag === '') {
    writeError('--base-url requires a non-empty URL')
    process.exitCode = 1
    return
  }
  const sourceKeyEnv = flagValue('--api-key-env')
  if (sourceKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceKeyEnv)) {
    writeError('--api-key-env must be a valid environment variable name')
    process.exitCode = 1
    return
  }
  if (sourceKeyEnv !== undefined && hasFlag('--api-key-stdin')) {
    writeError('Choose either --api-key-env or --api-key-stdin, not both')
    process.exitCode = 1
    return
  }

  // A local provider (Ollama) needs a model and no key, unless one is given for a server that asks for it.
  if (providerPresetKeyOptional(provider) && sourceKeyEnv === undefined && !hasFlag('--api-key-stdin')) {
    if (!modelFlag) {
      writeError(`${provider} needs --model <name> — one of the models \`ollama list\` shows`)
      process.exitCode = 1
      return
    }
    try {
      const saved = saveProviderConfiguration({ provider, apiKey: '', model: modelFlag, ...(baseURLFlag ? { baseURL: baseURLFlag } : {}) })
      writeNotice(`Saved ${provider} configuration to ${saved.path}.`)
      writeNotice(`Model: ${saved.model}${saved.baseURL ? ` · OLLAMA_HOST ${saved.baseURL}` : ''}`)
      writeNotice('No API key is needed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  const targetKeyEnv = providerPresetApiKeyEnv(provider)
  if (!targetKeyEnv) {
    writeError(`Provider "${provider}" does not define an API key variable`)
    process.exitCode = 1
    return
  }

  let apiKey: string | undefined
  if (sourceKeyEnv !== undefined) {
    apiKey = process.env[sourceKeyEnv]?.trim()
    if (!apiKey) {
      writeError(`Environment variable ${sourceKeyEnv} is not set or is empty`)
      process.exitCode = 1
      return
    }
  } else if (hasFlag('--api-key-stdin')) {
    apiKey = (await readStdinText()).trim()
  } else if (process.stdin.isTTY) {
    apiKey = await readSecretInput(`Enter ${targetKeyEnv} (input hidden): `)
  } else {
    writeError('API key input requires --api-key-stdin, --api-key-env <NAME>, or an interactive terminal')
    process.exitCode = 1
    return
  }

  if (!apiKey) {
    writeError('API key cannot be empty')
    process.exitCode = 1
    return
  }

  const defaultModel = providerPresetDefaultModel(provider)
  const model = modelFlag ?? defaultModel
  if (provider === 'custom' && !model) {
    writeError('Custom providers require --model <model-id>')
    process.exitCode = 1
    return
  }
  const baseURL = baseURLFlag
  if (provider === 'custom' && !baseURL) {
    writeError('Custom providers require --base-url <url>')
    process.exitCode = 1
    return
  }

  const values: Record<string, string | undefined> = {
    ELIA_PROVIDER: provider,
    [targetKeyEnv]: apiKey,
    ELIA_MODEL: model,
    ELIA_BASE_URL: baseURL,
  }
  writeUserConfig(values)
  process.env.ELIA_PROVIDER = provider
  process.env[targetKeyEnv] = apiKey
  if (model) process.env.ELIA_MODEL = model
  else delete process.env.ELIA_MODEL
  if (baseURL) process.env.ELIA_BASE_URL = baseURL
  else delete process.env.ELIA_BASE_URL

  const knownBaseURL = baseURL ?? providerPresetBaseURL(provider)
  writeNotice(`Saved ${provider} configuration to ${configPath}.`)
  writeNotice(`Model: ${model ?? defaultModel ?? 'set by ELIA_MODEL'}`)
  if (knownBaseURL) writeNotice(`Endpoint: ${knownBaseURL}`)
  writeNotice('The API key was saved without displaying its value. Run `elia config` to inspect readiness.')
}
