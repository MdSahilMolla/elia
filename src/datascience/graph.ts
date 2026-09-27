import { createRng } from './rng.ts'
import { median } from './stats/describe.ts'

/**
 * Graph analytics over an edge list: degree, PageRank, betweenness and closeness
 * centrality, weakly and strongly connected components, Louvain communities with
 * modularity, shortest paths, clustering coefficients, and structural signals often used
 * in fraud and network investigations (bridges between communities, degree outliers).
 */

export interface Graph {
  nodes: string[]
  index: Map<string, number>
  out: Array<Array<{ to: number; weight: number }>>
  in: Array<Array<{ from: number; weight: number }>>
  directed: boolean
  edgeCount: number
}

export function buildGraph(edges: Array<{ source: string; target: string; weight?: number }>, directed = false): Graph {
  const index = new Map<string, number>()
  const nodes: string[] = []
  const id = (name: string) => { let i = index.get(name); if (i === undefined) { i = nodes.length; index.set(name, i); nodes.push(name) } return i }
  const out: Graph['out'] = []
  const incoming: Graph['in'] = []
  const ensure = (i: number) => { while (out.length <= i) { out.push([]); incoming.push([]) } }
  let edgeCount = 0
  for (const edge of edges) {
    const a = id(edge.source)
    const b = id(edge.target)
    ensure(Math.max(a, b))
    const weight = edge.weight ?? 1
    if (!(weight > 0)) throw new Error(`edge ${edge.source}→${edge.target} has non-positive weight ${weight}`)
    out[a]!.push({ to: b, weight })
    incoming[b]!.push({ from: a, weight })
    if (!directed && a !== b) { out[b]!.push({ to: a, weight }); incoming[a]!.push({ from: b, weight }) }
    edgeCount++
  }
  return { nodes, index, out, in: incoming, directed, edgeCount }
}

export function pageRank(graph: Graph, damping = 0.85, tolerance = 1e-10): number[] {
  const n = graph.nodes.length
  let rank = new Array<number>(n).fill(1 / n)
  const outWeight = graph.out.map((edges) => edges.reduce((total, edge) => total + edge.weight, 0))
  for (let iteration = 0; iteration < 200; iteration++) {
    const next = new Array<number>(n).fill((1 - damping) / n)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      if (outWeight[i] === 0) { dangling += rank[i]!; continue }
      for (const edge of graph.out[i]!) next[edge.to]! += (damping * rank[i]! * edge.weight) / outWeight[i]!
    }
    for (let i = 0; i < n; i++) next[i]! += (damping * dangling) / n
    const change = next.reduce((total, value, i) => total + Math.abs(value - rank[i]!), 0)
    rank = next
    if (change < tolerance) break
  }
  return rank
}

/** Dijkstra from one source; returns distances, predecessor lists, and the visit order. */
function dijkstra(graph: Graph, source: number, weighted: boolean): { distance: number[]; sigma: number[]; predecessors: number[][]; order: number[] } {
  const n = graph.nodes.length
  const distance = new Array<number>(n).fill(Number.POSITIVE_INFINITY)
  const sigma = new Array<number>(n).fill(0)
  const predecessors: number[][] = Array.from({ length: n }, () => [])
  const order: number[] = []
  distance[source] = 0
  sigma[source] = 1
  const heap: Array<[number, number]> = [[0, source]]
  const push = (item: [number, number]) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p]![0] <= heap[i]![0]) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p } }
  const pop = () => { const top = heap[0]!; const last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; while (true) { const l = 2 * i + 1; const r = l + 1; let s = i; if (l < heap.length && heap[l]![0] < heap[s]![0]) s = l; if (r < heap.length && heap[r]![0] < heap[s]![0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i]!, heap[s]!]; i = s } } return top }
  const done = new Uint8Array(n)
  while (heap.length) {
    const [d, u] = pop()
    if (done[u]) continue
    done[u] = 1
    order.push(u)
    for (const edge of graph.out[u]!) {
      const next = d + (weighted ? edge.weight : 1)
      if (next < distance[edge.to]! - 1e-12) { distance[edge.to] = next; sigma[edge.to] = sigma[u]!; predecessors[edge.to] = [u]; push([next, edge.to]) }
      else if (Math.abs(next - distance[edge.to]!) <= 1e-12) { sigma[edge.to]! += sigma[u]!; predecessors[edge.to]!.push(u) }
    }
  }
  return { distance, sigma, predecessors, order }
}

