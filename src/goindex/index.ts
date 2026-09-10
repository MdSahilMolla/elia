/** Public surface of the `elia-index` Go sidecar client. See `client.ts` for the contract. */
export {
  GoIndexUnavailable,
  goIndexEnabled,
  goIndexMode,
  resolveGoIndexPath,
  searchWithGoIndex,
  type GoIndexMode,
} from './client.ts'
export { GO_PROTOCOL_VERSION, type GoIndexMatch, type GoIndexQueryResult } from './types.ts'
