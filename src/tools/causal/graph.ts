// Causal graph: a modular, queryable representation of causal relationships
// between commits, files, functions, tests, and errors.

import type { CausalGraph, CausalNode, CausalEdge, EdgeType, NodeType, EvidenceKind, EvidenceEntry } from './types.ts'

let edgeCounter = 0

/** Create an empty causal graph. */
export function createGraph(): CausalGraph {
  return {
    nodes: new Map(),
    edges: new Map(),
    adjacency: new Map(),
    reverseAdj: new Map(),
  }
}

/** Add a node to the graph. Returns the node ID. */
export function addNode(
  graph: CausalGraph,
  type: NodeType,
  label: string,
  metadata: Record<string, unknown> = {},
  filePath?: string,
  startLine?: number,
  endLine?: number,
  commitHash?: string,
): string {
  const id = `${type}_${label}_${filePath ?? ''}_${startLine ?? ''}_${commitHash ?? ''}`.replace(/[^a-zA-Z0-9_]/g, '_')
  if (graph.nodes.has(id)) return id
  const node: CausalNode = { id, type, label, metadata, filePath, startLine, endLine, commitHash }
  graph.nodes.set(id, node)
  graph.adjacency.set(id, [])
  graph.reverseAdj.set(id, [])
  return id
}

/** Add an edge to the graph. Returns the edge ID. */
export function addEdge(
  graph: CausalGraph,
  source: string,
  target: string,
  type: EdgeType,
  confidence: number,
  kind: EvidenceKind = 'evidence',
  evidence: EvidenceEntry[] = [],
): string {
  const id = `edge_${++edgeCounter}`
  const edge: CausalEdge = { id, source, target, type, confidence, evidence, kind }
  graph.edges.set(id, edge)
  graph.adjacency.get(source)?.push(id)
  graph.reverseAdj.get(target)?.push(id)
  return id
}

/** Get all outgoing edges from a node. */
export function outgoingEdges(graph: CausalGraph, nodeId: string): CausalEdge[] {
  const edgeIds = graph.adjacency.get(nodeId) ?? []
  return edgeIds.map((id) => graph.edges.get(id)!).filter(Boolean)
}

/** Get all incoming edges to a node. */
export function incomingEdges(graph: CausalGraph, nodeId: string): CausalEdge[] {
  const edgeIds = graph.reverseAdj.get(nodeId) ?? []
  return edgeIds.map((id) => graph.edges.get(id)!).filter(Boolean)
}

/** Find nodes by type. */
export function findNodesByType(graph: CausalGraph, type: NodeType): CausalNode[] {
  return [...graph.nodes.values()].filter((n) => n.type === type)
}

/** Find nodes by commit hash. */
export function findNodesByCommit(graph: CausalGraph, hash: string): CausalNode[] {
  return [...graph.nodes.values()].filter((n) => n.commitHash?.startsWith(hash))
}

/** Find nodes by file path. */
export function findNodesByFile(graph: CausalGraph, filePath: string): CausalNode[] {
  return [...graph.nodes.values()].filter((n) => n.filePath === filePath)
}

/** Get all ancestors of a node (following incoming edges). */
export function getAncestors(graph: CausalGraph, nodeId: string, maxDepth = 20): string[] {
  const visited = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }]
  const result: string[] = []

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id) || depth > maxDepth) continue
    visited.add(id)
    if (id !== nodeId) result.push(id)

    const incoming = incomingEdges(graph, id)
    for (const edge of incoming) {
      queue.push({ id: edge.source, depth: depth + 1 })
    }
  }
  return result
}

/** Get all descendants of a node (following outgoing edges). */
export function getDescendants(graph: CausalGraph, nodeId: string, maxDepth = 20): string[] {
  const visited = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }]
  const result: string[] = []

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id) || depth > maxDepth) continue
    visited.add(id)
    if (id !== nodeId) result.push(id)

    const outgoing = outgoingEdges(graph, id)
    for (const edge of outgoing) {
      queue.push({ id: edge.target, depth: depth + 1 })
    }
  }
  return result
}

/** Find a path between two nodes (BFS). */
export function findPath(graph: CausalGraph, from: string, to: string, maxDepth = 30): string[] | null {
  const visited = new Set<string>()
  const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }]

  while (queue.length > 0) {
    const { id, path } = queue.shift()!
    if (id === to) return path
    if (path.length > maxDepth) continue
    if (visited.has(id)) continue
    visited.add(id)

    const outgoing = outgoingEdges(graph, id)
    for (const edge of outgoing) {
      queue.push({ id: edge.target, path: [...path, edge.target] })
    }
  }
  return null
}

/** Find the strongest causal chain from a commit to a target node. */
export function findCausalChain(graph: CausalGraph, commitHash: string, targetNodeId: string): string[] | null {
  const commitNodes = findNodesByCommit(graph, commitHash)
  if (commitNodes.length === 0) return null

  let bestPath: string[] | null = null
  let bestConfidence = 0

  for (const commitNode of commitNodes) {
    const path = findPath(graph, commitNode.id, targetNodeId)
    if (path) {
      const confidence = pathEdgeConfidence(graph, path)
      if (confidence > bestConfidence) {
        bestConfidence = confidence
        bestPath = path
      }
    }
  }
  return bestPath
}

/** Compute the minimum confidence along a path. */
function pathEdgeConfidence(graph: CausalGraph, path: string[]): number {
  if (path.length < 2) return 1
  let minConf = 1
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!
    const to = path[i + 1]!
    const edges = outgoingEdges(graph, from).filter((e) => e.target === to)
    if (edges.length === 0) return 0
    const best = Math.max(...edges.map((e) => e.confidence))
    if (best < minConf) minConf = best
  }
  return minConf
}

/** Get graph statistics. */
export function graphStats(graph: CausalGraph): {
  nodeCount: number
  edgeCount: number
  nodesByType: Record<string, number>
  edgesByType: Record<string, number>
  avgConfidence: number
} {
  const nodesByType: Record<string, number> = {}
  for (const node of graph.nodes.values()) {
    nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1
  }
  const edgesByType: Record<string, number> = {}
  let totalConf = 0
  for (const edge of graph.edges.values()) {
    edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1
    totalConf += edge.confidence
  }
  return {
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.size,
    nodesByType,
    edgesByType,
    avgConfidence: graph.edges.size > 0 ? totalConf / graph.edges.size : 0,
  }
}
