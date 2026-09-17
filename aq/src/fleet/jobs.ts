/** aq jobs — background work on an SSH place (remote jobs/ is source of truth). */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  getPlace,
  loadSession,
  type FleetSession,
  type SshPlace,
} from "./places.js"
import {
  describeGang,
  describePick,
  resolveSshTarget,
  resolveSshTargets,
  type ResolvedSsh,
} from "./pool.js"
import {
  allocateGpus,
  cudaVisibleDevices,
  parseDevices,
  releaseGpus,
} from "./gpu.js"
import {
  forwardUrl,
  openTunnelBg,
  parsePortForward,
  closeTunnelsForJob,
  type PortForward,
} from "./port.js"
import { fmtTags, matchTags, parseTag, type Tags } from "./tags.js"
import {
  formatSshError,
  fmtPlaceTelemetry,
  probeRemoteTelemetry,
  remoteShellPath,
  rsyncFromRemote,
  rsyncToRemote,
  shQuote,
  sshBaseArgs,
  sshCheck,
  sshExec,
  sshTarget,
  type PlaceTelemetry,
} from "./ssh.js"
import { c, step, stepOk } from "./ui.js"

export type RemoteJobStatus = "running" | "exited" | "canceled" | "error" | "unreachable"

export type JobNode = {
  place: string
  remoteDir: string
  rank: number
  pid: number | null
  status?: RemoteJobStatus
  code?: number | null
}

export type RemoteJobSpec = {
  id: string
  place: string
  remoteDir: string
  command: string[]
  pid: number | null
  status: RemoteJobStatus
  code: number | null
  started: string
  ended: string | null
  /** Present when --nodes > 1 */
  nodes?: JobNode[]
  worldSize?: number
  masterAddr?: string
  masterPort?: number
}

type ManagedPolicy = {
  enabled: boolean
  /** same box first, or jump to next pool member. */
  prefer: "same" | "next"
  maxRetries: number
  retries: number
}

type IndexEntry = {
  place: string
  remoteDir: string
  command: string[]
  started: string
  nodes?: JobNode[]
  /** Pool used at submit time (for recover --next). */
  pool?: string
  worldSize?: number
  masterPort?: number
  ports?: PortForward[]
  tags?: Tags
  /** Physical GPU indices claimed (CUDA_VISIBLE_DEVICES). */
  gpuDevices?: number[]
  managed?: ManagedPolicy
}

type JobsIndex = {
  jobs: Record<string, IndexEntry>
}

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function jobsHelp(): string {
  return [
    "aq jobs                     list jobs on last launch place",
    "aq jobs list [--on <place>] [--tag k=v] [--all] [--json]",
    "aq jobs run [--on <place|pool>] [--nodes N] [--gpu N] [--port N] [--json] -- <cmd>…",
    "aq jobs train|eval|serve [--on …] [--nodes N] [--gpu N] [--port N] [--json] [-- <extra>…]",
    "aq jobs status <id> [--json]",
    "aq jobs logs <id> [-n N|-f] [--rank K]",
    "aq jobs pull <id> [dir] [--rank K]",
    "aq jobs down <id>",
    "aq jobs recover <id> [--same|--next|--on place|pool] [--force] [--json]",
    "aq jobs watch [id…] [--poll sec] [--once]",
    "aq jobs manage <id> [--retry N] [--prefer same|next] [--off]",
    "aq jobs sweep [--shard N] [--grid k=a,b] [--on p] [--gpu N] [--json] -- <cmd>…",
    "aq jobs submit …              alias → aq queue push",
    "",
    "--nodes N  (N>1) needs a pool: sync + start the same cmd on N boxes with",
    "           RANK / WORLD_SIZE / MASTER_ADDR / MASTER_PORT set (torchrun-friendly).",
    "--port N   SSH -L tunnel (N or local:remote); sets AQ_PORT/PORT on the job.",
    "--tag k=v  label the job (filter with aq jobs list --tag k=v).",
    "--gpu N    claim N free GPUs on the box (CUDA_VISIBLE_DEVICES; shared multi-GPU).",
    "--devices  pin indices e.g. 0,2 or 0-1 (with or instead of --gpu).",
    "--manage / --retry N   auto-recover after flake (pair with aq jobs watch).",
    "--prefer same|next     managed recover target (default: next if pool).",
    "sweep      fan out many jobs: --shard N and/or --grid lr=1e-3,1e-4",
    "           cmd may use {i} {n} {shard} {shards} and {gridKey} placeholders.",
    "recover    restart same id after host/process death (SSH spot/preempt pattern).",
    "watch      poll managed jobs and recover on unreachable / failed exit.",
    "Jobs live under <remoteDir>/jobs/<id>/ on each place.",
  ].join("\n")
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

function indexPath(): string {
  return path.join(homedir(), ".aquin", "fleet-jobs.json")
}

function loadIndex(): JobsIndex {
  const p = indexPath()
  if (!existsSync(p)) return { jobs: {} }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as JobsIndex
    if (!raw?.jobs || typeof raw.jobs !== "object") return { jobs: {} }
    return { jobs: raw.jobs }
  } catch {
    return { jobs: {} }
  }
}

export { loadIndex }

function saveIndex(idx: JobsIndex): void {
  mkdirSync(path.dirname(indexPath()), { recursive: true })
  writeFileSync(indexPath(), JSON.stringify(idx, null, 2) + "\n", "utf8")
}

export function setJobTags(id: string, tags: Tags): void {
  const idx = loadIndex()
  if (!idx.jobs[id]) throw tip(`no local job record: ${id}`, "aq jobs list")
  idx.jobs[id] = { ...idx.jobs[id], tags }
  saveIndex(idx)
}

function rememberJob(
  spec: RemoteJobSpec,
  pool?: string,
  ports?: PortForward[],
  tags?: Tags,
  gpuDevices?: number[],
): void {
  const idx = loadIndex()
  const prev = idx.jobs[spec.id]
  idx.jobs[spec.id] = {
    place: spec.place,
    remoteDir: spec.remoteDir,
    command: spec.command,
    started: spec.started,
    nodes: spec.nodes,
    pool: pool ?? prev?.pool,
    worldSize: spec.worldSize ?? prev?.worldSize,
    masterPort: spec.masterPort ?? prev?.masterPort,
    ports: ports ?? prev?.ports,
    tags: tags ?? prev?.tags,
    gpuDevices: gpuDevices ?? prev?.gpuDevices,
    managed: prev?.managed,
  }
  saveIndex(idx)
}

export function setJobManaged(id: string, managed: ManagedPolicy | undefined): void {
  const idx = loadIndex()
  if (!idx.jobs[id]) throw tip(`no local job record: ${id}`, "aq jobs list")
  idx.jobs[id] = { ...idx.jobs[id], managed }
  saveIndex(idx)
}

export function fleetDefaultRemoteDir(session: FleetSession | null): string {
  return `~/aq-runs/${path.basename(session?.train || process.cwd())}`
}

function defaultRemoteDir(session: FleetSession | null): string {
  return fleetDefaultRemoteDir(session)
}

/** Start one background process on a place; returns pid. */
export function startOnNode(opts: {
  place: SshPlace
  placeName: string
  remoteDir: string
  id: string
  command: string[]
  env: Record<string, string>
  spec: RemoteJobSpec
}): number | null {
  const { place, remoteDir, id, command, env, spec } = opts
  const dir = remoteJobDir(remoteDir, id)
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
    .join("\n")
  const runLine = command.map(shQuote).join(" ")
  const runSh = [
    "#!/bin/bash",
    "set +e",
    `cd ${remoteShellPath(remoteDir)} || exit 90`,
    'export PATH="$HOME/.aquin/bin:$PATH"',
    exports,
    runLine,
    `echo $? > ${remoteShellPath(dir + "/code")}`,
  ].join("\n")
  const specJson = JSON.stringify(spec, null, 2) + "\n"
  const updatePy = `
import json,sys
p,pid=sys.argv[1],int(sys.argv[2])
s=json.load(open(p)); s["pid"]=pid; s["status"]="running"
json.dump(s, open(p,"w"), indent=2); open(p,"a").write("\\n")
print(pid)
`.trim()
  const script = [
    `set -e`,
    `RD=${remoteShellPath(remoteDir)}`,
    `JD=${remoteShellPath(dir)}`,
    `mkdir -p "$RD" "$JD"`,
    `echo ${shQuote(b64(runSh))} | base64 -d > "$JD/run.sh"`,
    `chmod +x "$JD/run.sh"`,
    `echo ${shQuote(b64(specJson))} | base64 -d > "$JD/spec.json"`,
    `cd "$RD"`,
    `nohup bash "$JD/run.sh" > "$JD/log" 2>&1 &`,
    `echo $! > "$JD/pid"`,
    `PID=$(cat "$JD/pid")`,
    `if command -v python3 >/dev/null 2>&1; then`,
    `  echo ${shQuote(b64(updatePy))} | base64 -d | python3 - "$JD/spec.json" "$PID"`,
    `else`,
    `  echo "$PID"`,
    `fi`,
  ].join("\n")
  const r = sshExec(place, script, { timeoutMs: 30_000 })
  if (r.status !== 0) {
    throw tip(
      `failed on ${opts.placeName}: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "ssh error"}`,
      "aq places · aq launch --on " + opts.placeName,
    )
  }
  const pid = Number((r.stdout || "").trim().split("\n").pop())
  return Number.isFinite(pid) ? pid : null
}

