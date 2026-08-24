import * as vscode from 'vscode'
import * as path from 'node:path'
import { EliaBridgeClient, type BridgeEvent } from './bridgeClient'
import { EliaPanel } from './panel'

let client: EliaBridgeClient | undefined
let extensionContext: vscode.ExtensionContext | undefined
let refreshViews = (): void => undefined

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Elia needs an open workspace to run its governed coding workflow.')
    return
  }

  const config = vscode.workspace.getConfiguration('elia')
  client = new EliaBridgeClient({
    workspaceRoot,
    cliPath: config.get<string>('cliPath', 'elia'),
    runtime: config.get<'auto' | 'bun' | 'node'>('runtime', 'auto'),
    onEvent: (event) => {
      onBridgeEvent(event)
      if (event.event === 'tasks_updated' || event.event === 'run_finished' || event.event === 'run_summary' || event.event === 'bridge_started') refreshViews()
    },
    onStderr: (message) => {
      if (message.toLowerCase().includes('error')) vscode.window.setStatusBarMessage(`Elia: ${message.slice(0, 200)}`, 5_000)
    },
  })
  context.subscriptions.push(new vscode.Disposable(() => void client?.stop()))

  const tasks = new EliaTreeProvider('tasks.list', client, taskLabel, taskDescription)
  const runs = new EliaTreeProvider('runs.list', client, runLabel, runDescription)
  const skills = new EliaTreeProvider('skills.list', client, skillLabel, skillDescription)
  context.subscriptions.push(vscode.window.registerTreeDataProvider('elia.tasks', tasks))
  context.subscriptions.push(vscode.window.registerTreeDataProvider('elia.runs', runs))
  context.subscriptions.push(vscode.window.registerTreeDataProvider('elia.skills', skills))

  const refresh = () => {
    tasks.refresh()
    runs.refresh()
    skills.refresh()
  }
  refreshViews = refresh
  context.subscriptions.push(vscode.commands.registerCommand('elia.openPanel', () => EliaPanel.open(context.extensionUri, requireClient())))
  context.subscriptions.push(vscode.commands.registerCommand('elia.ask', () => askAboutWorkspace()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.autonomousStart', () => startAutonomous()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.refreshTasks', refresh))
  context.subscriptions.push(vscode.commands.registerCommand('elia.pauseRun', () => controlRun('pause')))
  context.subscriptions.push(vscode.commands.registerCommand('elia.stopRun', () => controlRun('stop')))
  context.subscriptions.push(vscode.commands.registerCommand('elia.resumeRun', () => resumeRun()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.selectSkills', () => selectSkills()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.inspectEnvironment', () => inspectEnvironment()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.previewDeploy', () => deploy('preview')))
  context.subscriptions.push(vscode.commands.registerCommand('elia.productionDeploy', () => deploy('production')))
  context.subscriptions.push(vscode.commands.registerCommand('elia.verifyDeployment', () => verifyDeployment()))
  context.subscriptions.push(vscode.commands.registerCommand('elia.openReceipt', () => openLatestReceipt(workspaceRoot)))
  context.subscriptions.push(vscode.commands.registerCommand('elia.reviewDiff', () => reviewDiff()))

  if (config.get<boolean>('autoStartBridge', true)) {
    void requireClient().start().then(() => refresh(), (error: unknown) => {
      vscode.window.showErrorMessage(`Elia bridge could not start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

export function deactivate(): void {
  void client?.stop()
  client = undefined
}

function requireClient(): EliaBridgeClient {
  if (!client) throw new Error('Elia is not available without an open workspace')
  return client
}

function onBridgeEvent(event: BridgeEvent): void {
  if (event.event === 'bridge_started') vscode.window.setStatusBarMessage('Elia: connected', 3_000)
  if (event.event === 'bridge_exit') vscode.window.setStatusBarMessage('Elia: bridge disconnected', 5_000)
  if (event.event === 'approval_required') {
    const payload = event.data.payload as Record<string, unknown> | undefined
    const action = payload?.request as Record<string, unknown> | undefined
    vscode.window.showInformationMessage(`Elia approval required for ${String(action?.name ?? event.data.kind ?? 'action')}. Review it in the Elia panel.`)
    EliaPanel.open(extensionContext!.extensionUri, requireClient())
  }
}

async function askAboutWorkspace(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  const document = editor?.document
  const selection = editor && !editor.selection.isEmpty ? document?.getText(editor.selection) : undefined
  const file = document?.uri.fsPath
  const prompt = await vscode.window.showInputBox({
    prompt: 'Ask Elia about the current workspace or selection',
    value: selection ? `Review this selected code and suggest a precise improvement:\n\n${selection.slice(0, 16_000)}` : file ? `Inspect ${path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', file)} and explain the relevant implementation.` : undefined,
    valueSelection: selection ? [0, 0] : undefined,
  })
  if (prompt?.trim()) EliaPanel.sendPrompt(extensionContext!.extensionUri, requireClient(), prompt.trim())
}

async function startAutonomous(): Promise<void> {
  const goal = await vscode.window.showInputBox({ prompt: 'What should Elia complete end to end?', placeHolder: 'Implement the feature, run tests, and prepare a verified preview deployment' })
  if (!goal?.trim()) return
  await requireClient().request('autonomous.start', {
    goal: goal.trim(),
    profile: vscode.workspace.getConfiguration('elia').get<string>('profile', 'balanced'),
    maxRunMs: vscode.workspace.getConfiguration('elia').get<number>('maxRunMs', 1_800_000),
    maxActions: vscode.workspace.getConfiguration('elia').get<number>('maxActions', 300),
  })
  EliaPanel.open(extensionContext!.extensionUri, requireClient())
}

async function controlRun(action: 'pause' | 'stop'): Promise<void> {
  const runs = await requireClient().request('runs.list', { limit: 16 }) as Array<{ runId: string; goal: string; outcome: string }>
  const active = runs.filter((run) => run.outcome === 'incomplete')
  const selected = await vscode.window.showQuickPick(active.map((run) => ({ label: run.runId, description: run.goal, run })), { placeHolder: `Select a run to ${action}` })
  if (selected) await requireClient().request('autonomous.control', { runId: selected.run.runId, action })
}

async function resumeRun(): Promise<void> {
  const runs = await requireClient().request('runs.list', { limit: 16 }) as Array<{ runId: string; goal: string; outcome: string }>
  const resumable = runs.filter((run) => run.outcome === 'incomplete' || run.outcome === 'needs-attention' || run.outcome === 'aborted')
  const selected = await vscode.window.showQuickPick(resumable.map((run) => ({ label: run.runId, description: run.goal, run })), { placeHolder: 'Select a durable run to resume' })
  if (!selected) return
  await requireClient().request('autonomous.start', { runId: selected.run.runId, goal: selected.run.goal, resume: true })
}

async function selectSkills(): Promise<void> {
  const catalog = await requireClient().request('skills.list') as { loaded?: Array<{ name: string; source: string }>; bundles?: Array<{ name: string; description?: string; skills: string[] }> }
  const items = [
    ...(catalog.bundles ?? []).map((bundle) => ({ label: `$(package) ${bundle.name}`, description: bundle.description ?? `${bundle.skills.length} skills`, value: bundle.name })),
    ...(catalog.loaded ?? []).map((skill) => ({ label: `$(symbol-interface) ${skill.name}`, description: skill.source, value: skill.name })),
  ]
  const selected = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select skills or bundles for the next Elia turn' })
  if (selected) EliaPanel.open(extensionContext!.extensionUri, requireClient()).setSkills(selected.map((item) => item.value))
}

async function inspectEnvironment(): Promise<void> {
  const environment = await requireClient().request('environment.inspect')
  const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(environment, null, 2), language: 'json' })
  await vscode.window.showTextDocument(document, { preview: false })
}

async function deploy(target: 'preview' | 'production'): Promise<void> {
  const configured = vscode.workspace.getConfiguration('elia').get<string>('deploymentProvider', 'auto')
  const provider = configured === 'netlify' ? 'netlify' : configured === 'vercel' ? 'vercel' : await vscode.window.showQuickPick(['vercel', 'netlify'], { placeHolder: 'Choose the already-linked deployment provider' })
  if (!provider) return
  if (target === 'production') {
    const confirmation = await vscode.window.showWarningMessage('Production deployment is a critical external action. Continue to Elia’s exact approval gate?', { modal: true }, 'Continue')
    if (confirmation !== 'Continue') return
  }
  const result = await requireClient().request('deployment.run', { action: 'deploy', provider, target, governanceMode: 'supervised' })
  const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: 'json' })
  await vscode.window.showTextDocument(document, { preview: true })
}

