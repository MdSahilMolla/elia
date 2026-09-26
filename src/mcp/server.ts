#!/usr/bin/env bun
import '../bootstrapEnv.ts'
import type { ActionApproval } from '../autonomy/governor.ts'
import {
  loadEliaMcpServerConfigFromCli,
  loadOrCreateMcpAuthToken,
  type EliaMcpServerConfig,
} from './config.ts'
import { createHttpMcpTransport, type McpHttpServer } from './httpTransport.ts'
import { createPromptProvider } from './prompts.ts'
import { createResourceProvider } from './resources.ts'
import {
  handleMcpRequest as dispatchMcpRequest,
  type JsonRpcResponse,
  type McpProtocolRequestOptions,
} from './protocol.ts'
import { createMcpServerRegistry, type CreateMcpServerRegistryOptions, type McpServerRegistry } from './serverRegistry.ts'
import { createMcpServerRuntime, type McpServerRuntime } from './serverRuntime.ts'
import {
  createStdioTransport,
  type McpStdioTransport,
  type StdioTransportOptions,
} from './stdioTransport.ts'
import type { EliaMode, McpClientCapabilities, McpToolExecutionContext } from './serverTypes.ts'

export interface CreateEliaMcpServerOptions {
  config?: EliaMcpServerConfig
  cwd?: string
  mode?: EliaMode
  approve?: ActionApproval
  registry?: Omit<CreateMcpServerRegistryOptions, 'context'>
}

export interface EliaMcpServer {
  readonly config: EliaMcpServerConfig
  readonly runtime: McpServerRuntime
  readonly registry: McpServerRegistry
  handleRequest: (
    request: unknown,
    options?: Pick<McpProtocolRequestOptions, 'clientCapabilities' | 'signal'>,
  ) => Promise<JsonRpcResponse | undefined>
  close: () => Promise<void>
}

export interface StartedStdioMcpServer {
  readonly server: EliaMcpServer
  readonly transport: McpStdioTransport
  close: () => Promise<void>
}

export interface StartedHttpMcpServer {
  readonly server: EliaMcpServer
  readonly transport: McpHttpServer
  close: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function initializeCapabilities(request: unknown): McpClientCapabilities | undefined {
  const entries = Array.isArray(request) ? request : [request]
  for (const entry of entries) {
    if (!isRecord(entry) || entry.method !== 'initialize' || !isRecord(entry.params)) continue
    const capabilities = entry.params.capabilities
    if (isRecord(capabilities)) return capabilities as McpClientCapabilities
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createEliaMcpServer(options: CreateEliaMcpServerOptions = {}): Promise<EliaMcpServer> {
  const config = options.config ?? loadEliaMcpServerConfigFromCli()
  const runtime = await createMcpServerRuntime({
    config,
    cwd: options.cwd,
    mode: options.mode,
    approve: options.approve,
  })
  const registryOptions = options.registry ?? {}
  const registry = createMcpServerRegistry({
    ...registryOptions,
    context: runtime,
    resourceProvider: registryOptions.resourceProvider ?? createResourceProvider(runtime),
    promptProvider: registryOptions.promptProvider ?? createPromptProvider(runtime),
  })
  let clientCapabilities: McpClientCapabilities | undefined
  let closed = false
  // The registry filters tools by the mode it is handed, and every tool reads
  // its mode off the execution context, so both have to follow elia_set_mode
  // rather than the mode the process happened to start in.
  const liveContext = (): McpToolExecutionContext => ({ ...runtime, mode: runtime.getMode('server') })
  return {
    config,
    runtime,
    registry,
    async handleRequest(request, requestOptions) {
      clientCapabilities = requestOptions?.clientCapabilities ?? initializeCapabilities(request) ?? clientCapabilities
      return dispatchMcpRequest(request, registry, {
        context: liveContext(),
        clientCapabilities,
        signal: requestOptions?.signal,
      })
    },
    async close() {
      if (closed) return
      closed = true
      runtime.dispose()
    },
  }
}

export async function startStdioMcpServer(
  options: CreateEliaMcpServerOptions & Pick<StdioTransportOptions, 'input' | 'output' | 'maxLineBytes' | 'onError'> = {},
): Promise<StartedStdioMcpServer> {
  const server = await createEliaMcpServer(options)
  const onError = options.onError ?? ((error: unknown) => console.error(`elia-mcp stdio: ${errorMessage(error)}`))
  let clientCapabilities: McpClientCapabilities | undefined
  const transport = createStdioTransport({
    backend: server.registry,
    requestOptions: (message) => {
      clientCapabilities = initializeCapabilities(message) ?? clientCapabilities
      return { context: server.runtime, clientCapabilities }
    },
    input: options.input,
    output: options.output,
    maxLineBytes: options.maxLineBytes,
    onError,
  })
  void transport.start().catch(async (error: unknown) => {
    onError(error)
    await server.close()
  })
  return {
    server,
    transport,
    async close() {
      await transport.close()
      await server.close()
    },
  }
}

export async function startHttpMcpServer(
  options: CreateEliaMcpServerOptions & { token?: string; onError?: (error: unknown) => void } = {},
): Promise<StartedHttpMcpServer> {
  const config = options.config ?? loadEliaMcpServerConfigFromCli()
  const auth = options.token
    ? { token: options.token, generated: false, path: config.tokenPath }
    : loadOrCreateMcpAuthToken(config.tokenPath)
  const server = await createEliaMcpServer({ ...options, config })
  const onError = options.onError ?? ((error: unknown) => console.error(`elia-mcp HTTP: ${errorMessage(error)}`))
  const transport = createHttpMcpTransport({
    backend: server.registry,
    requestOptions: { context: server.runtime },
    token: auth.token,
    host: config.host,
    port: config.port,
    allowRemoteHost: config.allowRemoteHost,
    getRunStatus(runId) {
      const state = server.runtime.runStates.get(runId)
      if (!state) throw new Error(`Unknown run: ${runId}`)
      return state
    },
    subscribeProgress: server.runtime.subscribeProgress,
    onError,
  })
  return {
    server,
    transport,
    async close() {
      transport.stop()
      await server.close()
    },
  }
}

function readinessLine(server: EliaMcpServer): string {
  return `elia-mcp ready. ${server.registry.toolCount} tools, ${server.registry.resourceCount} resources, ${server.registry.promptCount} prompts registered.`
}

export async function runMcpServerFromCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = loadEliaMcpServerConfigFromCli(args, env)
  if (config.transport === 'http') {
    const auth = loadOrCreateMcpAuthToken(config.tokenPath)
    if (auth.generated) console.error(`elia-mcp generated HTTP auth token at ${auth.path}`)
    const started = await startHttpMcpServer({ config, token: auth.token })
    console.error(readinessLine(started.server))
    await new Promise<void>((resolve) => {
      let closing = false
      const shutdown = (): void => {
        if (closing) return
        closing = true
        process.removeListener('SIGINT', shutdown)
        process.removeListener('SIGTERM', shutdown)
        void started.close().then(resolve)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    return
  }
  const started = await startStdioMcpServer({ config })
  console.error(readinessLine(started.server))
  await started.transport.closed
  await started.server.close()
}

export { dispatchMcpRequest as handleMcpRequest }

function isEntrypoint(): boolean {
  if (import.meta.main) return true
  return /(?:^|[\\/])elia-mcp(?:\.[cm]?[jt]s)?$/u.test(process.argv[1] ?? '')
}

if (isEntrypoint()) {
  void runMcpServerFromCli().catch((error: unknown) => {
    console.error(`elia-mcp failed: ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
