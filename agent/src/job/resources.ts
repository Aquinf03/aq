import { spawnSync } from "node:child_process"
import { existsSync, statfsSync } from "node:fs"
import { arch, cpus, platform, totalmem } from "node:os"

export type GpuKind = "nvidia" | "amd" | "mps" | "none"

export type HostResources = {
  cpu: number
  ram: number
  disk: number
  gpu: { kind: GpuKind; count: number }
}

export type ResourceAsk = {
  cpu?: number
  ram?: number
  disk?: number
  gpu?: number
}

function cmdOut(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 2500,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (r.error || r.status !== 0) return null
  return r.stdout ?? null
}

function nvidiaCount(): number {
  const out = cmdOut("nvidia-smi", ["-L"])
  if (out) {
    const n = out
      .split("\n")
      .filter((l) => /^GPU\s+\d+:/.test(l.trim()) || /^GPU \d+:/.test(l))
      .length
    if (n) return n
  }
  let n = 0
  while (existsSync(`/dev/nvidia${n}`)) n++
  return n
}

function amdCount(): number {
  const out = cmdOut("rocm-smi", ["--showid"])
  if (out) {
    const ids = out.match(/GPU\[\d+\]/g)
    if (ids?.length) return new Set(ids).size
  }
  if (existsSync("/dev/kfd")) return 1
  return 0
}

function detectGpu(): { kind: GpuKind; count: number } {
  const nvidia = nvidiaCount()
  if (nvidia > 0) return { kind: "nvidia", count: nvidia }
  const amd = amdCount()
  if (amd > 0) return { kind: "amd", count: amd }
  if (platform() === "darwin" && arch() === "arm64") return { kind: "mps", count: 1 }
  return { kind: "none", count: 0 }
}

function diskFree(dir: string): number {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return 0
  }
}

export function detectHost(dir: string): HostResources {
  return {
    cpu: cpus().length,
    ram: totalmem(),
    disk: diskFree(dir),
    gpu: detectGpu(),
  }
}

export function parseBytes(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmgt])?b?$/i.exec(s.trim())
  if (!m) throw new Error(`bad size: ${s}`)
  const n = Number(m[1])
  const u = (m[2] ?? "").toLowerCase()
  const mul = u === "t" ? 1024 ** 4 : u === "g" ? 1024 ** 3 : u === "m" ? 1024 ** 2 : u === "k" ? 1024 : 1
  return Math.floor(n * mul)
}

export function clampAsk(host: HostResources, ask: ResourceAsk): ResourceAsk {
  if (ask.cpu != null) {
    if (ask.cpu < 1) throw new Error("cpu must be >= 1")
    if (ask.cpu > host.cpu) throw new Error(`cpu ${ask.cpu} > host ${host.cpu}`)
  }
  if (ask.ram != null) {
    if (ask.ram < 1) throw new Error("ram must be > 0")
    if (ask.ram > host.ram) throw new Error(`ram ${ask.ram} > host ${host.ram}`)
  }
  if (ask.disk != null) {
    if (ask.disk < 1) throw new Error("disk must be > 0")
    if (host.disk > 0 && ask.disk > host.disk) throw new Error(`disk ${ask.disk} > free ${host.disk}`)
  }
  if (ask.gpu != null) {
    if (ask.gpu < 0) throw new Error("gpu must be >= 0")
    if (ask.gpu > 0 && host.gpu.kind === "none") throw new Error("no gpu on this machine")
    if (ask.gpu > host.gpu.count) throw new Error(`gpu ${ask.gpu} > host ${host.gpu.count}`)
  }
  return ask
}