async function verifyDeployment(): Promise<void> {
  const provider = await vscode.window.showQuickPick(['vercel', 'netlify'], { placeHolder: 'Provider hostname to verify' })
  if (!provider) return
  const url = await vscode.window.showInputBox({ prompt: 'HTTPS deployment URL', placeHolder: provider === 'vercel' ? 'https://your-project.vercel.app' : 'https://your-project.netlify.app' })
  if (!url) return
  const result = await requireClient().request('deployment.run', { action: 'verify', provider, url, governanceMode: 'unattended' })
  const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: 'json' })
  await vscode.window.showTextDocument(document, { preview: true })
}

async function reviewDiff(): Promise<void> {
  const result = await requireClient().request('git.diff') as { status?: string; diff?: string; error?: string }
  if (result.status !== 'ok') return void vscode.window.showErrorMessage(`Elia could not read the workspace diff: ${result.error ?? 'unknown error'}`)
  const document = await vscode.workspace.openTextDocument({ content: result.diff ?? '(working tree is clean)', language: 'diff' })
  await vscode.window.showTextDocument(document, { preview: false })
}

async function openLatestReceipt(workspaceRoot: string): Promise<void> {
  const runs = await requireClient().request('runs.list', { limit: 1 }) as Array<{ runId: string }>
  const latest = runs[0]
  if (!latest) return void vscode.window.showInformationMessage('Elia has no autonomous run receipts in this workspace.')
  const uri = vscode.Uri.file(path.join(workspaceRoot, '.elia', 'runs', latest.runId, 'receipt.md'))
  try {
    await vscode.window.showTextDocument(uri, { preview: false })
  } catch {
    vscode.window.showInformationMessage(`No receipt was written yet for ${latest.runId}.`)
  }
}