/** Brandes betweenness (exact up to 3,000 nodes, otherwise estimated from a seeded sample of sources). */
export function betweenness(graph: Graph, weighted = false, seed = 42): { values: number[]; exact: boolean } {
  const n = graph.nodes.length
  const values = new Array<number>(n).fill(0)
  const exact = n <= 3000
  const sources = exact ? Array.from({ length: n }, (_, i) => i) : createRng(seed).shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, 500)
  for (const s of sources) {
    const { sigma, predecessors, order } = dijkstra(graph, s, weighted)
    const delta = new Array<number>(n).fill(0)
    for (let k = order.length - 1; k >= 0; k--) {
      const w = order[k]!
      for (const v of predecessors[w]!) delta[v]! += (sigma[v]! / sigma[w]!) * (1 + delta[w]!)
      if (w !== s) values[w]! += delta[w]!
    }
  }
  const scale = (exact ? 1 : n / sources.length) * (graph.directed ? 1 : 0.5)
  const normalizer = n > 2 ? (graph.directed ? (n - 1) * (n - 2) : ((n - 1) * (n - 2)) / 2) : 1
  return { values: values.map((value) => (value * scale) / normalizer), exact }
}

export function components(graph: Graph): { weak: number[]; strong?: number[] } {
  const n = graph.nodes.length
  const weak = new Array<number>(n).fill(-1)
  let label = 0
  for (let start = 0; start < n; start++) {
    if (weak[start]! >= 0) continue
    const stack = [start]
    weak[start] = label
    while (stack.length) {
      const u = stack.pop()!
      for (const edge of graph.out[u]!) if (weak[edge.to]! < 0) { weak[edge.to] = label; stack.push(edge.to) }
      for (const edge of graph.in[u]!) if (weak[edge.from]! < 0) { weak[edge.from] = label; stack.push(edge.from) }
    }
    label++
  }
  if (!graph.directed) return { weak }
  // Tarjan's strongly connected components, iterative.
  const strong = new Array<number>(n).fill(-1)
  const indexOf = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  let counter = 0
  let sccLabel = 0
  for (let root = 0; root < n; root++) {
    if (indexOf[root]! >= 0) continue
    const work: Array<[number, number]> = [[root, 0]]
    while (work.length) {
      const frame = work[work.length - 1]!
      const [v, edgeIndex] = frame
      if (edgeIndex === 0 && indexOf[v]! < 0) { indexOf[v] = low[v] = counter++; stack.push(v); onStack[v] = 1 }
      if (edgeIndex < graph.out[v]!.length) {
        frame[1]++
        const w = graph.out[v]![edgeIndex]!.to
        if (indexOf[w]! < 0) work.push([w, 0])
        else if (onStack[w]) low[v] = Math.min(low[v]!, indexOf[w]!)
        continue
      }
      if (low[v] === indexOf[v]) {
        let w: number
        do { w = stack.pop()!; onStack[w] = 0; strong[w] = sccLabel } while (w !== v)
        sccLabel++
      }
      work.pop()
      if (work.length) { const parent = work[work.length - 1]![0]; low[parent] = Math.min(low[parent]!, low[v]!) }
    }
  }
  return { weak, strong }
}

