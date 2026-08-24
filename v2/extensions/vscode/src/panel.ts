import * as vscode from 'vscode'
import type { EliaBridgeClient, BridgeEvent } from './bridgeClient'

export class EliaPanel {
  private static current?: EliaPanel
  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private sessionId?: string
  private selectedSkills?: string[]

  private constructor(private readonly extensionUri: vscode.Uri, private readonly client: EliaBridgeClient) {
    this.panel = vscode.window.createWebviewPanel('elia.panel', 'Elia Engineering', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    })
    this.panel.webview.html = this.html()
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message), null, this.disposables)
    const eventListener = (event: BridgeEvent) => this.handleBridgeEvent(event)
    this.client.on('event', eventListener)
    this.disposables.push(new vscode.Disposable(() => this.client.off('event', eventListener)))
  }

  static open(extensionUri: vscode.Uri, client: EliaBridgeClient): EliaPanel {
    if (EliaPanel.current) {
      EliaPanel.current.panel.reveal(vscode.ViewColumn.Beside)
      return EliaPanel.current
    }
    EliaPanel.current = new EliaPanel(extensionUri, client)
    return EliaPanel.current
  }

  static sendPrompt(extensionUri: vscode.Uri, client: EliaBridgeClient, prompt: string): void {
    const panel = EliaPanel.open(extensionUri, client)
    panel.panel.webview.postMessage({ type: 'prefill', text: prompt })
  }

  setSkills(skills: string[]): void {
    this.selectedSkills = skills
    this.panel.webview.postMessage({ type: 'skills_selected', skills })
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return
    try {
      if (message.type === 'send') {
        const prompt = asString(message.text, 50_000)
        if (!prompt) return
        const result = await this.client.request('chat.send', {
          prompt,
          sessionId: this.sessionId,
          mode: vscode.workspace.getConfiguration('elia').get<string>('defaultMode', 'dev'),
          governanceMode: vscode.workspace.getConfiguration('elia').get<string>('governanceMode', 'supervised'),
          ...(this.selectedSkills ? { skillNames: this.selectedSkills } : {}),
          context: editorContext(),
        }) as { sessionId?: string }
        if (result.sessionId) this.sessionId = result.sessionId
        return
      }
      if (message.type === 'autonomous') {
        const goal = asString(message.goal, 10_000)
        if (!goal) return
        const config = vscode.workspace.getConfiguration('elia')
        await this.client.request('autonomous.start', {
          goal,
          profile: config.get<string>('profile', 'balanced'),
          maxRunMs: config.get<number>('maxRunMs', 1_800_000),
          maxActions: config.get<number>('maxActions', 300),
        })
        return
      }
      if (message.type === 'approval') {
        const approvalKey = asString(message.approvalKey, 400)
        const decision = message.decision === 'approve' ? 'approve' : 'reject'
        if (approvalKey) await this.client.request('autonomous.approve', { approvalKey, decision })
        return
      }
      if (message.type === 'control') {
        const runId = asString(message.runId, 128)
        const action = message.action === 'pause' || message.action === 'stop' ? message.action : undefined
        if (runId && action) await this.client.request('autonomous.control', { runId, action })
        return
      }
      if (message.type === 'task_control') {
        const taskId = asString(message.taskId, 200)
        const action = message.action
        if (taskId && (action === 'pause' || action === 'resume' || action === 'cancel' || action === 'retry')) {
          await this.client.request('task.control', { taskId, action })
        }
        return
      }
      if (message.type === 'deployment') {
        const action = message.action
        const target = message.target
        const provider = message.provider
        if (!['plan', 'build', 'deploy', 'verify'].includes(String(action))) return
        if (!['vercel', 'netlify'].includes(String(provider))) return
        await this.client.request('deployment.run', {
          action,
          provider,
          ...(typeof target === 'string' ? { target } : {}),
          ...(typeof message.url === 'string' ? { url: message.url } : {}),
          governanceMode: 'supervised',
        })
      }
    } catch (error) {
      this.panel.webview.postMessage({ type: 'client_error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    this.panel.webview.postMessage({ type: 'bridge_event', event: event.event, data: event.data })
  }

  private configuredProvider(): 'auto' | 'vercel' | 'netlify' {
    const provider = vscode.workspace.getConfiguration('elia').get<string>('deploymentProvider', 'auto')
    return provider === 'vercel' || provider === 'netlify' ? provider : 'auto'
  }

  private html(): string {
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    const configuredProvider = this.configuredProvider()
    const vercelSelected = configuredProvider === 'netlify' ? '' : ' selected'
    const netlifySelected = configuredProvider === 'netlify' ? ' selected' : ''
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Elia Engineering</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 16px; margin: 0; }
.status { color: var(--vscode-descriptionForeground); font-size: 11px; }
#messages { display: flex; flex-direction: column; gap: 10px; min-height: 180px; max-height: calc(100vh - 260px); overflow-y: auto; }
.message { padding: 9px 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.4; }
.user { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
.assistant { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 3px solid var(--vscode-testing-iconPassed); }
.tool { background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-blue); font-family: var(--vscode-editor-font-family); font-size: 12px; }
.error { background: var(--vscode-inputValidation-errorBackground); border-left: 3px solid var(--vscode-testing-iconFailed); }
.approval { background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid var(--vscode-editorWarning-foreground); }
.meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 72px; max-height: 180px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; font: inherit; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; padding: 6px 10px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#runGoal { display: none; }
.small { font-size: 11px; }
</style>
</head>
<body>
<header><h1>Elia Engineering</h1><span id="status" class="status">Connecting…</span></header>
<div id="messages"><div class="message assistant"><div class="meta">Elia</div>Ready for workspace questions, governed edits, autonomous runs, verification, and release workflows.</div></div>
<textarea id="prompt" placeholder="Ask Elia to inspect, change, test, or explain this workspace…"></textarea>
<div class="actions">
  <button id="send">Send</button>
  <button id="autonomous" class="secondary">Autonomous run</button>
  <button id="clear" class="secondary">Clear</button>
</div>
<div class="actions small">
  <label for="provider">Provider</label>
  <select id="provider"><option value="vercel"${vercelSelected}>Vercel</option><option value="netlify"${netlifySelected}>Netlify</option></select>
  <button id="preview" class="secondary">Preview deploy</button>
  <button id="production" class="secondary">Production deploy</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const status = document.getElementById('status');
let assistantNode = null;
function add(kind, title, text) {
  const item = document.createElement('div'); item.className = 'message ' + kind;
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = title;
  const body = document.createElement('div'); body.textContent = text || '';
  item.append(meta, body); messages.appendChild(item); messages.scrollTop = messages.scrollHeight; return body;
}
function safeText(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2); }
function providerChoice() { return document.getElementById('provider').value; }
function chooseProvider() { return providerChoice() === 'netlify' ? 'netlify' : 'vercel'; }
document.getElementById('send').onclick = () => { const text = prompt.value.trim(); if (!text) return; add('user', 'You', text); prompt.value = ''; assistantNode = null; vscode.postMessage({ type: 'send', text }); };
document.getElementById('autonomous').onclick = () => { const goal = prompt.value.trim(); if (!goal) { prompt.focus(); return; } add('user', 'Autonomous goal', goal); prompt.value = ''; vscode.postMessage({ type: 'autonomous', goal }); };
document.getElementById('clear').onclick = () => { messages.innerHTML = ''; assistantNode = null; };
document.getElementById('preview').onclick = () => vscode.postMessage({ type: 'deployment', action: 'deploy', provider: chooseProvider(), target: 'preview' });
document.getElementById('production').onclick = () => { if (confirm('Production deployment is a critical external action. Continue to Elia’s approval gate?')) vscode.postMessage({ type: 'deployment', action: 'deploy', provider: chooseProvider(), target: 'production' }); };
prompt.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') document.getElementById('send').click(); });
window.addEventListener('message', ({ data }) => {
  if (data.type === 'bridge_event') {
    const event = data.event, payload = data.data || {};
    if (event === 'bridge_started') { status.textContent = 'Connected'; return; }
    if (event === 'bridge_exit' || event === 'bridge_error') { status.textContent = 'Disconnected'; add('error', 'Bridge', safeText(payload.message)); return; }
    if (event === 'assistant_delta') { if (!assistantNode) assistantNode = add('assistant', 'Elia', ''); assistantNode.textContent += safeText(payload.text); messages.scrollTop = messages.scrollHeight; return; }
    if (event === 'thinking_delta') { if (!${JSON.stringify(false)}) return; add('tool', 'Reasoning', safeText(payload.text)); return; }
    if (event === 'chat_started') { status.textContent = 'Working…'; return; }
    if (event === 'chat_finished') { status.textContent = 'Ready'; assistantNode = null; return; }
    if (event === 'tool_finished') { add(payload.isError ? 'error' : 'tool', 'Tool · ' + safeText(payload.name), safeText(payload.result)); return; }
    if (event === 'approval_required') { const body = add('approval', 'Approval required', safeText(payload.payload || payload)); const wrap = document.createElement('div'); wrap.className = 'actions'; const yes = document.createElement('button'); yes.textContent = 'Approve'; yes.onclick = () => { vscode.postMessage({ type: 'approval', approvalKey: payload.approvalKey, decision: 'approve' }); yes.disabled = true; no.disabled = true; }; const no = document.createElement('button'); no.textContent = 'Reject'; no.className = 'secondary'; no.onclick = () => { vscode.postMessage({ type: 'approval', approvalKey: payload.approvalKey, decision: 'reject' }); yes.disabled = true; no.disabled = true; }; wrap.append(yes, no); body.parentElement.appendChild(wrap); return; }
    if (event === 'phase_started' || event === 'phase_detail' || event === 'check_passed' || event === 'check_failed' || event === 'report_block' || event === 'run_summary') { add(event === 'check_failed' ? 'error' : 'tool', 'Run · ' + event, safeText(payload.message || payload.detail || payload)); return; }
    if (event === 'run_finished') { status.textContent = 'Ready'; add(payload.outcome === 'completed' ? 'assistant' : 'error', 'Autonomous run · ' + safeText(payload.outcome), safeText(payload.completion || payload)); return; }
    if (event === 'autonomous_stderr' || event === 'autonomous_output') { add('tool', 'Autonomous output', safeText(payload.message)); return; }
  }
  if (data.type === 'prefill') { prompt.value = data.text || ''; prompt.focus(); }
  if (data.type === 'client_error') { add('error', 'Extension', safeText(data.message)); status.textContent = 'Error'; }
});
</script>
</body>
</html>`
  }

  private dispose(): void {
    EliaPanel.current = undefined
    while (this.disposables.length > 0) this.disposables.pop()?.dispose()
  }
}

function editorContext(): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return {}
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
  const file = workspaceRoot && editor.document.uri.fsPath.startsWith(workspaceRoot)
    ? vscode.workspace.asRelativePath(editor.document.uri, false)
    : editor.document.uri.fsPath
  const selection = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection).slice(0, 16_000)
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).slice(0, 20).map((diagnostic) => {
    const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info'
    return `${severity} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`.slice(0, 500)
  })
  return { file, language: editor.document.languageId, selection, diagnostics }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= max ? normalized : undefined
}