class EliaTreeProvider extends vscode.Disposable implements vscode.TreeDataProvider<EliaTreeItem> {
  private readonly changed = new vscode.EventEmitter<EliaTreeItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private items: EliaTreeItem[] = []

  constructor(
    private readonly method: 'tasks.list' | 'runs.list' | 'skills.list',
    private readonly bridge: EliaBridgeClient,
    private readonly label: (value: Record<string, unknown>) => string,
    private readonly description: (value: Record<string, unknown>) => string,
  ) {
    super(() => this.changed.dispose())
    void this.refresh()
  }

  refresh(): void {
    void this.load()
  }

  getTreeItem(element: EliaTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): EliaTreeItem[] {
    return this.items
  }

  private async load(): Promise<void> {
    try {
      const result = await this.bridge.request(this.method)
      const values = Array.isArray(result) ? result : this.method === 'skills.list' ? ((result as { loaded?: unknown[] }).loaded ?? []) : []
      this.items = values.filter(isRecord).slice(0, 80).map((value) => new EliaTreeItem(this.label(value), this.description(value), this.method, value))
      this.changed.fire(undefined)
    } catch {
      this.items = [new EliaTreeItem('Elia bridge unavailable', 'Start or configure the local bridge', this.method, {})]
      this.changed.fire(undefined)
    }
  }
}

class EliaTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string, method: string, readonly value: Record<string, unknown>) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.contextValue = method.replace('.', '_')
    this.tooltip = `${label}${description ? ` — ${description}` : ''}`
  }
}

function taskLabel(value: Record<string, unknown>): string { return `${String(value.status ?? 'task')} · ${String(value.title ?? value.id ?? 'unknown')}` }
function taskDescription(value: Record<string, unknown>): string { return `${String(value.action ?? '')}${value.progress !== undefined ? ` · ${Math.round(Number(value.progress) * 100)}%` : ''}` }
function runLabel(value: Record<string, unknown>): string { return `${String(value.outcome ?? 'incomplete')} · ${String(value.runId ?? 'run')}` }
function runDescription(value: Record<string, unknown>): string { return String(value.goal ?? '') }
function skillLabel(value: Record<string, unknown>): string { return String(value.name ?? value.file ?? 'skill') }
function skillDescription(value: Record<string, unknown>): string { return String(value.source ?? value.file ?? '') }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
