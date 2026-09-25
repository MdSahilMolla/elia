export interface Tool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  execute(input: Record<string, unknown>): Promise<string>
  /**
   * True when this tool performs actions through an external agent whose own
   * sandbox/governance elia cannot see (e.g. Codex). Such runs act outside
   * elia's governor; the ledger marks them so a receipt reader can tell
   * governed calls from delegated ones.
   */
  ungoverned?: boolean
}
