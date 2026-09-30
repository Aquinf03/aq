#!/usr/bin/env node
/** Internal waiter and queue pump. Not a user command. */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2]

try {
  process.on("SIGHUP", () => {})
  process.on("SIGINT", () => {})
} catch {
  /* hangup must not kill a detached job */
}

function alive(pid) {
  if (pid == null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function load(p) {
  return JSON.parse(await readFile(p, "utf8"))
}

async function save(p, spec) {
  const tmp = p + ".tmp"
  await writeFile(tmp, JSON.stringify(spec, null, 2) + "\n", "utf8")
  await rename(tmp, p)
}

async function withLock(jobsDir, fn) {
  const lock = path.join(jobsDir, ".lock")
  const t0 = Date.now()
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" })
      break
    } catch {
      if (existsSync(lock)) {
        const holder = Number((await readFile(lock, "utf8").catch(() => "")).trim())
        if (!alive(holder)) await unlink(lock).catch(() => {})
      }
      if (Date.now() - t0 > 3000) throw new Error("queue lock timeout")
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lock).catch(() => {})
  }
}

async function jobIds(jobsDir) {
  if (!existsSync(jobsDir)) return []
  const entries = await readdir(jobsDir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
}

function askOf(spec) {
  const r = spec.resources ?? {}
  return {
    cpu: r.cpu ?? 1,
    ram: r.ram ?? 0,
    disk: r.disk ?? 0,
    gpu: r.gpu ?? 0,
  }
}

function hostOf(specs) {
  for (const s of specs) {
    if (s.host) return s.host
  }
  return { cpu: 1, ram: 0, disk: 0, gpu: { kind: "none", count: 0 } }
}

function isHuge(ask, host) {
  if (ask.cpu >= host.cpu) return true
  if (host.ram && ask.ram >= host.ram) return true
  if (host.disk && ask.disk >= host.disk) return true
  if (host.gpu && host.gpu.count > 0 && ask.gpu >= host.gpu.count) return true
  return false
}

function fits(ask, used, host) {
  if (used.cpu + ask.cpu > host.cpu) return false
  if (host.ram && ask.ram && used.ram + ask.ram > host.ram) return false
  if (host.disk && ask.disk && used.disk + ask.disk > host.disk) return false
  const gpus = host.gpu?.count ?? 0
  if (used.gpu + ask.gpu > gpus) return false
  return true
}

function addAsk(used, ask) {
  used.cpu += ask.cpu
  used.ram += ask.ram
  used.disk += ask.disk
  used.gpu += ask.gpu
}

async function startJob(item) {
  const child = spawn(process.execPath, [self, item.p], {
    cwd: item.spec.cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  if (child.pid == null) {
    item.spec.status = "error"
    item.spec.ended = new Date().toISOString()
    await save(item.p, item.spec)
    return false
  }
  item.spec.status = "starting"
  item.spec.waiterPid = child.pid
  await save(item.p, item.spec)
  child.unref()
  return true
}

async function dispatch(jobsDir) {
  await withLock(jobsDir, async () => {
    const ids = await jobIds(jobsDir)
    const queued = []
    const active = []
    for (const id of ids) {
      const p = path.join(jobsDir, id, "spec.json")
      if (!existsSync(p)) continue
      const spec = await load(p)
      if (spec.status === "running" && !alive(spec.pid)) {
        spec.status = "exited"
        spec.ended = spec.ended ?? new Date().toISOString()
        await save(p, spec)
      }
      if (spec.status === "starting" && !alive(spec.pid) && !alive(spec.waiterPid ?? null)) {
        spec.status = "error"
        spec.ended = spec.ended ?? new Date().toISOString()
        await save(p, spec)
      }
      if (spec.status === "running" || spec.status === "starting") active.push({ p, spec })
      if (spec.status === "queued") queued.push({ p, spec })
    }
    queued.sort((a, b) => {
      const ta = a.spec.queuedAt ?? a.spec.started ?? ""
      const tb = b.spec.queuedAt ?? b.spec.started ?? ""
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })
    if (!queued.length) return

    const host = hostOf([...active.map((a) => a.spec), ...queued.map((q) => q.spec)])
    const used = { cpu: 0, ram: 0, disk: 0, gpu: 0 }
    for (const a of active) addAsk(used, askOf(a.spec))

    if (active.some((a) => isHuge(askOf(a.spec), host))) return

    const head = askOf(queued[0].spec)
    if (isHuge(head, host)) {
      if (active.length) return
      await startJob(queued[0])
      return
    }

    for (const item of queued) {
      const ask = askOf(item.spec)
      if (isHuge(ask, host)) break
      if (!fits(ask, used, host)) continue
      if (!(await startJob(item))) continue
      addAsk(used, ask)
    }
  })
}

if (mode === "--dispatch") {
  const jobsDir = process.argv[3]
  if (!jobsDir) {
    console.error("job-wait: missing jobs dir")
    process.exit(2)
  }
  await dispatch(jobsDir)
  process.exit(0)
}

const specPath = mode
if (!specPath) {
  console.error("job-wait: missing spec path")
  process.exit(2)
}

const spec = await load(specPath)
const dir = path.dirname(specPath)
const jobsDir = path.dirname(dir)
const logFile = await open(path.join(dir, "log"), "a")
const cmd = spec.command

if (!Array.isArray(cmd) || cmd.length === 0) {
  spec.status = "error"
  spec.ended = new Date().toISOString()
  await save(specPath, spec)
  process.exit(2)
}

function cpuTimeToSec(s) {
  const t = String(s).trim()
  if (!t) return 0
  const dash = t.split("-")
  let rest = t
  let days = 0
  if (dash.length === 2) {
    days = Number(dash[0]) || 0
    rest = dash[1]
  }
  const p = rest.split(":").map(Number)
  if (p.some((n) => Number.isNaN(n))) return 0
  if (p.length === 3) return days * 86400 + p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return days * 86400 + p[0] * 60 + p[1]
  return days * 86400 + p[0]
}

function processTree(rootPid) {
  if (rootPid == null) return { pids: [], rssKb: 0, cpuSec: 0 }
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,time="], {
    encoding: "utf8",
    timeout: 2000,
  })
  if (r.status !== 0) return { pids: [rootPid], rssKb: 0, cpuSec: 0 }
  const procs = []
  const byPpid = new Map()
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/)
    if (!m) continue
    const proc = { pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpuSec: cpuTimeToSec(m[4]) }
    procs.push(proc)
    const list = byPpid.get(proc.ppid)
    if (list) list.push(proc)
    else byPpid.set(proc.ppid, [proc])
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const root = byPid.get(rootPid)
  if (!root) return { pids: [rootPid], rssKb: 0, cpuSec: 0 }
  const pids = []
  let rssKb = 0
  let cpuSec = 0
  const walk = (p) => {
    pids.push(p.pid)
    rssKb += p.rssKb
    cpuSec += p.cpuSec
    for (const k of byPpid.get(p.pid) ?? []) walk(k)
  }
  walk(root)
  return { pids, rssKb, cpuSec }
}