function resolveContext(
  onFlag: string | undefined,
  ask: { gpu?: number } = {},
): {
  placeName: string
  place: SshPlace
  remoteDir: string
  session: FleetSession | null
  requested: string
  viaPool?: string
} {
  const session = loadSession()
  const requested = onFlag || session?.place
  if (!requested) {
    throw tip("no place", "aq launch --on <place> first · or pass --on <place>")
  }
  const resolved = resolveSshTarget(requested, ask)
  const remoteDir =
    (session?.member === resolved.name || session?.place === resolved.name) &&
    session.remoteDir
      ? session.remoteDir
      : defaultRemoteDir(session)
  return {
    placeName: resolved.name,
    place: resolved.place,
    remoteDir,
    session,
    requested: resolved.requested,
    viaPool: resolved.viaPool,
  }
}

function lookupJob(
  id: string,
  onFlag?: string,
): { placeName: string; place: SshPlace; remoteDir: string } {
  const idx = loadIndex().jobs[id]
  if (idx) {
    const p = getPlace(idx.place)
    if (p.kind !== "ssh") throw tip(`place ${idx.place} is ${p.kind}`, "only ssh")
    return { placeName: idx.place, place: p, remoteDir: idx.remoteDir }
  }
  const ctx = resolveContext(onFlag)
  return { placeName: ctx.placeName, place: ctx.place, remoteDir: ctx.remoteDir }
}

function remoteJobDir(remoteDir: string, id: string): string {
  return `${remoteDir.replace(/\/$/, "")}/jobs/${id}`
}

export function newJobId(): string {
  return randomBytes(4).toString("hex")
}

function newId(): string {
  return newJobId()
}

/**
 * Start a job on an already-resolved gang (used by `aq jobs run` and queue workers).
 * Preserves `id` when provided (recover / queue claim).
 */
export async function startRemoteJob(opts: {
  id?: string
  gang: ResolvedSsh[]
  remoteDir: string
  command: string[]
  masterPort?: number
  pool?: string
  quiet?: boolean
  syncTrain?: string | null
  extraEnv?: Record<string, string>
  ports?: PortForward[]
  tags?: Tags
  /** Request N free GPUs per place (shared multi-GPU box). */
  gpu?: number
  /** Explicit device indices (optional; applies per place / rank 0 pinning). */
  devices?: number[]
}): Promise<RemoteJobSpec> {
  const {
    gang,
    remoteDir,
    command: cmd,
    masterPort = 29500,
    quiet,
    syncTrain,
    extraEnv,
    ports,
    tags,
    gpu,
    devices: explicitDevices,
  } = opts
  if (!gang.length) throw tip("no targets", "aq places")
  const id = opts.id || newId()
  // Fresh allocation for this id
  releaseGpus(id)
  const started = new Date().toISOString()
  const masterAddr = gang[0].place.host
  const worldSize = gang.length
  const pool = opts.pool || gang[0].viaPool
  const needGpu = gpu != null && gpu > 0 ? gpu : explicitDevices?.length ? explicitDevices.length : 0

  if (!quiet) {
    if (worldSize > 1) console.log(c.dim("nodes") + "  " + describeGang(gang))
    else if (gang[0].viaPool) console.log(c.dim("pool") + "  " + describePick(gang[0]))
    step("jobs", "start  " + cmd.join(" ") + (worldSize > 1 ? c.dim(`  ×${worldSize}`) : ""))
  }

  if (syncTrain && existsSync(syncTrain)) {
    for (const g of gang) {
      if (!quiet) step("sync", g.name)
      await rsyncToRemote(syncTrain, g.place, remoteDir, "defaults")
    }
  }

  const nodeSpecs: JobNode[] = []
  let headDevices: number[] | undefined
  try {
    for (let rank = 0; rank < gang.length; rank++) {
      const g = gang[rank]
      const env: Record<string, string> = {
        RANK: String(rank),
        LOCAL_RANK: "0",
        WORLD_SIZE: String(worldSize),
        MASTER_ADDR: masterAddr,
        MASTER_PORT: String(masterPort),
        AQ_RANK: String(rank),
        AQ_WORLD_SIZE: String(worldSize),
        AQ_MASTER_ADDR: masterAddr,
        AQ_MASTER_PORT: String(masterPort),
        ...(extraEnv || {}),
      }
      if (ports?.length) {
        env.AQ_PORT = String(ports[0].remote)
        env.PORT = String(ports[0].remote)
      }
      if (needGpu > 0 || explicitDevices?.length) {
        const n = explicitDevices?.length ? explicitDevices.length : needGpu
        const pinned = rank === 0 ? explicitDevices : undefined
        const devs = allocateGpus(id, g.name, g.place, n, pinned)
        if (rank === 0) headDevices = devs
        const vis = cudaVisibleDevices(devs)
        env.CUDA_VISIBLE_DEVICES = vis
        env.AQ_CUDA_VISIBLE_DEVICES = vis
        env.AQ_GPU_DEVICES = vis
        if (!quiet) {
          console.log(c.dim("  gpu") + "   " + g.name + "  devices " + vis)
        }
      }
      const baseSpec: RemoteJobSpec = {
        id,
        place: g.name,
        remoteDir,
        command: cmd,
        pid: null,
        status: "running",
        code: null,
        started,
        ended: null,
        worldSize,
        masterAddr,
        masterPort,
      }
      const pid = startOnNode({
        place: g.place,
        placeName: g.name,
        remoteDir,
        id,
        command: cmd,
        env,
        spec: {
          ...baseSpec,
          nodes: gang.map((x, ri) => ({
            place: x.name,
            remoteDir,
            rank: ri,
            pid: null,
          })),
        },
      })
      nodeSpecs.push({ place: g.name, remoteDir, rank, pid })
    }
  } catch (e) {
    releaseGpus(id)
    throw e
  }

  const head = gang[0]
  const spec: RemoteJobSpec = {
    id,
    place: head.name,
    remoteDir,
    command: cmd,
    pid: nodeSpecs[0]?.pid ?? null,
    status: "running",
    code: null,
    started,
    ended: null,
    nodes: worldSize > 1 ? nodeSpecs : undefined,
    worldSize: worldSize > 1 ? worldSize : undefined,
    masterAddr: worldSize > 1 ? masterAddr : undefined,
    masterPort: worldSize > 1 ? masterPort : undefined,
  }
  rememberJob(spec, pool, ports, tags, headDevices)

  // Open laptop→place tunnels in the background
  if (ports?.length) {
    for (const fw of ports) {
      try {
        openTunnelBg(head.place, head.name, fw, { jobId: id, quiet })
        if (!quiet) {
          console.log(c.dim("  open") + "  " + forwardUrl(fw) + c.dim("  (aq port down " + fw.local + ")"))
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!quiet) console.log(c.yellow("port") + "  tunnel failed: " + msg.split("\n")[0])
      }
    }
  }

  return spec
}

function parseSpec(raw: string): RemoteJobSpec | null {
  try {
    const s = JSON.parse(raw) as RemoteJobSpec
    if (!s?.id) return null
    return s
  } catch {
    return null
  }
}

function lastJsonObject(out: string): string {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
  return lines[lines.length - 1] || out.trim()
}

/** Read + refresh remote spec (pid alive / exit code). */
function refreshRemote(place: SshPlace, remoteDir: string, id: string): RemoteJobSpec {
  const dir = remoteJobDir(remoteDir, id)
  const py = `
import json, os, sys
from datetime import datetime, timezone
jd = sys.argv[1]
sp = os.path.join(jd, "spec.json")
if not os.path.isfile(sp):
    print("NOJOB"); sys.exit(0)
s = json.load(open(sp))
pid_path = os.path.join(jd, "pid")
code_path = os.path.join(jd, "code")
pid = None
if os.path.isfile(pid_path):
    try: pid = int(open(pid_path).read().strip())
    except Exception: pid = None
code = None
if os.path.isfile(code_path):
    try: code = int(open(code_path).read().strip())
    except Exception: code = None
alive = False
if pid is not None:
    try:
        os.kill(pid, 0)
        alive = True
    except Exception:
        alive = False
st = s.get("status") or "running"
if alive:
    s["status"] = "running"
    s["ended"] = None
elif st == "canceled":
    s["status"] = "canceled"
    if not s.get("ended"):
        s["ended"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
else:
    s["status"] = "exited"
    if code is not None: s["code"] = code
    if not s.get("ended"):
        s["ended"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
s["pid"] = pid
json.dump(s, open(sp, "w"), indent=2)
open(sp, "a").write("\\n")
print(json.dumps(s))
`.trim()

  const script = [
    `JD=${remoteShellPath(dir)}`,
    `if [ ! -f "$JD/spec.json" ]; then echo NOJOB; exit 0; fi`,
    `if command -v python3 >/dev/null 2>&1; then`,
    `  echo ${shQuote(b64(py))} | base64 -d | python3 - "$JD"`,
    `else`,
    `  cat "$JD/spec.json"`,
    `fi`,
  ].join("\n")

  const r = sshExec(place, script)
  const out = (r.stdout || "").trim()
  if (r.status !== 0 && (!out || out === "NOJOB")) {
    const err = ((r.stderr || r.stdout || "") as string).trim()
    throw tip(
      `unreachable (${formatSshError(err, place)})`,
      "aq jobs recover " + id,
    )
  }
  if (!out || out === "NOJOB") throw tip(`no such job: ${id}`, "aq jobs list")
  const spec = parseSpec(lastJsonObject(out))
  if (!spec) throw tip(`bad job spec for ${id}`, "aq jobs list")
  return spec
}

