/**
 * The mesh sidecar integration: the file plane that keeps a project folder
 * converged across two peers over LAN/VPN.
 *
 * The component (`workspace attach`) owns conflict detection, preservation and
 * the authenticated transport. Elia owns supervision and turns the sidecar's
 * structured stream into `FileChanged` observations. Nothing here pairs peers;
 * that stays an explicit user command.
 */

export { meshEnabled, meshMode, meshPathProblem, resolveMeshPath, type MeshMode } from './mode.ts'
export { isMeshPaired, readMeshPairing, type MeshPairing } from './pairing.ts'
export {
  encodeMeshControl,
  MESH_PROTOCOL_VERSION,
  parseMeshFrame,
  toIncomingFileChange,
  type MeshChange,
  type MeshControl,
  type MeshEvent,
  type MeshFrame,
  type MeshInvite,
  type MeshPeer,
  type MeshReady,
} from './frames.ts'
export { meshObservationEvents } from './observation.ts'
export { REPLICATION_BATCH, shouldReplicate, startReplication, type ReplicationHandle, type ReplicationOptions } from './replication.ts'
export {
  decideMeshStart,
  meshRestartDelayMs,
  startMeshSupervisor,
  type MeshBackoffOptions,
  type MeshDecision,
  type MeshFileChange,
  type MeshRestart,
  type MeshSpawn,
  type MeshSupervisorHandle,
  type MeshSupervisorOptions,
} from './supervisor.ts'