function linuxIo(pids) {
  let readBytes = 0
  let writeBytes = 0
  let any = false
  for (const pid of pids) {
    const f = `/proc/${pid}/io`
    if (!existsSync(f)) continue
    const text = readFileSync(f, "utf8")
    const rb = Number((text.match(/^read_bytes:\s+(\d+)/m) ?? [])[1] ?? 0)
    const wb = Number((text.match(/^write_bytes:\s+(\d+)/m) ?? [])[1] ?? 0)
    readBytes += rb
    writeBytes += wb
    any = true
  }
  return any ? { readBytes, writeBytes } : null
}

function cwdKb(dir) {
  const r = spawnSync("du", ["-sk", dir], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0) return null
  const n = Number((r.stdout ?? "").trim().split(/\s+/)[0])
  return Number.isFinite(n) ? n : null
}

function nvidiaMemMb(pids) {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 2000 },
  )
  if (r.status !== 0) return null
  const set = new Set(pids)
  let mb = 0
  let hit = false
  for (const line of (r.stdout ?? "").split("\n")) {
    const [pid, mem] = line.split(",").map((x) => Number(String(x).trim()))
    if (!set.has(pid) || !Number.isFinite(mem)) continue
    mb += mem
    hit = true
  }
  return hit ? mb : null
}

function sampleOnce(pid) {
  const tree = processTree(pid)
  const io = linuxIo(tree.pids)
  const kind = spec.host?.gpu?.kind ?? "none"
  let gpuMemMb = null
  if (kind === "nvidia") gpuMemMb = nvidiaMemMb(tree.pids)
  return { ...tree, io, gpuMemMb, kind }
}