function listRemoteIds(place: SshPlace, remoteDir: string): string[] {
  const r = sshExec(
    place,
    `ls -1 ${remoteShellPath(remoteDir + "/jobs")} 2>/dev/null || true`,
  )
  return (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^[a-f0-9]{8}$/i.test(s))
}

/** Cancel remote jobs for a place + remoteDir (used by `aq shutdown`). */
export function cancelJobsOnPlace(
  place: SshPlace,
  placeName: string,
  remoteDir: string,
): string[] {
  const fromRemote = listRemoteIds(place, remoteDir)
  const fromIdx = Object.entries(loadIndex().jobs)
    .filter(
      ([, j]) =>
        j.place === placeName ||
        j.nodes?.some((n) => n.place === placeName) ||
        j.remoteDir === remoteDir,
    )
    .map(([id]) => id)
  const ids = [...new Set([...fromRemote, ...fromIdx])]
  const killed: string[] = []
  for (const id of ids) {
    try {
      const meta = loadIndex().jobs[id]
      const nodes = meta?.nodes
      if (nodes && nodes.length > 1) {
        for (const n of nodes) {
          const p = getPlace(n.place)
          if (p.kind !== "ssh") continue
          killRemoteJob(p, n.remoteDir || remoteDir, id)
        }
      } else {
        killRemoteJob(place, meta?.remoteDir || remoteDir, id)
      }
      releaseGpus(id)
      killed.push(id)
    } catch {
      /* best-effort */
    }
  }
  return killed
}

function statusColor(st: string): string {
  if (st === "running") return c.green(st)
  if (st === "canceled") return c.yellow(st)
  if (st === "error" || st === "unreachable") return c.red(st)
  return c.dim(st)
}

function printJob(spec: RemoteJobSpec, tags?: Tags): void {
  const cmd = spec.command.join(" ")
  const gang =
    spec.nodes && spec.nodes.length > 1 ? c.dim(`  ×${spec.nodes.length}`) : ""
  const tagTxt = tags && Object.keys(tags).length ? c.dim("  " + fmtTags(tags)) : ""
  console.log(
    "  " +
      c.cyan(spec.id) +
      "  " +
      statusColor(spec.status) +
      (spec.code != null ? c.dim(` exit ${spec.code}`) : "") +
      gang +
      tagTxt +
      "  " +
      c.dim(cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd),
  )
}

function telemetryLine(_placeName: string, place: SshPlace): string {
  const tel = probeRemoteTelemetry(place)
  if (!tel) return c.dim("  load  ?")
  return c.dim("  " + fmtPlaceTelemetry(tel))
}

function indexNodes(id: string): JobNode[] | undefined {
  return loadIndex().jobs[id]?.nodes
}

async function jobsRun(argv: string[]): Promise<string> {
  let on: string | undefined
  let jsonOut = false
  let gpuAsk: number | undefined
  let nodes = 1
  let masterPort = 29500
  const ports: PortForward[] = []
  const tagNeed: Tags = {}
  let devices: number[] | undefined
  let manage = false
  let maxRetries = 3
  let prefer: "same" | "next" | undefined
  let i = 0
  const cmd: string[] = []
  let sawDash = false
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      sawDash = true
      cmd.push(...argv.slice(i + 1))
      break
    }
    if (a === "--on") {
      on = argv[i + 1]
      if (!on) throw tip("need place after --on", "aq places")
      i += 2
      continue
    }
    if (a === "--json") {
      jsonOut = true
      i += 1
      continue
    }
    if (a === "--gpu" || a === "--gpus") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 0) throw tip("need a number after --gpu", "aq jobs run --gpu 1 -- …")
      gpuAsk = v
      i += 2
      continue
    }
    if (a === "--devices") {
      const v = argv[i + 1]
      if (!v) throw tip("need list after --devices", "aq jobs run --devices 0,1 -- …")
      try {
        devices = parseDevices(v)
      } catch (e) {
        throw tip(e instanceof Error ? e.message : String(e), "aq jobs run --devices 0,2")
      }
      i += 2
      continue
    }
    if (a === "--nodes") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 1) throw tip("need N >= 1 after --nodes", "aq jobs run --nodes 2 --on pool -- …")
      nodes = v
      i += 2
      continue
    }
    if (a === "--master-port") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 1) throw tip("bad --master-port", "aq jobs run --master-port 29500")
      masterPort = v
      i += 2
      continue
    }
    if (a === "--port") {
      const v = argv[i + 1]
      if (!v) throw tip("need N after --port", "aq jobs run --port 8000 -- …")
      ports.push(parsePortForward(v))
      i += 2
      continue
    }
    if (a === "--tag") {
      const v = argv[i + 1]
      if (!v) throw tip("need key=val after --tag", "aq jobs run --tag exp=x -- …")
      const { key, value } = parseTag(v)
      tagNeed[key] = value
      i += 2
      continue
    }
    if (a === "--manage") {
      manage = true
      i += 1
      continue
    }
    if (a === "--retry") {
      manage = true
      maxRetries = Number(argv[i + 1])
      if (!Number.isFinite(maxRetries) || maxRetries < 0) {
        throw tip("need N >= 0 after --retry", "aq jobs run --retry 3 -- …")
      }
      i += 2
      continue
    }
    if (a === "--prefer") {
      const v = argv[i + 1]
      if (v !== "same" && v !== "next") throw tip("prefer same|next", "aq jobs run --prefer next")
      prefer = v
      manage = true
      i += 2
      continue
    }
    throw tip(`unknown flag: ${a}`, "aq jobs run --on <place|pool> [--manage] -- <cmd>")
  }
  if (!sawDash || !cmd.length) {
    throw tip("need a command after --", "aq jobs run --on temp -- sleep 30")
  }

  const session = loadSession()
  const requested = on || session?.place
  if (!requested) throw tip("no place", "aq launch --on <place> · or --on")

  const ask = { gpu: gpuAsk }
  const gang = resolveSshTargets(requested, ask, nodes)
  const remoteDir = session?.remoteDir || defaultRemoteDir(session)
  const spec = await startRemoteJob({
    gang,
    remoteDir,
    command: cmd,
    masterPort,
    pool: gang[0].viaPool,
    quiet: jsonOut,
    syncTrain: session?.train,
    ports: ports.length ? ports : undefined,
    tags: Object.keys(tagNeed).length ? tagNeed : undefined,
    gpu: gpuAsk,
    devices,
  })
  const id = spec.id
  const worldSize = spec.worldSize || 1

  if (manage) {
    const pref =
      prefer ||
      (gang[0].viaPool || loadIndex().jobs[id]?.pool ? "next" : "same")
    setJobManaged(id, {
      enabled: true,
      prefer: pref,
      maxRetries,
      retries: 0,
    })
  }

  if (jsonOut) {
    console.log(
      JSON.stringify({
        id,
        place: spec.place,
        pool: gang[0].viaPool,
        nodes: spec.nodes,
        command: cmd,
        worldSize,
        masterAddr: spec.masterAddr,
        masterPort: spec.masterPort,
        ports,
        urls: ports.map(forwardUrl),
        tags: tagNeed,
        gpu: gpuAsk,
        gpuDevices: loadIndex().jobs[id]?.gpuDevices,
        managed: loadIndex().jobs[id]?.managed,
      }),
    )
  } else {
    stepOk(
      "jobs",
      "id  " +
        c.cyan(id) +
        (worldSize > 1 ? c.dim(`  ranks 0..${worldSize - 1}`) : "") +
        (spec.pid != null ? c.dim("  pid " + spec.pid) : "") +
        (manage ? c.dim("  managed") : ""),
    )
    console.log(
      c.dim("next") +
        "  aq jobs logs " +
        id +
        " · aq jobs status " +
        id +
        (manage ? " · aq jobs watch " + id : ""),
    )
  }
  return id
}

