import { createRng } from './rng.ts'
import { mean } from './stats/describe.ts'
import { normalCdf } from './stats/special.ts'

/**
 * Geospatial analysis on latitude/longitude points: great-circle distances, nearest
 * facility assignment, radius counts, density grids, DBSCAN clustering in kilometres,
 * point-in-polygon spatial joins against GeoJSON, p-median facility location, and Moran's I
 * spatial autocorrelation. Geocoding (address → coordinates) needs an external service and
 * is not performed here.
 */

const EARTH_KM = 6371.0088

export interface Point { lat: number; lon: number }

export function haversineKm(a: Point, b: Point): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLon = (b.lon - a.lon) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function validatePoint(lat: unknown, lon: unknown): Point | null {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (lat === 0 && lon === 0) return null
  return { lat, lon }
}

export function nearest(points: Point[], facilities: Array<Point & { id: string }>): Array<{ facility: string; distanceKm: number }> {
  if (!facilities.length) throw new Error('nearest needs at least one facility')
  return points.map((point) => {
    let best = facilities[0]!
    let bestDistance = Number.POSITIVE_INFINITY
    for (const facility of facilities) { const d = haversineKm(point, facility); if (d < bestDistance) { bestDistance = d; best = facility } }
    return { facility: best.id, distanceKm: bestDistance }
  })
}

export function withinRadius(points: Point[], centres: Array<Point & { id: string }>, radiusKm: number): Array<{ id: string; count: number }> {
  return centres.map((centre) => ({ id: centre.id, count: points.filter((point) => haversineKm(point, centre) <= radiusKm).length }))
}

