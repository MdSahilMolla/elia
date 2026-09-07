/** Public surface of the `eliad` client. See `client.ts` for the contract. */
export {
  DaemonUnavailable,
  daemonClient,
  daemonEnabled,
  daemonMode,
  daemonParseCheck,
  daemonShellExec,
  resolveEliadPath,
  socketPath,
  type DaemonMode,
  type DaemonShellRequest,
} from './client.ts'
export {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type ParseCheckResult,
  type ShellExecResult,
} from './types.ts'