async function jobsVerb(verb: "train" | "eval" | "serve", argv: string[]): Promise<void> {
  let on: string | undefined
  let jsonOut = false
  let gpuAsk: number | undefined
  let nodes: number | undefined
  let masterPort: number | undefined
  const ports: string[] = []
  const tags: string[] = []
  let devices: string | undefined
  let manageFlags: string[] = []
  const extra: string[] = []
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      extra.push(...argv.slice(i + 1))
      break
    }
    if (a === "--on") {
      on = argv[i + 1]
      if (!on) throw tip("need place after --on", "aq places")
      i += 2
      continue
    }
    if (a === "--json") {
      jsonOut = true
      i += 1
      continue
    }
    if (a === "--gpu" || a === "--gpus") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 0) throw tip("need a number after --gpu", `aq jobs ${verb} --gpu 1`)
      gpuAsk = v
      i += 2
      continue
    }
    if (a === "--devices") {
      devices = argv[i + 1]
      i += 2
      continue
    }
    if (a === "--manage") {
      manageFlags.push("--manage")
      i += 1
      continue
    }
    if (a === "--retry") {
      manageFlags.push("--retry", argv[i + 1] || "3")
      i += 2
      continue
    }
    if (a === "--prefer") {
      manageFlags.push("--prefer", argv[i + 1] || "next")
      i += 2
      continue
    }
    if (a === "--nodes") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 1) throw tip("need N >= 1 after --nodes", `aq jobs ${verb} --nodes 2`)
      nodes = v
      i += 2
      continue
    }
    if (a === "--master-port") {
      masterPort = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--port") {
      ports.push(argv[i + 1] || "")
      i += 2
      continue
    }
    if (a === "--tag") {
      tags.push(argv[i + 1] || "")
      i += 2
      continue
    }
    if (!a.startsWith("-")) {
      extra.push(a)
      i += 1
      continue
    }
    throw tip(`unknown flag: ${a}`, `aq jobs ${verb} [--manage] [--gpu N]`)
  }
  const cmd = ["aq", verb, ...extra]
  const flags = [
    ...(on ? ["--on", on] : []),
    ...(jsonOut ? ["--json"] : []),
    ...(gpuAsk != null ? ["--gpu", String(gpuAsk)] : []),
    ...(devices ? ["--devices", devices] : []),
    ...manageFlags,
    ...(nodes != null ? ["--nodes", String(nodes)] : []),
    ...(masterPort != null ? ["--master-port", String(masterPort)] : []),
    ...ports.flatMap((p) => ["--port", p]),
    ...tags.flatMap((t) => ["--tag", t]),
    "--",
    ...cmd,
  ]
  await jobsRun(flags)
}

async function jobsList(argv: string[]): Promise<void> {
  let on: string | undefined
  let jsonOut = false
  let all = false
  const filter: Tags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--on") {
      on = argv[++i]
      continue
    }
    if (argv[i] === "--tag") {
      const v = argv[++i]
      if (!v) throw tip("need key=val after --tag", "aq jobs list --tag exp=x")
      const { key, value } = parseTag(v)
      filter[key] = value
      continue
    }
    if (argv[i] === "--json") {
      jsonOut = true
      continue
    }
    if (argv[i] === "--all") {
      all = true
      continue
    }
    if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(jobsHelp())
      return
    }
    throw tip(`unknown flag: ${argv[i]}`, "aq jobs list [--on <place>] [--tag k=v] [--all] [--json]")
  }
  const session = loadSession()
  const requested = on || (!all ? session?.place : undefined)

  type Row = {
    id: string
    place: string
    remoteDir: string
    status: RemoteJobStatus | "missing"
    code: number | null
    command: string[]
    started: string
    ended: string | null
    tags?: Tags
    pool?: string
    managed?: ManagedPolicy
    gpuDevices?: number[]
    worldSize?: number
    detail?: string
  }
  const rows: Row[] = []

  const pushFromSpec = (
    id: string,
    spec: RemoteJobSpec,
    meta?: IndexEntry,
    detail?: string,
  ) => {
    if (Object.keys(filter).length && !matchTags(meta?.tags, filter)) return
    rows.push({
      id,
      place: spec.place,
      remoteDir: spec.remoteDir,
      status: spec.status,
      code: spec.code,
      command: spec.command,
      started: spec.started,
      ended: spec.ended,
      tags: meta?.tags,
      pool: meta?.pool,
      managed: meta?.managed,
      gpuDevices: meta?.gpuDevices,
      worldSize: spec.worldSize ?? meta?.worldSize,
      detail,
    })
  }

  const tryRefresh = (id: string, meta: IndexEntry): void => {
    if (Object.keys(filter).length && !matchTags(meta.tags, filter)) return
    try {
      const p = getPlace(meta.place)
      if (p.kind !== "ssh") {
        rows.push({
          id,
          place: meta.place,
          remoteDir: meta.remoteDir,
          status: "missing",
          code: null,
          command: meta.command,
          started: meta.started,
          ended: null,
          tags: meta.tags,
          pool: meta.pool,
          managed: meta.managed,
          gpuDevices: meta.gpuDevices,
          worldSize: meta.worldSize,
          detail: "not an ssh place",
        })
        return
      }
      const check = sshCheck(p)
      if (!check.ok) {
        rows.push({
          id,
          place: meta.place,
          remoteDir: meta.remoteDir,
          status: "unreachable",
          code: null,
          command: meta.command,
          started: meta.started,
          ended: null,
          tags: meta.tags,
          pool: meta.pool,
          managed: meta.managed,
          gpuDevices: meta.gpuDevices,
          worldSize: meta.worldSize,
          detail: check.detail,
        })
        return
      }
      const spec = refreshRemote(p, meta.remoteDir, id)
      pushFromSpec(id, spec, meta)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      rows.push({
        id,
        place: meta.place,
        remoteDir: meta.remoteDir,
        status: /unreachable/i.test(msg) ? "unreachable" : "missing",
        code: null,
        command: meta.command,
        started: meta.started,
        ended: null,
        tags: meta.tags,
        pool: meta.pool,
        managed: meta.managed,
        gpuDevices: meta.gpuDevices,
        worldSize: meta.worldSize,
        detail: msg.split("\n")[0],
      })
    }
  }

  if (all || !requested) {
    const idx = loadIndex()
    const ids = Object.keys(idx.jobs).sort()
    for (const id of ids) tryRefresh(id, idx.jobs[id])
    if (jsonOut) {
      console.log(JSON.stringify({ jobs: rows, place: null, all: true }))
      return
    }
    if (!rows.length) {
      console.log(c.yellow("no jobs"))
      console.log(c.dim("  tip") + "  aq jobs run --on <place> -- sleep 20")
      return
    }
    console.log(c.bold("jobs") + "  " + c.dim("all"))
    for (const r of rows) {
      printJob(
        {
          id: r.id,
          place: r.place,
          remoteDir: r.remoteDir,
          command: r.command,
          pid: null,
          status: r.status === "missing" ? "error" : r.status,
          code: r.code,
          started: r.started,
          ended: r.ended,
          worldSize: r.worldSize,
        },
        r.tags,
      )
    }
    return
  }

  const target = getPlace(requested)
  const members: { name: string; place: SshPlace; remoteDir: string }[] = []
  if (target.kind === "pool") {
    for (const m of target.members) {
      const p = getPlace(m)
      if (p.kind !== "ssh") continue
      const rd =
        session?.member === m && session.remoteDir
          ? session.remoteDir
          : defaultRemoteDir(session)
      members.push({ name: m, place: p, remoteDir: rd })
    }
    if (!jsonOut) console.log(c.bold("jobs") + "  " + c.cyan(requested) + c.dim("  pool"))
  } else if (target.kind === "ssh") {
    const ctx = resolveContext(requested)
    members.push({ name: ctx.placeName, place: ctx.place, remoteDir: ctx.remoteDir })
    if (!jsonOut) {
      console.log(c.bold("jobs") + "  " + c.cyan(ctx.placeName) + c.dim("  " + ctx.remoteDir))
    }
  } else {
    throw tip(`place ${requested} is ${(target as { kind: string }).kind}`, "aq add ssh")
  }

  let any = false
  const seen = new Set<string>()
  const telCache = new Map<string, string>()
  const loadFor = (name: string, place: SshPlace): string => {
    if (telCache.has(name)) return telCache.get(name)!
    const line = telemetryLine(name, place)
    telCache.set(name, line)
    return line
  }

  for (const m of members) {
    const ids = listRemoteIds(m.place, m.remoteDir)
    const fromIdx = Object.entries(loadIndex().jobs)
      .filter(([, j]) => j.place === m.name || j.nodes?.some((n) => n.place === m.name))
      .map(([id]) => id)
    const allIds = [...new Set([...ids, ...fromIdx])].sort()
    if (!allIds.length) continue
    let section = false
    for (const id of allIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const meta = loadIndex().jobs[id]
      if (Object.keys(filter).length && !matchTags(meta?.tags, filter)) continue
      if (!section) {
        any = true
        section = true
        if (!jsonOut) {
          if (target.kind === "pool") {
            console.log(c.dim("  · " + m.name) + loadFor(m.name, m.place))
          } else {
            console.log(c.dim("  load") + loadFor(m.name, m.place))
          }
        }
      }
      try {
        const rd = meta?.remoteDir || m.remoteDir
        const headPlace = meta?.place ? getPlace(meta.place) : m.place
        const ssh = headPlace.kind === "ssh" ? headPlace : m.place
        const spec = refreshRemote(ssh, rd, id)
        if (jsonOut) pushFromSpec(id, spec, meta)
        else printJob(spec, meta?.tags)
      } catch {
        if (jsonOut) {
          rows.push({
            id,
            place: meta?.place || m.name,
            remoteDir: meta?.remoteDir || m.remoteDir,
            status: "missing",
            code: null,
            command: meta?.command || [],
            started: meta?.started || "",
            ended: null,
            tags: meta?.tags,
            pool: meta?.pool,
            managed: meta?.managed,
            gpuDevices: meta?.gpuDevices,
          })
        } else {
          console.log("  " + c.cyan(id) + "  " + c.red("missing"))
        }
      }
    }
  }
  if (jsonOut) {
    console.log(JSON.stringify({ jobs: rows, place: requested }))
    return
  }
  if (!any) {
    console.log(c.yellow("no jobs"))
    console.log(c.dim("  tip") + "  aq jobs run --on " + requested + " -- sleep 20")
  }
}