export function densityGrid(points: Point[], cellDegrees = 0.1, values?: number[]): Array<{ lat: number; lon: number; count: number; sum?: number }> {
  const cells = new Map<string, { lat: number; lon: number; count: number; sum: number }>()
  points.forEach((point, i) => {
    const lat = Math.floor(point.lat / cellDegrees) * cellDegrees + cellDegrees / 2
    const lon = Math.floor(point.lon / cellDegrees) * cellDegrees + cellDegrees / 2
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`
    const cell = cells.get(key) ?? { lat, lon, count: 0, sum: 0 }
    cell.count++
    cell.sum += values?.[i] ?? 0
    cells.set(key, cell)
  })
  return [...cells.values()].sort((a, b) => b.count - a.count).map((cell) => ({ lat: cell.lat, lon: cell.lon, count: cell.count, ...(values ? { sum: cell.sum } : {}) }))
}

export function geoDbscan(points: Point[], epsKm: number, minPoints: number): { labels: number[]; clusters: Array<{ id: number; size: number; centroid: Point; radiusKm: number }>; noise: number } {
  if (points.length > 20_000) throw new Error('geographic DBSCAN here is O(n²); sample to at most 20,000 points')
  const labels = new Array<number>(points.length).fill(-2)
  let cluster = -1
  const neighbours = (i: number) => points.map((p, j) => (haversineKm(points[i]!, p) <= epsKm ? j : -1)).filter((j) => j >= 0)
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -2) continue
    const seeds = neighbours(i)
    if (seeds.length < minPoints) { labels[i] = -1; continue }
    cluster++
    labels[i] = cluster
    const queue = [...seeds]
    while (queue.length) {
      const j = queue.pop()!
      if (labels[j] === -1) labels[j] = cluster
      if (labels[j] !== -2) continue
      labels[j] = cluster
      const more = neighbours(j)
      if (more.length >= minPoints) queue.push(...more)
    }
  }
  const clusters = Array.from({ length: cluster + 1 }, (_, id) => {
    const members = points.filter((_, i) => labels[i] === id)
    const centroid = { lat: mean(members.map((p) => p.lat)), lon: mean(members.map((p) => p.lon)) }
    return { id, size: members.length, centroid, radiusKm: Math.max(...members.map((p) => haversineKm(p, centroid))) }
  })
  return { labels, clusters, noise: labels.filter((label) => label === -1).length }
}

type Ring = Array<[number, number]>

function inRing(point: Point, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if ((yi > point.lat) !== (yj > point.lat) && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(point: Point, polygon: Ring[]): boolean {
  if (!polygon.length || !inRing(point, polygon[0]!)) return false
  return !polygon.slice(1).some((hole) => inRing(point, hole))
}

/** Assigns each point the properties of the GeoJSON (Multi)Polygon feature containing it. */
export function spatialJoin(points: Point[], geojson: unknown, property: string): Array<string | null> {
  const collection = geojson as { type?: string; features?: Array<{ properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }> }
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('spatial join needs a GeoJSON FeatureCollection')
  const shapes = collection.features.flatMap((feature) => {
    const geometry = feature.geometry
    if (!geometry) return []
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as Ring[]] : geometry.type === 'MultiPolygon' ? (geometry.coordinates as Ring[][]) : []
    const ringPoints = polygons.flat(2) as Array<[number, number]>
    if (!ringPoints.length) return []
    const bbox = { minLon: Math.min(...ringPoints.map((p) => p[0])), maxLon: Math.max(...ringPoints.map((p) => p[0])), minLat: Math.min(...ringPoints.map((p) => p[1])), maxLat: Math.max(...ringPoints.map((p) => p[1])) }
    return [{ label: feature.properties?.[property] === undefined ? null : String(feature.properties[property]), polygons, bbox }]
  })
  return points.map((point) => {
    for (const shape of shapes) {
      if (point.lon < shape.bbox.minLon || point.lon > shape.bbox.maxLon || point.lat < shape.bbox.minLat || point.lat > shape.bbox.maxLat) continue
      if (shape.polygons.some((polygon) => inPolygon(point, polygon))) return shape.label
    }
    return null
  })
}

/** p-median facility location: choose `k` of the candidate sites minimising total (weighted) distance, by greedy start plus swaps. */
export function pMedian(demand: Array<Point & { weight?: number }>, candidates: Array<Point & { id: string }>, k: number, seed = 42): { chosen: string[]; totalWeightedKm: number; averageKm: number; assignments: number[] } {
  if (k < 1 || k > candidates.length) throw new Error(`k must be between 1 and the number of candidate sites (${candidates.length})`)
  const distance = demand.map((d) => candidates.map((c) => haversineKm(d, c)))
  const weight = demand.map((d) => d.weight ?? 1)
  const cost = (set: number[]) => distance.reduce((total, row, i) => total + weight[i]! * Math.min(...set.map((c) => row[c]!)), 0)
  let chosen: number[] = []
  for (let step = 0; step < k; step++) {
    let best = -1
    let bestCost = Number.POSITIVE_INFINITY
    for (let c = 0; c < candidates.length; c++) {
      if (chosen.includes(c)) continue
      const value = cost([...chosen, c])
      if (value < bestCost) { bestCost = value; best = c }
    }
    chosen.push(best)
  }
  let current = cost(chosen)
  const rng = createRng(seed)
  let improved = true
  while (improved) {
    improved = false
    for (const position of rng.shuffle(chosen.map((_, i) => i))) {
      for (let c = 0; c < candidates.length; c++) {
        if (chosen.includes(c)) continue
        const trial = chosen.map((value, i) => (i === position ? c : value))
        const value = cost(trial)
        if (value < current - 1e-9) { chosen = trial; current = value; improved = true }
      }
    }
  }
  const assignments = distance.map((row) => chosen.reduce((best, c) => (row[c]! < row[best]! ? c : best), chosen[0]!))
  const totalWeight = weight.reduce((a, b) => a + b, 0)
  return { chosen: chosen.map((c) => candidates[c]!.id), totalWeightedKm: current, averageKm: current / totalWeight, assignments: assignments.map((c) => chosen.indexOf(c)) }
}

/** Global Moran's I with inverse-distance weights within a band, and its normal-approximation p-value. */
export function moransI(points: Point[], values: number[], bandKm: number): { I: number; expected: number; z: number; pValue: number; interpretation: string } {
  const n = points.length
  if (n > 5000) throw new Error("Moran's I here is O(n²); sample to at most 5,000 points")
  const m = mean(values)
  const deviations = values.map((value) => value - m)
  let s0 = 0
  let numerator = 0
  let s1 = 0
  const rowSums = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue
    const d = haversineKm(points[i]!, points[j]!)
    if (d > bandKm) continue
    const w = 1 / Math.max(d, 1e-3)
    s0 += w
    numerator += w * deviations[i]! * deviations[j]!
    s1 += 2 * w * w
    rowSums[i]! += w
  }
  if (s0 === 0) throw new Error(`no point pairs fall within ${bandKm} km; widen the band`)
  const denominator = deviations.reduce((total, d) => total + d * d, 0)
  const I = (n / s0) * (numerator / denominator)
  const expected = -1 / (n - 1)
  const s2 = rowSums.reduce((total, r) => total + (2 * r) ** 2, 0)
  const varianceI = (n * n * s1 - n * s2 + 3 * s0 * s0) / ((n * n - 1) * s0 * s0) - expected * expected
  const z = (I - expected) / Math.sqrt(Math.max(varianceI, 1e-300))
  const pValue = 2 * normalCdf(-Math.abs(z))
  return { I, expected, z, pValue, interpretation: pValue < 0.05 ? (I > expected ? 'nearby locations have similar values (spatial clustering)' : 'nearby locations have dissimilar values (spatial dispersion)') : 'no significant spatial autocorrelation at this band' }
}