const wall0 = Date.now()
const disk0 = cwdKb(dir)
const samples = {
  peakRssKb: 0,
  cpuSec: 0,
  gpuMemMbPeak: null,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  io: false,
}

function accumulate(pid) {
  if (pid == null) return
  const s = sampleOnce(pid)
  samples.peakRssKb = Math.max(samples.peakRssKb, s.rssKb)
  samples.cpuSec = Math.max(samples.cpuSec, s.cpuSec)
  if (s.gpuMemMb != null) {
    samples.gpuMemMbPeak =
      samples.gpuMemMbPeak == null ? s.gpuMemMb : Math.max(samples.gpuMemMbPeak, s.gpuMemMb)
  }
  if (s.io) {
    samples.io = true
    samples.ioReadBytes = Math.max(samples.ioReadBytes, s.io.readBytes)
    samples.ioWriteBytes = Math.max(samples.ioWriteBytes, s.io.writeBytes)
  }
}

async function writeAccount() {
  accumulate(spec.pid)
  const disk1 = cwdKb(dir)
  const account = {
    wallMs: Date.now() - wall0,
    cpu: { sec: samples.cpuSec },
    ram: { peakRssKb: samples.peakRssKb },
    gpu: {
      kind: spec.host?.gpu?.kind ?? "none",
      peakMemMb: samples.gpuMemMbPeak,
    },
    disk: {
      cwdDeltaKb: disk0 != null && disk1 != null ? disk1 - disk0 : null,
      readBytes: samples.io ? samples.ioReadBytes : null,
      writeBytes: samples.io ? samples.ioWriteBytes : null,
    },
    network: { rxBytes: null, txBytes: null },
  }
  await writeFile(path.join(dir, "account.json"), JSON.stringify(account, null, 2) + "\n", "utf8")
}

let done = false
async function finish(status, code, signal) {
  if (done) return
  done = true
  clearInterval(sampler)
  spec.status = status
  spec.code = code
  spec.signal = signal
  spec.ended = new Date().toISOString()
  await save(specPath, spec)
  await writeAccount().catch(() => {})
}

function bindEnv(spec) {
  const env = { ...process.env }
  const res = spec.resources ?? {}
  const kind = spec.host?.gpu?.kind ?? "none"
  if (res.cpu != null) {
    const n = String(res.cpu)
    env.OMP_NUM_THREADS = n
    env.MKL_NUM_THREADS = n
    env.OPENBLAS_NUM_THREADS = n
    env.VECLIB_MAXIMUM_THREADS = n
  }
  if (res.gpu === 0) {
    env.CUDA_VISIBLE_DEVICES = "-1"
    env.HIP_VISIBLE_DEVICES = "-1"
    env.ROCR_VISIBLE_DEVICES = "-1"
  } else if (res.gpu > 0) {
    const ids = Array.from({ length: res.gpu }, (_, i) => String(i)).join(",")
    if (kind === "nvidia") env.CUDA_VISIBLE_DEVICES = ids
    if (kind === "amd") {
      env.HIP_VISIBLE_DEVICES = ids
      env.ROCR_VISIBLE_DEVICES = ids
    }
  }
  return env
}

function spawnCmd(spec, cmd, stdio) {
  const env = bindEnv(spec)
  const ram = spec.resources?.ram
  if (ram != null) {
    const kb = Math.max(1, Math.floor(Number(ram) / 1024))
    return spawn(
      "/bin/sh",
      ["-c", 'ulimit -v "$1" 2>/dev/null; shift; exec "$@"', "aq", String(kb), cmd[0], ...cmd.slice(1)],
      { cwd: spec.cwd, env, detached: true, stdio },
    )
  }
  return spawn(cmd[0], cmd.slice(1), { cwd: spec.cwd, env, detached: true, stdio })
}

const child = spawnCmd(spec, cmd, ["ignore", logFile.fd, logFile.fd])

spec.pid = child.pid ?? null
spec.status = "running"
await save(specPath, spec)
accumulate(spec.pid)
const sampler = setInterval(() => accumulate(spec.pid), 250)
sampler.unref()

child.on("error", async (err) => {
  await logFile.write(String(err.message || err) + "\n")
  await finish("error", null, null)
  await dispatch(jobsDir)
  process.exit(1)
})

child.on("exit", async (code, signal) => {
  const status = signal === "SIGTERM" || signal === "SIGINT" ? "canceled" : "exited"
  await finish(status, code, signal)
  await dispatch(jobsDir)
  process.exit(0)
})