async function jobsStatus(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let on: string | undefined
  let jsonOut = false
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--on") on = argv[++i]
    else if (argv[i] === "--json") jsonOut = true
  }
  const { placeName, place, remoteDir } = lookupJob(id, on)
  const check = sshCheck(place)
  if (!check.ok) {
    const payload = {
      id,
      place: placeName,
      remoteDir,
      status: "unreachable" as const,
      detail: check.detail,
      command: loadIndex().jobs[id]?.command,
    }
    if (jsonOut) {
      console.log(JSON.stringify(payload))
      return
    }
    console.log(c.bold("job") + "  " + c.cyan(id))
    console.log(c.dim("  place") + "   " + placeName)
    console.log(c.dim("  status") + "  " + statusColor("unreachable"))
    console.log(c.dim("  detail") + "  " + check.detail)
    console.log(c.dim("  tip") + "     aq jobs recover " + id)
    return
  }

  let spec: RemoteJobSpec
  try {
    spec = refreshRemote(place, remoteDir, id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/unreachable/i.test(msg)) {
      if (jsonOut) {
        console.log(JSON.stringify({ id, place: placeName, status: "unreachable", detail: msg }))
        return
      }
      console.log(c.bold("job") + "  " + c.cyan(id))
      console.log(c.dim("  status") + "  " + statusColor("unreachable"))
      console.log(c.dim("  tip") + "     aq jobs recover " + id)
      return
    }
    throw e
  }
  const nodes = indexNodes(id) || spec.nodes
  if (nodes && nodes.length > 1) {
    const ranks: RemoteJobSpec[] = []
    const nodeViews: JobNode[] = []
    for (const n of nodes) {
      const p = getPlace(n.place)
      if (p.kind !== "ssh") continue
      const nc = sshCheck(p)
      if (!nc.ok) {
        nodeViews.push({ ...n, status: "unreachable", pid: n.pid })
        continue
      }
      try {
        const rs = refreshRemote(p, n.remoteDir || remoteDir, id)
        ranks.push(rs)
        nodeViews.push({
          ...n,
          status: rs.status,
          code: rs.code,
          pid: rs.pid ?? n.pid,
        })
      } catch {
        nodeViews.push({ ...n, status: "error", pid: n.pid })
      }
    }
    const anyRun = nodeViews.some((r) => r.status === "running")
    const anyUnreach = nodeViews.some((r) => r.status === "unreachable")
    const allCanceled = nodeViews.every((r) => r.status === "canceled")
    spec.status = anyRun
      ? "running"
      : anyUnreach
        ? "unreachable"
        : allCanceled
          ? "canceled"
          : "exited"
    spec.nodes = nodeViews
    const telByPlace: Record<string, PlaceTelemetry | null> = {}
    for (const n of nodeViews) {
      if (telByPlace[n.place] !== undefined) continue
      const p = getPlace(n.place)
      telByPlace[n.place] = p.kind === "ssh" && n.status !== "unreachable" ? probeRemoteTelemetry(p) : null
    }
    if (jsonOut) {
      console.log(
        JSON.stringify({
          ...spec,
          ranks,
          telemetry: telByPlace,
          tags: loadIndex().jobs[id]?.tags,
        }),
      )
      return
    }
    console.log(c.bold("job") + "  " + c.cyan(spec.id) + c.dim(`  ×${nodes.length}`))
    console.log(c.dim("  status") + "  " + statusColor(spec.status))
    console.log(c.dim("  cmd") + "     " + spec.command.join(" "))
    if (spec.masterAddr) {
      console.log(c.dim("  master") + "  " + spec.masterAddr + ":" + (spec.masterPort || 29500))
    }
    for (const n of spec.nodes) {
      const tel = telByPlace[n.place]
      const live = tel ? c.dim("  " + fmtPlaceTelemetry(tel)) : ""
      console.log(
        c.dim("  rank " + n.rank) +
          "  " +
          c.cyan(n.place) +
          "  " +
          statusColor(n.status || "?") +
          (n.code != null ? c.dim(` exit ${n.code}`) : "") +
          live,
      )
    }
    if (spec.status === "unreachable") {
      console.log(c.dim("  tip") + "     aq jobs recover " + id)
    }
    return
  }
  const tel = probeRemoteTelemetry(place)
  if (jsonOut) {
    console.log(JSON.stringify({ ...spec, telemetry: tel, tags: loadIndex().jobs[id]?.tags }))
    return
  }
  console.log(c.bold("job") + "  " + c.cyan(spec.id))
  console.log(c.dim("  place") + "   " + placeName)
  if (tel) console.log(c.dim("  load") + "    " + fmtPlaceTelemetry(tel))
  const jobPorts = loadIndex().jobs[id]?.ports
  if (jobPorts?.length) {
    console.log(
      c.dim("  port") +
        "    " +
        jobPorts.map((p) => `${p.local}→${p.remote} ${forwardUrl(p)}`).join("  "),
    )
  }
  const jobTags = loadIndex().jobs[id]?.tags
  if (jobTags && Object.keys(jobTags).length) {
    console.log(c.dim("  tags") + "    " + fmtTags(jobTags))
  }
  const gpus = loadIndex().jobs[id]?.gpuDevices
  if (gpus?.length) {
    console.log(c.dim("  gpu") + "     " + gpus.join(",") + c.dim("  (CUDA_VISIBLE_DEVICES)"))
  }
  console.log(c.dim("  status") + "  " + statusColor(spec.status))
  console.log(c.dim("  cmd") + "     " + spec.command.join(" "))
  if (spec.pid != null) console.log(c.dim("  pid") + "     " + spec.pid)
  if (spec.code != null) console.log(c.dim("  exit") + "    " + spec.code)
  console.log(c.dim("  start") + "   " + spec.started)
  if (spec.ended) console.log(c.dim("  end") + "     " + spec.ended)
  if (spec.status !== "running") {
    console.log(c.dim("  tip") + "     aq jobs recover " + id + "   # restart same id")
  }
}

async function jobsLogs(argv: string[]): Promise<void> {
  let id = ""
  let follow = false
  let lines = 80
  let on: string | undefined
  let rank: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-f" || a === "--follow") {
      follow = true
      continue
    }
    if (a === "-n") {
      lines = Number(argv[++i] || 80)
      continue
    }
    if (a === "--on") {
      on = argv[++i]
      continue
    }
    if (a === "--rank") {
      rank = Number(argv[++i])
      continue
    }
    if (!id && !a.startsWith("-")) {
      id = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs logs <id> [-n 80|-f] [--rank K]")
  }
  if (!id) throw tip("need a job id", "aq jobs list")
  const { remoteDir } = lookupJob(id, on)
  const nodes = indexNodes(id)
  const targets =
    nodes && nodes.length > 1
      ? rank != null
        ? nodes.filter((n) => n.rank === rank)
        : nodes
      : [{ place: lookupJob(id, on).placeName, remoteDir, rank: 0, pid: null }]

  if (nodes && nodes.length > 1 && rank != null && !targets.length) {
    throw tip(`no rank ${rank}`, "aq jobs status " + id)
  }

  for (const t of targets) {
    const p = getPlace(t.place)
    if (p.kind !== "ssh") continue
    const log = remoteJobDir(t.remoteDir || remoteDir, id) + "/log"
    if (targets.length > 1) console.log(c.dim("--- rank " + t.rank + " · " + t.place + " ---"))
    if (follow) {
      if (targets.length > 1) {
        throw tip("follow one rank at a time", "aq jobs logs " + id + " -f --rank 0")
      }
      step("logs", id + "  follow")
      const target = sshTarget(p)
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "ssh",
          [...sshBaseArgs(p), "-t", target, `tail -n ${lines} -f ${remoteShellPath(log)}`],
          { stdio: "inherit" },
        )
        child.on("error", reject)
        child.on("exit", () => resolve())
      })
      return
    }
    const r = sshExec(
      p,
      `tail -n ${lines} ${remoteShellPath(log)} 2>/dev/null || echo '(no log yet)'`,
    )
    process.stdout.write(r.stdout || "")
  }
}

