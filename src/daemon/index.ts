/** Public surface of the `eliad` client. See `client.ts` for the contract. */
export {
  DaemonUnavailable,
  daemonClient,
  daemonEnabled,
  daemonJvmCheck,
  daemonMode,
  daemonParseCheck,
  daemonShellExec,
  resolveEliadPath,
  resolveJvmBridgeJar,
  socketPath,
  type DaemonMode,
  type DaemonShellRequest,
} from './client.ts'
export {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type JvmCheckResult,
  type ParseCheckResult,
  type ShellExecResult,
} from './types.ts'
