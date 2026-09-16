/** Shared / fractional GPU on multi-GPU SSH boxes via CUDA_VISIBLE_DEVICES. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { SshPlace } from "./places.js"

export type GpuClaim = {
  jobId: string
  place: string
  /** Physical device indices on that place. */
  devices: number[]
  at: string
}

type ClaimsFile = { claims: GpuClaim[] }

function aquinDir(): string {
  const d = path.join(homedir(), ".aquin")
  mkdirSync(d, { recursive: true })
  return d
}

function claimsPath(): string {
  return path.join(aquinDir(), "gpu-claims.json")
}

function loadClaims(): ClaimsFile {
  const p = claimsPath()
  if (!existsSync(p)) return { claims: [] }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ClaimsFile
    return { claims: Array.isArray(raw.claims) ? raw.claims : [] }
  } catch {
    return { claims: [] }
  }
}

function saveClaims(file: ClaimsFile): void {
  writeFileSync(claimsPath(), JSON.stringify(file, null, 2) + "\n", "utf8")
}

/** How many GPUs the place reports (0 if unknown / none). */
export function placeGpuCount(place: SshPlace): number {
  const g = place.resources?.gpu
  if (!g || g.kind === "none") return 0
  return Math.max(0, g.count | 0)
}

/** Device indices currently claimed on a place. */
export function claimedDevices(placeName: string): Set<number> {
  const set = new Set<number>()
  for (const c of loadClaims().claims) {
    if (c.place !== placeName) continue
    for (const d of c.devices) set.add(d)
  }
  return set
}

/** Free physical indices `0 .. count-1` not in claims. */
export function freeDevices(placeName: string, place: SshPlace): number[] {
  const n = placeGpuCount(place)
  if (n < 1) return []
  const taken = claimedDevices(placeName)
  const free: number[] = []
  for (let i = 0; i < n; i++) {
    if (!taken.has(i)) free.push(i)
  }
  return free
}

export function freeGpuCount(placeName: string, place: SshPlace): number {
  return freeDevices(placeName, place).length
}

/**
 * Reserve `n` free GPUs on a place for a job.
 * Throws if not enough free devices (capacity may still be OK — others are busy).
 */
export function allocateGpus(
  jobId: string,
  placeName: string,
  place: SshPlace,
  n: number,
  explicit?: number[],
): number[] {
  if (n < 1 && !explicit?.length) return []
  let devices: number[]
  if (explicit?.length) {
    devices = [...explicit]
    const taken = claimedDevices(placeName)
    for (const d of devices) {
      if (taken.has(d)) {
        throw new Error(
          `GPU ${d} already claimed on ${placeName}\n  tip  aq jobs list · wait or --devices with free ids`,
        )
      }
    }
  } else {
    const free = freeDevices(placeName, place)
    if (free.length < n) {
      throw new Error(
        `${placeName}: need ${n} free GPU(s), have ${free.length} free / ${placeGpuCount(place)} total\n  tip  aq places · pick another box or wait`,
      )
    }
    devices = free.slice(0, n)
  }
  const file = loadClaims()
  // drop prior claim for this job+place
  file.claims = file.claims.filter((c) => !(c.jobId === jobId && c.place === placeName))
  file.claims.push({
    jobId,
    place: placeName,
    devices,
    at: new Date().toISOString(),
  })
  saveClaims(file)
  return devices
}

/** Release all GPU claims for a job (any places). */
export function releaseGpus(jobId: string): void {
  const file = loadClaims()
  const next = file.claims.filter((c) => c.jobId !== jobId)
  if (next.length !== file.claims.length) saveClaims({ claims: next })
}

/** Parse `--devices 0,2` or `0-1`. */
export function parseDevices(spec: string): number[] {
  const out: number[] = []
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (a > b) throw new Error(`bad --devices range: ${part}`)
      for (let i = a; i <= b; i++) out.push(i)
      continue
    }
    const n = Number(part)
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad --devices: ${spec}`)
    out.push(n)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

export function cudaVisibleDevices(devices: number[]): string {
  return devices.join(",")
}

/** Short status for places list: `gpu 2/8 free`. */
export function fmtGpuShare(placeName: string, place: SshPlace): string {
  const total = placeGpuCount(place)
  if (total < 1) return ""
  const free = freeGpuCount(placeName, place)
  return `${free}/${total}gpu free`
}