async function jobsPull(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let dest = ""
  let on: string | undefined
  let rank: number | undefined
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--on") {
      on = argv[++i]
      continue
    }
    if (argv[i] === "--rank") {
      rank = Number(argv[++i])
      continue
    }
    if (!dest && !argv[i].startsWith("-")) {
      dest = argv[i]
      continue
    }
  }
  const { place, remoteDir } = lookupJob(id, on)
  const nodes = indexNodes(id)
  const base = path.resolve(dest || path.join("jobs-pull", id))
  if (nodes && nodes.length > 1 && rank == null) {
    for (const n of nodes) {
      const p = getPlace(n.place)
      if (p.kind !== "ssh") continue
      const local = path.join(base, "rank-" + n.rank)
      step("pull", `rank ${n.rank} → ` + local)
      await rsyncFromRemote(p, remoteJobDir(n.remoteDir || remoteDir, id), local)
    }
    stepOk("pull", base)
    return
  }
  let sshPlace = place
  let rd = remoteDir
  if (nodes && rank != null) {
    const n = nodes.find((x) => x.rank === rank)
    if (!n) throw tip(`no rank ${rank}`, "aq jobs status " + id)
    const p = getPlace(n.place)
    if (p.kind !== "ssh") throw tip("bad place", n.place)
    sshPlace = p
    rd = n.remoteDir || remoteDir
  }
  step("pull", remoteJobDir(rd, id) + " → " + base)
  await rsyncFromRemote(sshPlace, remoteJobDir(rd, id), base)
  stepOk("pull", base)
}