/** Louvain community detection (undirected view) with repeated aggregation; returns labels and modularity. */
export function louvain(graph: Graph, seed = 42): { labels: number[]; modularity: number; levels: number } {
  const rng = createRng(seed)
  // Undirected weighted adjacency.
  let n = graph.nodes.length
  let adjacency: Array<Map<number, number>> = Array.from({ length: n }, () => new Map())
  const addEdge = (a: number, b: number, w: number) => { adjacency[a]!.set(b, (adjacency[a]!.get(b) ?? 0) + w); if (a !== b) adjacency[b]!.set(a, (adjacency[b]!.get(a) ?? 0) + w) }
  graph.out.forEach((edges, a) => edges.forEach((edge) => { if (graph.directed || a <= edge.to) addEdge(a, edge.to, edge.weight) }))
  let membership = Array.from({ length: graph.nodes.length }, (_, i) => i)
  let levels = 0
  const modularityOf = (adj: Array<Map<number, number>>, community: number[]) => {
    const degree = adj.map((m, i) => [...m.entries()].reduce((t, [j, w]) => t + (j === i ? 2 * w : w), 0))
    const twoM = degree.reduce((a, b) => a + b, 0)
    if (twoM === 0) return 0
    let q = 0
    const inside = new Map<number, number>()
    const total = new Map<number, number>()
    adj.forEach((m, i) => {
      total.set(community[i]!, (total.get(community[i]!) ?? 0) + degree[i]!)
      for (const [j, w] of m) if (community[i] === community[j]) inside.set(community[i]!, (inside.get(community[i]!) ?? 0) + (i === j ? 2 * w : w))
    })
    for (const [c, tot] of total) q += (inside.get(c) ?? 0) / twoM - (tot / twoM) ** 2
    return q
  }
  for (let level = 0; level < 20; level++) {
    const degree = adjacency.map((m, i) => [...m.entries()].reduce((t, [j, w]) => t + (j === i ? 2 * w : w), 0))
    const twoM = degree.reduce((a, b) => a + b, 0)
    if (twoM === 0) break
    const community = Array.from({ length: n }, (_, i) => i)
    const communityTotal = [...degree]
    let moved = true
    let improvedAny = false
    let sweeps = 0
    while (moved && sweeps++ < 50) {
      moved = false
      for (const i of rng.shuffle(Array.from({ length: n }, (_, k) => k))) {
        const current = community[i]!
        const links = new Map<number, number>()
        for (const [j, w] of adjacency[i]!) if (j !== i) links.set(community[j]!, (links.get(community[j]!) ?? 0) + w)
        communityTotal[current]! -= degree[i]!
        let best = current
        let bestGain = (links.get(current) ?? 0) - (communityTotal[current]! * degree[i]!) / twoM
        for (const [c, w] of links) {
          const gain = w - (communityTotal[c]! * degree[i]!) / twoM
          if (gain > bestGain + 1e-12) { bestGain = gain; best = c }
        }
        communityTotal[best]! += degree[i]!
        if (best !== current) { community[i] = best; moved = true; improvedAny = true }
      }
    }
    if (!improvedAny) break
    levels++
    const relabel = new Map<number, number>()
    for (const c of community) if (!relabel.has(c)) relabel.set(c, relabel.size)
    membership = membership.map((c) => relabel.get(community[c]!)!)
    const next: Array<Map<number, number>> = Array.from({ length: relabel.size }, () => new Map())
    adjacency.forEach((m, i) => { for (const [j, w] of m) { if (j < i) continue; const a = relabel.get(community[i]!)!; const b = relabel.get(community[j]!)!; next[a]!.set(b, (next[a]!.get(b) ?? 0) + w); if (a !== b) next[b]!.set(a, (next[b]!.get(a) ?? 0) + w) } })
    adjacency = next
    n = relabel.size
    if (n === 1) break
  }
  const original: Array<Map<number, number>> = Array.from({ length: graph.nodes.length }, () => new Map())
  graph.out.forEach((edges, a) => edges.forEach((edge) => { if (graph.directed || a <= edge.to) { original[a]!.set(edge.to, (original[a]!.get(edge.to) ?? 0) + edge.weight); if (a !== edge.to) original[edge.to]!.set(a, (original[edge.to]!.get(a) ?? 0) + edge.weight) } }))
  return { labels: membership, modularity: modularityOf(original, membership), levels }
}