function killRemoteJob(place: SshPlace, remoteDir: string, id: string): void {
  const dir = remoteJobDir(remoteDir, id)
  const py = `
import json,sys
from datetime import datetime,timezone
p=sys.argv[1]
s=json.load(open(p))
s["status"]="canceled"
s["ended"]=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(s, open(p,"w"), indent=2)
open(p,"a").write("\\n")
print("ok")
`.trim()
  const script = [
    `JD=${remoteShellPath(dir)}`,
    `PID=$(cat "$JD/pid" 2>/dev/null || true)`,
    `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `  kill "$PID" 2>/dev/null || true`,
    `  sleep 0.4`,
    `  kill -9 "$PID" 2>/dev/null || true`,
    `fi`,
    `if command -v python3 >/dev/null 2>&1 && [ -f "$JD/spec.json" ]; then`,
    `  echo ${shQuote(b64(py))} | base64 -d | python3 - "$JD/spec.json"`,
    `else`,
    `  echo ok`,
    `fi`,
  ].join("\n")
  const r = sshExec(place, script)
  if (r.status !== 0) {
    throw tip(`down failed: ${(r.stderr || r.stdout || "").trim()}`, "aq jobs status " + id)
  }
}

async function jobsDown(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let on: string | undefined
  if (argv[1] === "--on") on = argv[2]
  const { place, remoteDir } = lookupJob(id, on)
  const nodes = indexNodes(id)
  step("down", id)
  if (nodes && nodes.length > 1) {
    for (const n of nodes) {
      const p = getPlace(n.place)
      if (p.kind !== "ssh") continue
      killRemoteJob(p, n.remoteDir || remoteDir, id)
    }
  } else {
    killRemoteJob(place, remoteDir, id)
  }
  closeTunnelsForJob(id)
  releaseGpus(id)
  const m = loadIndex().jobs[id]?.managed
  if (m?.enabled) setJobManaged(id, { ...m, enabled: false })
  stepOk("down", "canceled  " + id)
}

/** Rotate prior log/pid so recover keeps history and reuses the same job id. */
function prepareRecoverDir(place: SshPlace, remoteDir: string, id: string): void {
  const dir = remoteJobDir(remoteDir, id)
  sshExec(
    place,
    [
      `JD=${remoteShellPath(dir)}`,
      `mkdir -p "$JD"`,
      `if [ -f "$JD/log" ]; then mv "$JD/log" "$JD/log.prev.$(date +%s)" 2>/dev/null || true; fi`,
      `rm -f "$JD/pid" "$JD/code"`,
    ].join("\n"),
    { timeoutMs: 15_000 },
  )
}

async function jobsRecover(argv: string[]): Promise<void> {
  let id = ""
  let on: string | undefined
  let same = false
  let next = false
  let force = false
  let jsonOut = false
  let gpuAsk: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--on") {
      on = argv[++i]
      continue
    }
    if (a === "--same") {
      same = true
      continue
    }
    if (a === "--next") {
      next = true
      continue
    }
    if (a === "--force") {
      force = true
      continue
    }
    if (a === "--json") {
      jsonOut = true
      continue
    }
    if (a === "--gpu" || a === "--gpus") {
      gpuAsk = Number(argv[++i])
      continue
    }
    if (a === "-h" || a === "--help") {
      console.log(jobsHelp())
      return
    }
    if (!id && !a.startsWith("-")) {
      id = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs recover <id> [--same|--next|--on pool]")
  }
  if (!id) throw tip("need a job id", "aq jobs recover <id>")
  if (same && next) throw tip("use --same or --next, not both", "aq jobs recover " + id)

  const result = await recoverJob({ id, on, same, next, force, quiet: jsonOut, gpuAsk })
  if (jsonOut) {
    console.log(JSON.stringify(result))
    return
  }
  if (!result.recovered) {
    if (result.status === "running") {
      stepOk("recover", "already running  " + c.cyan(id))
      console.log(c.dim("tip") + "  aq jobs status " + id + " · pass --force to kill+restart")
    }
    return
  }
  stepOk(
    "recover",
    "id  " +
      c.cyan(id) +
      "  on  " +
      c.cyan(result.place || "?") +
      (result.pid != null ? c.dim("  pid " + result.pid) : ""),
  )
  console.log(c.dim("next") + "  aq jobs logs " + id + " · aq jobs status " + id)
}

type RecoverResult = {
  id: string
  recovered: boolean
  place?: string
  pid?: number | null
  status?: string
  reason?: string
}

async function recoverJob(opts: {
  id: string
  on?: string
  same?: boolean
  next?: boolean
  force?: boolean
  quiet?: boolean
  gpuAsk?: number
}): Promise<RecoverResult> {
  const { id, on, same = false, next = false, force = false, quiet = false, gpuAsk } = opts
  const entry = loadIndex().jobs[id]
  if (!entry?.command?.length) {
    throw tip(
      `no local record for ${id} (need command to restart)`,
      "aq jobs run … first · recover uses ~/.aquin/fleet-jobs.json",
    )
  }

  const worldSize = entry.worldSize || entry.nodes?.length || 1
  const masterPort = entry.masterPort || 29500
  const ask = { gpu: gpuAsk }
  const session = loadSession()
  const remoteDir = entry.remoteDir || defaultRemoteDir(session)
  const oldPlaces = entry.nodes?.length
    ? entry.nodes.map((n) => n.place)
    : [entry.place]

  let anyUnreachable = false
  let anyRunning = false
  for (const name of oldPlaces) {
    const p = getPlace(name)
    if (p.kind !== "ssh") continue
    const check = sshCheck(p)
    if (!check.ok) {
      anyUnreachable = true
      continue
    }
    try {
      const spec = refreshRemote(p, remoteDir, id)
      if (spec.status === "running") anyRunning = true
    } catch {
      /* missing remote dir is fine — we'll recreate */
    }
  }

  if (anyRunning && !force) {
    return { id, recovered: false, status: "running", reason: "already running" }
  }

  let poolName = on || entry.pool
  let preferNext = next || anyUnreachable
  if (same) preferNext = false
  if (on) {
    const t = getPlace(on)
    if (t.kind === "ssh") {
      poolName = undefined
      preferNext = false
    } else if (t.kind === "pool") {
      poolName = on
      preferNext = true
    }
  }

  if (preferNext && !poolName && !on) {
    throw tip(
      `place ${entry.place} unreachable and no pool recorded`,
      "aq jobs recover " + id + " --on <pool>   · or --same when the box is back",
    )
  }

  let gang: ReturnType<typeof resolveSshTargets>
  if (on && getPlace(on).kind === "ssh") {
    if (worldSize > 1) {
      throw tip(
        "multi-node recover needs a pool (--on <pool> or recorded pool)",
        "aq jobs recover " + id + " --on <pool>",
      )
    }
    const p = getPlace(on)
    if (p.kind !== "ssh") throw tip("need ssh place", "aq places")
    gang = [{ requested: on, name: on, place: p }]
  } else if (preferNext && poolName) {
    const exclude = next || anyUnreachable ? oldPlaces : []
    try {
      gang = resolveSshTargets(poolName, ask, worldSize, { exclude })
    } catch (e) {
      if (!exclude.length) throw e
      gang = resolveSshTargets(poolName, ask, worldSize)
    }
  } else if (same || !preferNext) {
    gang = oldPlaces.map((name) => {
      const p = getPlace(name)
      if (p.kind !== "ssh") throw tip(`place ${name} is not ssh`, "aq places")
      const check = sshCheck(p)
      if (!check.ok) {
        throw tip(
          `${name} still unreachable (${check.detail})`,
          entry.pool
            ? "aq jobs recover " + id + " --next"
            : "aq jobs recover " + id + " --on <pool>",
        )
      }
      return { requested: name, name, place: p, viaPool: entry.pool }
    })
  } else {
    throw tip("could not resolve recover target", "aq jobs recover " + id + " --on <place|pool>")
  }

  if (force && anyRunning) {
    for (const name of oldPlaces) {
      const p = getPlace(name)
      if (p.kind !== "ssh") continue
      if (!sshCheck(p).ok) continue
      try {
        killRemoteJob(p, remoteDir, id)
      } catch {
        /* ignore */
      }
    }
  }

  if (!quiet) {
    step(
      "recover",
      c.cyan(id) +
        "  " +
        (worldSize > 1 ? describeGang(gang) : describePick(gang[0])) +
        (anyUnreachable ? c.dim("  (was unreachable)") : ""),
    )
  }

  if (session?.train && existsSync(session.train)) {
    for (const g of gang) {
      if (!quiet) step("sync", g.name)
      await rsyncToRemote(session.train, g.place, remoteDir, "defaults")
    }
  }

  const started = new Date().toISOString()
  const masterAddr = gang[0].place.host
  const cmd = entry.command
  const nodeSpecs: JobNode[] = []
  const needGpu = entry.gpuDevices?.length || 0
  releaseGpus(id)
  let headDevices: number[] | undefined

  for (let rank = 0; rank < gang.length; rank++) {
    const g = gang[rank]
    prepareRecoverDir(g.place, remoteDir, id)
    const env: Record<string, string> = {
      RANK: String(rank),
      LOCAL_RANK: "0",
      WORLD_SIZE: String(worldSize),
      MASTER_ADDR: masterAddr,
      MASTER_PORT: String(masterPort),
      AQ_RANK: String(rank),
      AQ_WORLD_SIZE: String(worldSize),
      AQ_MASTER_ADDR: masterAddr,
      AQ_MASTER_PORT: String(masterPort),
      AQ_RECOVERED: "1",
    }
    if (needGpu > 0) {
      const devs = allocateGpus(id, g.name, g.place, needGpu)
      if (rank === 0) headDevices = devs
      const vis = cudaVisibleDevices(devs)
      env.CUDA_VISIBLE_DEVICES = vis
      env.AQ_CUDA_VISIBLE_DEVICES = vis
      env.AQ_GPU_DEVICES = vis
    }
    const baseSpec: RemoteJobSpec = {
      id,
      place: g.name,
      remoteDir,
      command: cmd,
      pid: null,
      status: "running",
      code: null,
      started,
      ended: null,
      worldSize: worldSize > 1 ? worldSize : undefined,
      masterAddr: worldSize > 1 ? masterAddr : undefined,
      masterPort: worldSize > 1 ? masterPort : undefined,
    }
    const pid = startOnNode({
      place: g.place,
      placeName: g.name,
      remoteDir,
      id,
      command: cmd,
      env,
      spec: {
        ...baseSpec,
        nodes:
          worldSize > 1
            ? gang.map((x, ri) => ({
                place: x.name,
                remoteDir,
                rank: ri,
                pid: null,
              }))
            : undefined,
      },
    })
    nodeSpecs.push({ place: g.name, remoteDir, rank, pid })
  }

  const head = gang[0]
  const spec: RemoteJobSpec = {
    id,
    place: head.name,
    remoteDir,
    command: cmd,
    pid: nodeSpecs[0]?.pid ?? null,
    status: "running",
    code: null,
    started,
    ended: null,
    nodes: worldSize > 1 ? nodeSpecs : undefined,
    worldSize: worldSize > 1 ? worldSize : undefined,
    masterAddr: worldSize > 1 ? masterAddr : undefined,
    masterPort: worldSize > 1 ? masterPort : undefined,
  }
  rememberJob(spec, poolName || head.viaPool || entry.pool, entry.ports, entry.tags, headDevices)
  return {
    id,
    recovered: true,
    place: head.name,
    pid: spec.pid,
    status: "running",
  }
}

type ProbeKind = "running" | "ok" | "failed" | "canceled" | "unreachable" | "missing"

function probeJobHealth(id: string): ProbeKind {
  const entry = loadIndex().jobs[id]
  if (!entry) return "missing"
  const places = entry.nodes?.length ? entry.nodes.map((n) => n.place) : [entry.place]
  const remoteDir = entry.remoteDir
  let sawUnreach = false
  let sawRunning = false
  let sawCanceled = false
  let sawFailed = false
  let sawOk = false
  for (const name of places) {
    const p = getPlace(name)
    if (p.kind !== "ssh") continue
    if (!sshCheck(p).ok) {
      sawUnreach = true
      continue
    }
    try {
      const spec = refreshRemote(p, remoteDir, id)
      if (spec.status === "running") sawRunning = true
      else if (spec.status === "canceled") sawCanceled = true
      else if (spec.status === "exited" && spec.code === 0) sawOk = true
      else sawFailed = true
    } catch {
      sawUnreach = true
    }
  }
  if (sawRunning) return "running"
  if (sawUnreach) return "unreachable"
  if (sawCanceled) return "canceled"
  if (sawFailed) return "failed"
  if (sawOk) return "ok"
  return "missing"
}

async function jobsManage(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs manage <id> --retry 3")
  let off = false
  let maxRetries = 3
  let prefer: "same" | "next" | undefined
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--off") {
      off = true
      continue
    }
    if (a === "--retry") {
      maxRetries = Number(argv[++i])
      continue
    }
    if (a === "--prefer") {
      const v = argv[++i]
      if (v !== "same" && v !== "next") throw tip("prefer same|next", "aq jobs manage --prefer next")
      prefer = v
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs manage <id> --retry 3 --prefer next")
  }
  const entry = loadIndex().jobs[id]
  if (!entry) throw tip(`no job ${id}`, "aq jobs list")
  if (off) {
    setJobManaged(id, undefined)
    stepOk("manage", c.cyan(id) + "  off")
    return
  }
  const pref = prefer || (entry.pool ? "next" : "same")
  setJobManaged(id, {
    enabled: true,
    prefer: pref,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 3,
    retries: entry.managed?.retries || 0,
  })
  stepOk("manage", c.cyan(id) + `  retry ${maxRetries}  prefer ${pref}`)
  console.log(c.dim("next") + "  aq jobs watch " + id)
}

async function jobsWatch(argv: string[]): Promise<void> {
  const ids: string[] = []
  let pollSec = 5
  let once = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--poll") {
      pollSec = Number(argv[++i] || 5)
      continue
    }
    if (a === "--once") {
      once = true
      continue
    }
    if (a === "-h" || a === "--help") {
      console.log(jobsHelp())
      return
    }
    if (!a.startsWith("-")) {
      ids.push(a)
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs watch [id…] [--poll 5] [--once]")
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const pickIds = (): string[] => {
    if (ids.length) return ids
    return Object.entries(loadIndex().jobs)
      .filter(([, j]) => j.managed?.enabled)
      .map(([id]) => id)
  }

  let watch = pickIds()
  if (!watch.length) {
    throw tip(
      "no managed jobs to watch",
      "aq jobs run --manage --retry 3 -- … · or aq jobs manage <id> --retry 3",
    )
  }

  step("watch", watch.map((id) => c.cyan(id)).join(" ") + c.dim(`  poll ${pollSec}s`))

  for (;;) {
    watch = pickIds()
    if (!watch.length) {
      stepOk("watch", "done — no managed jobs left")
      return
    }
    let active = 0
    for (const id of watch) {
      const entry = loadIndex().jobs[id]
      const managed = entry?.managed
      if (!managed?.enabled) continue
      const health = probeJobHealth(id)
      if (health === "running") {
        active += 1
        continue
      }
      if (health === "ok") {
        setJobManaged(id, { ...managed, enabled: false })
        stepOk("watch", c.cyan(id) + "  exited 0 — manage off")
        continue
      }
      if (health === "canceled") {
        setJobManaged(id, { ...managed, enabled: false })
        console.log(c.dim("watch") + "  " + c.cyan(id) + "  canceled — manage off")
        continue
      }
      if (managed.retries >= managed.maxRetries) {
        setJobManaged(id, { ...managed, enabled: false })
        console.log(
          c.red("watch") +
            "  " +
            c.cyan(id) +
            "  " +
            health +
            c.dim(`  retries exhausted (${managed.retries}/${managed.maxRetries})`),
        )
        continue
      }
      const preferNext = managed.prefer === "next"
      try {
        step(
          "watch",
          "recover  " +
            c.cyan(id) +
            c.dim(`  ${health}  try ${managed.retries + 1}/${managed.maxRetries}  ${managed.prefer}`),
        )
        const result = await recoverJob({
          id,
          next: preferNext,
          same: !preferNext,
          quiet: false,
          force: health === "failed",
        })
        if (result.recovered) {
          setJobManaged(id, {
            ...managed,
            retries: managed.retries + 1,
            enabled: true,
          })
          active += 1
        } else if (result.status === "running") {
          active += 1
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.log(c.red("watch") + "  " + c.cyan(id) + "  " + msg.split("\n")[0])
        setJobManaged(id, { ...managed, retries: managed.retries + 1 })
      }
    }
    if (once) {
      stepOk("watch", "once pass done")
      return
    }
    if (active === 0 && !pickIds().some((id) => loadIndex().jobs[id]?.managed?.enabled)) {
      stepOk("watch", "idle — all managed jobs settled")
      return
    }
    await sleep(Math.max(1, pollSec) * 1000)
  }
}

/** Cartesian product of grid value lists. */
function cartesian(grids: Record<string, string[]>): Record<string, string>[] {
  const keys = Object.keys(grids)
  if (!keys.length) return [{}]
  let rows: Record<string, string>[] = [{}]
  for (const k of keys) {
    const vals = grids[k]
    const next: Record<string, string>[] = []
    for (const row of rows) {
      for (const v of vals) next.push({ ...row, [k]: v })
    }
    rows = next
  }
  return rows
}

function substCmd(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((arg) =>
    arg.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) =>
      key in vars ? vars[key] : `{${key}}`,
    ),
  )
}

async function jobsSweep(argv: string[]): Promise<void> {
  let on: string | undefined
  let jsonOut = false
  let gpuAsk: number | undefined
  let devices: number[] | undefined
  let shards = 0
  const grids: Record<string, string[]> = {}
  const tagNeed: Tags = {}
  let manage = false
  let maxRetries = 3
  let prefer: "same" | "next" | undefined
  let maxJobs = 64
  let sweepName = ""
  const cmd: string[] = []
  let sawDash = false
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      sawDash = true
      cmd.push(...argv.slice(i + 1))
      break
    }
    if (a === "--on") {
      on = argv[i + 1]
      i += 2
      continue
    }
    if (a === "--json") {
      jsonOut = true
      i += 1
      continue
    }
    if (a === "--gpu" || a === "--gpus") {
      gpuAsk = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--devices") {
      devices = parseDevices(argv[i + 1] || "")
      i += 2
      continue
    }
    if (a === "--shard" || a === "--shards") {
      shards = Number(argv[i + 1])
      if (!Number.isFinite(shards) || shards < 1) {
        throw tip("need N >= 1 after --shard", "aq jobs sweep --shard 8 -- …")
      }
      i += 2
      continue
    }
    if (a === "--grid") {
      const raw = argv[i + 1] || ""
      const eq = raw.indexOf("=")
      if (eq < 1) throw tip("bad --grid", "aq jobs sweep --grid lr=1e-3,1e-4")
      const key = raw.slice(0, eq).trim()
      const vals = raw
        .slice(eq + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (!key || !vals.length) throw tip("bad --grid", "--grid lr=1e-3,1e-4")
      grids[key] = vals
      i += 2
      continue
    }
    if (a === "--tag") {
      const { key, value } = parseTag(argv[i + 1] || "")
      tagNeed[key] = value
      i += 2
      continue
    }
    if (a === "--manage") {
      manage = true
      i += 1
      continue
    }
    if (a === "--retry") {
      manage = true
      maxRetries = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--prefer") {
      const v = argv[i + 1]
      if (v !== "same" && v !== "next") throw tip("prefer same|next", "aq jobs sweep --prefer next")
      prefer = v
      manage = true
      i += 2
      continue
    }
    if (a === "--max") {
      maxJobs = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--name") {
      sweepName = argv[i + 1] || ""
      i += 2
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs sweep --shard 8 --on gpus -- <cmd>")
  }
  if (!sawDash || !cmd.length) {
    throw tip(
      "need a command after --",
      "aq jobs sweep --shard 4 --on gpus -- aq train --shard {i}/{n}",
    )
  }
  if (shards < 1 && !Object.keys(grids).length) {
    throw tip(
      "need --shard N and/or --grid k=a,b",
      "aq jobs sweep --shard 8 -- … · or --grid lr=1e-3,1e-4",
    )
  }

  const session = loadSession()
  const requested = on || session?.place
  if (!requested) throw tip("no place", "aq jobs sweep --on <pool>")

  const gridRows = cartesian(grids)
  const shardCount = shards >= 1 ? shards : 1
  type Variant = { i: number; n: number; vars: Record<string, string> }
  const variants: Variant[] = []
  for (let si = 0; si < shardCount; si++) {
    for (const grow of gridRows) {
      variants.push({
        i: variants.length,
        n: 0, // filled below
        vars: {
          i: String(si),
          n: String(shardCount),
          shard: String(si),
          shards: String(shardCount),
          ...grow,
        },
      })
    }
  }
  // When only grid (no shard), i/n should index the grid row
  if (shards < 1) {
    for (let gi = 0; gi < variants.length; gi++) {
      variants[gi].vars.i = String(gi)
      variants[gi].vars.n = String(variants.length)
      variants[gi].vars.shard = String(gi)
      variants[gi].vars.shards = String(variants.length)
      variants[gi].i = gi
    }
  }
  const total = variants.length
  for (const v of variants) v.n = total

  if (total > maxJobs) {
    throw tip(
      `sweep would start ${total} jobs (max ${maxJobs})`,
      "raise with --max " + total + " · or shrink --shard / --grid",
    )
  }

  const sweepId = sweepName || newJobId()
  const remoteDir = session?.remoteDir || defaultRemoteDir(session)
  const ask = { gpu: gpuAsk }
  const pref =
    prefer || (getPlace(requested).kind === "pool" ? "next" : "same")

  if (!jsonOut) {
    step("sweep", c.cyan(sweepId) + c.dim(`  ×${total}`) + "  on  " + c.cyan(requested))
  }

  const syncedPlaces = new Set<string>()
  const train = session?.train
  const launched: { id: string; place: string; vars: Record<string, string> }[] = []
  for (const v of variants) {
    const gang = resolveSshTargets(requested, ask, 1)
    const runCmd = substCmd(cmd, v.vars)
    const tags: Tags = {
      ...tagNeed,
      sweep: sweepId,
      shard: v.vars.shard,
      i: String(v.i),
    }
    for (const [gk, gv] of Object.entries(v.vars)) {
      if (["i", "n", "shard", "shards"].includes(gk)) continue
      tags["g." + gk] = gv
    }
    const extraEnv: Record<string, string> = {
      AQ_SWEEP: sweepId,
      AQ_SHARD: v.vars.shard,
      AQ_SHARDS: v.vars.shards,
      AQ_SWEEP_I: String(v.i),
      AQ_SWEEP_N: String(v.n),
    }
    for (const [gk, gv] of Object.entries(v.vars)) {
      if (["i", "n", "shard", "shards"].includes(gk)) continue
      extraEnv["AQ_" + gk.toUpperCase().replace(/[^A-Z0-9]/g, "_")] = gv
    }

    // Sync train once per place (pool sweeps land on different boxes).
    const needSync = Boolean(train && existsSync(train) && !syncedPlaces.has(gang[0].name))
    const spec = await startRemoteJob({
      gang,
      remoteDir,
      command: runCmd,
      pool: gang[0].viaPool,
      quiet: true,
      syncTrain: needSync ? train : undefined,
      tags,
      gpu: gpuAsk,
      devices,
      extraEnv,
    })
    syncedPlaces.add(gang[0].name)
    if (manage) {
      setJobManaged(spec.id, {
        enabled: true,
        prefer: pref,
        maxRetries,
        retries: 0,
      })
    }
    launched.push({ id: spec.id, place: spec.place, vars: v.vars })
    if (!jsonOut) {
      const hint = Object.entries(v.vars)
        .filter(([k]) => !["n", "shards"].includes(k))
        .map(([k, val]) => `${k}=${val}`)
        .join(" ")
      console.log(
        "  " + c.cyan(spec.id) + "  " + c.dim(spec.place) + (hint ? c.dim("  " + hint) : ""),
      )
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ sweep: sweepId, jobs: launched, total }))
    return
  }
  stepOk("sweep", c.cyan(sweepId) + "  " + launched.length + " jobs")
  console.log(
    c.dim("next") +
      "  aq jobs list --tag sweep=" +
      sweepId +
      " · aq jobs watch  (if --manage)",
  )
}

export async function jobsCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "list" || sub === "ls" || sub === "--on") {
    const rest = sub === "list" || sub === "ls" ? argv.slice(1) : argv
    await jobsList(rest)
    return
  }
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(jobsHelp())
    return
  }
  if (sub === "run" || sub === "start") {
    await jobsRun(argv.slice(1))
    return
  }
  if (sub === "train" || sub === "eval" || sub === "serve") {
    await jobsVerb(sub, argv.slice(1))
    return
  }
  if (sub === "sweep") {
    await jobsSweep(argv.slice(1))
    return
  }
  if (sub === "status" || sub === "stat") {
    await jobsStatus(argv.slice(1))
    return
  }
  if (sub === "logs" || sub === "log") {
    await jobsLogs(argv.slice(1))
    return
  }
  if (sub === "pull") {
    await jobsPull(argv.slice(1))
    return
  }
  if (sub === "down" || sub === "kill" || sub === "cancel") {
    await jobsDown(argv.slice(1))
    return
  }
  if (sub === "recover" || sub === "retry" || sub === "restart") {
    await jobsRecover(argv.slice(1))
    return
  }
  if (sub === "watch") {
    await jobsWatch(argv.slice(1))
    return
  }
  if (sub === "manage") {
    await jobsManage(argv.slice(1))
    return
  }
  if (sub === "submit" || sub === "enqueue") {
    const { queueCmd } = await import("./queue.js")
    await queueCmd(["push", ...argv.slice(1)])
    return
  }
  throw tip(`unknown jobs command: ${sub}`, "aq jobs help")
}