export function shortestPath(graph: Graph, from: string, to: string, weighted = true): { path: string[]; distance: number } | null {
  const a = graph.index.get(from)
  const b = graph.index.get(to)
  if (a === undefined || b === undefined) throw new Error(`unknown node ${a === undefined ? from : to}`)
  const { distance, predecessors } = dijkstra(graph, a, weighted)
  if (!Number.isFinite(distance[b]!)) return null
  const path = [b]
  while (path[0] !== a) path.unshift(predecessors[path[0]!]![0]!)
  return { path: path.map((i) => graph.nodes[i]!), distance: distance[b]! }
}

export function clusteringCoefficient(graph: Graph): number[] {
  const neighbours = graph.out.map((edges, i) => new Set([...edges.map((edge) => edge.to), ...graph.in[i]!.map((edge) => edge.from)].filter((j) => j !== i)))
  return neighbours.map((set) => {
    const list = [...set]
    const k = list.length
    if (k < 2) return 0
    let links = 0
    for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) if (neighbours[list[x]!]!.has(list[y]!)) links++
    return (2 * links) / (k * (k - 1))
  })
}

export function analyzeGraph(graph: Graph, options: { weighted?: boolean; top?: number; seed?: number } = {}): Record<string, unknown> {
  const n = graph.nodes.length
  const top = options.top ?? 15
  const degree = graph.out.map((edges, i) => (graph.directed ? edges.length + graph.in[i]!.length : edges.length))
  const pr = pageRank(graph)
  const bc = betweenness(graph, options.weighted ?? false, options.seed)
  const comp = components(graph)
  const communities = louvain(graph, options.seed)
  const cc = clusteringCoefficient(graph)
  const componentSizes = new Map<number, number>()
  for (const c of comp.weak) componentSizes.set(c, (componentSizes.get(c) ?? 0) + 1)
  const communitySizes = new Map<number, number>()
  for (const c of communities.labels) communitySizes.set(c, (communitySizes.get(c) ?? 0) + 1)
  const rank = (values: number[]) => values.map((value, i) => ({ node: graph.nodes[i]!, value })).sort((a, b) => b.value - a.value).slice(0, top)
  const medianDegree = median(degree)
  const mad = median(degree.map((d) => Math.abs(d - medianDegree))) * 1.4826 || 1
  const bridges = graph.nodes.map((node, i) => {
    const neighbourCommunities = new Set(graph.out[i]!.map((edge) => communities.labels[edge.to]!))
    return { node, communitiesTouched: neighbourCommunities.size, betweenness: bc.values[i]! }
  }).filter((entry) => entry.communitiesTouched >= 3).sort((a, b) => b.betweenness - a.betweenness).slice(0, top)
  return {
    nodes: n,
    edges: graph.edgeCount,
    directed: graph.directed,
    density: n > 1 ? graph.edgeCount / (graph.directed ? n * (n - 1) : (n * (n - 1)) / 2) : 0,
    averageDegree: degree.reduce((a, b) => a + b, 0) / Math.max(1, n),
    averageClustering: cc.reduce((a, b) => a + b, 0) / Math.max(1, n),
    components: { count: componentSizes.size, largest: Math.max(...componentSizes.values()), ...(comp.strong ? { stronglyConnected: new Set(comp.strong).size } : {}) },
    communities: { count: communitySizes.size, modularity: communities.modularity, sizes: [...communitySizes.values()].sort((a, b) => b - a).slice(0, 20) },
    topDegree: rank(degree),
    topPageRank: rank(pr),
    topBetweenness: rank(bc.values),
    betweennessExact: bc.exact,
    degreeOutliers: graph.nodes.map((node, i) => ({ node, degree: degree[i]!, robustZ: (degree[i]! - medianDegree) / mad })).filter((entry) => entry.robustZ > 5).sort((a, b) => b.degree - a.degree).slice(0, top),
    bridges,
    notes: ['High centrality and bridging mean structural importance, not wrongdoing; in fraud work they are leads for investigation, not conclusions.', ...(bc.exact ? [] : ['betweenness is estimated from 500 sampled sources (seeded)'])],
    labels: { communities: communities.labels, components: comp.weak, pagerank: pr, betweenness: bc.values, degree },
  }
}
