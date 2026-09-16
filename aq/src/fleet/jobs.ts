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
import { describeGang, describePick, resolveSshTarget, resolveSshTargets } from "./pool.js"
import {
  formatSshError,
  remoteShellPath,
  rsyncFromRemote,
  rsyncToRemote,
  shQuote,
  sshBaseArgs,
  sshCheck,
  sshExec,
  sshTarget,
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
    "aq jobs list [--on <place>]",
    "aq jobs run [--on <place|pool>] [--nodes N] [--gpu N] [--json] -- <cmd>…",
    "aq jobs train|eval|serve [--on …] [--nodes N] [--gpu N] [--json] [-- <extra>…]",
    "aq jobs status <id> [--json]",
    "aq jobs logs <id> [-n N|-f] [--rank K]",
    "aq jobs pull <id> [dir] [--rank K]",
    "aq jobs down <id>",
    "aq jobs recover <id> [--same|--next|--on place|pool] [--force] [--json]",
    "",
    "--nodes N  (N>1) needs a pool: sync + start the same cmd on N boxes with",
    "           RANK / WORLD_SIZE / MASTER_ADDR / MASTER_PORT set (torchrun-friendly).",
    "recover    restart same id after host/process death (SSH spot/preempt pattern).",
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

function saveIndex(idx: JobsIndex): void {
  mkdirSync(path.dirname(indexPath()), { recursive: true })
  writeFileSync(indexPath(), JSON.stringify(idx, null, 2) + "\n", "utf8")
}

function rememberJob(spec: RemoteJobSpec, pool?: string): void {
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
  }
  saveIndex(idx)
}

function defaultRemoteDir(session: FleetSession | null): string {
  return `~/aq-runs/${path.basename(session?.train || process.cwd())}`
}

/** Start one background process on a place; returns pid. */
function startOnNode(opts: {
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

function newId(): string {
  return randomBytes(4).toString("hex")
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

function statusColor(st: string): string {
  if (st === "running") return c.green(st)
  if (st === "canceled") return c.yellow(st)
  if (st === "error" || st === "unreachable") return c.red(st)
  return c.dim(st)
}

function printJob(spec: RemoteJobSpec): void {
  const cmd = spec.command.join(" ")
  const gang =
    spec.nodes && spec.nodes.length > 1 ? c.dim(`  ×${spec.nodes.length}`) : ""
  console.log(
    "  " +
      c.cyan(spec.id) +
      "  " +
      statusColor(spec.status) +
      (spec.code != null ? c.dim(` exit ${spec.code}`) : "") +
      gang +
      "  " +
      c.dim(cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd),
  )
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
    throw tip(`unknown flag: ${a}`, "aq jobs run --on <place|pool> [--nodes N] -- <cmd>")
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
  const id = newId()
  const started = new Date().toISOString()
  const masterAddr = gang[0].place.host
  const worldSize = gang.length

  if (!jsonOut) {
    if (worldSize > 1) console.log(c.dim("nodes") + "  " + describeGang(gang))
    else if (gang[0].viaPool) console.log(c.dim("pool") + "  " + describePick(gang[0]))
    step("jobs", "start  " + cmd.join(" ") + (worldSize > 1 ? c.dim(`  ×${worldSize}`) : ""))
  }

  // Best-effort sync train to every node so ranks share the same tree
  if (session?.train && existsSync(session.train)) {
    for (const g of gang) {
      if (!jsonOut) step("sync", g.name)
      await rsyncToRemote(session.train, g.place, remoteDir, "defaults")
    }
  }

  const nodeSpecs: JobNode[] = []
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
  rememberJob(spec, head.viaPool)

  if (jsonOut) {
    console.log(
      JSON.stringify({
        id,
        place: head.name,
        pool: head.viaPool,
        nodes: nodeSpecs,
        command: cmd,
        worldSize,
        masterAddr,
        masterPort,
      }),
    )
  } else {
    stepOk(
      "jobs",
      "id  " +
        c.cyan(id) +
        (worldSize > 1 ? c.dim(`  ranks 0..${worldSize - 1}`) : "") +
        (spec.pid != null ? c.dim("  pid " + spec.pid) : ""),
    )
    console.log(c.dim("next") + "  aq jobs logs " + id + " · aq jobs status " + id)
  }
  return id
}

async function jobsVerb(verb: "train" | "eval" | "serve", argv: string[]): Promise<void> {
  let on: string | undefined
  let jsonOut = false
  let gpuAsk: number | undefined
  let nodes: number | undefined
  let masterPort: number | undefined
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
    if (!a.startsWith("-")) {
      extra.push(a)
      i += 1
      continue
    }
    throw tip(`unknown flag: ${a}`, `aq jobs ${verb} [--on <pool>] [--nodes N] [--gpu N]`)
  }
  const cmd = ["aq", verb, ...extra]
  const flags = [
    ...(on ? ["--on", on] : []),
    ...(jsonOut ? ["--json"] : []),
    ...(gpuAsk != null ? ["--gpu", String(gpuAsk)] : []),
    ...(nodes != null ? ["--nodes", String(nodes)] : []),
    ...(masterPort != null ? ["--master-port", String(masterPort)] : []),
    "--",
    ...cmd,
  ]
  await jobsRun(flags)
}

async function jobsList(argv: string[]): Promise<void> {
  let on: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--on") {
      on = argv[++i]
      continue
    }
    if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(jobsHelp())
      return
    }
    throw tip(`unknown flag: ${argv[i]}`, "aq jobs list [--on <place>]")
  }
  const session = loadSession()
  const requested = on || session?.place
  if (!requested) throw tip("no place", "aq launch --on <place> · or --on")

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
    console.log(c.bold("jobs") + "  " + c.cyan(requested) + c.dim("  pool"))
  } else if (target.kind === "ssh") {
    const ctx = resolveContext(requested)
    members.push({ name: ctx.placeName, place: ctx.place, remoteDir: ctx.remoteDir })
    console.log(c.bold("jobs") + "  " + c.cyan(ctx.placeName) + c.dim("  " + ctx.remoteDir))
  } else {
    throw tip(`place ${requested} is ${(target as { kind: string }).kind}`, "aq add ssh")
  }

  let any = false
  const seen = new Set<string>()
  for (const m of members) {
    const ids = listRemoteIds(m.place, m.remoteDir)
    const fromIdx = Object.entries(loadIndex().jobs)
      .filter(([, j]) => j.place === m.name || j.nodes?.some((n) => n.place === m.name))
      .map(([id]) => id)
    const all = [...new Set([...ids, ...fromIdx])].sort()
    if (!all.length) continue
    any = true
    if (target.kind === "pool") {
      console.log(c.dim("  · " + m.name))
    }
    for (const id of all) {
      if (seen.has(id)) continue
      seen.add(id)
      try {
        const meta = loadIndex().jobs[id]
        const rd = meta?.remoteDir || m.remoteDir
        const headPlace = meta?.place ? getPlace(meta.place) : m.place
        const ssh = headPlace.kind === "ssh" ? headPlace : m.place
        printJob(refreshRemote(ssh, rd, id))
      } catch {
        console.log("  " + c.cyan(id) + "  " + c.red("missing"))
      }
    }
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
    if (jsonOut) {
      console.log(JSON.stringify({ ...spec, ranks }))
      return
    }
    console.log(c.bold("job") + "  " + c.cyan(spec.id) + c.dim(`  ×${nodes.length}`))
    console.log(c.dim("  status") + "  " + statusColor(spec.status))
    console.log(c.dim("  cmd") + "     " + spec.command.join(" "))
    if (spec.masterAddr) {
      console.log(c.dim("  master") + "  " + spec.masterAddr + ":" + (spec.masterPort || 29500))
    }
    for (const n of spec.nodes) {
      console.log(
        c.dim("  rank " + n.rank) +
          "  " +
          c.cyan(n.place) +
          "  " +
          statusColor(n.status || "?") +
          (n.code != null ? c.dim(` exit ${n.code}`) : ""),
      )
    }
    if (spec.status === "unreachable") {
      console.log(c.dim("  tip") + "     aq jobs recover " + id)
    }
    return
  }
  if (jsonOut) {
    console.log(JSON.stringify(spec))
    return
  }
  console.log(c.bold("job") + "  " + c.cyan(spec.id))
  console.log(c.dim("  place") + "   " + placeName)
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

  // Probe current head (or ranks)
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
    if (jsonOut) {
      console.log(JSON.stringify({ id, status: "running", recovered: false }))
      return
    }
    stepOk("recover", "already running  " + c.cyan(id))
    console.log(c.dim("tip") + "  aq jobs status " + id + " · pass --force to kill+restart")
    return
  }

  // Where to place the restart
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
      // Pool too small after exclude — allow original members if they're back up
      gang = resolveSshTargets(poolName, ask, worldSize)
    }
  } else if (same || !preferNext) {
    // Restart on the original place(s)
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

  if (!jsonOut) {
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
      if (!jsonOut) step("sync", g.name)
      await rsyncToRemote(session.train, g.place, remoteDir, "defaults")
    }
  }

  const started = new Date().toISOString()
  const masterAddr = gang[0].place.host
  const cmd = entry.command
  const nodeSpecs: JobNode[] = []

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
  rememberJob(spec, poolName || head.viaPool || entry.pool)

  if (jsonOut) {
    console.log(
      JSON.stringify({
        id,
        recovered: true,
        place: head.name,
        pool: poolName || head.viaPool || entry.pool,
        nodes: nodeSpecs,
        from: oldPlaces,
      }),
    )
    return
  }
  stepOk(
    "recover",
    "id  " +
      c.cyan(id) +
      "  on  " +
      c.cyan(head.name) +
      (spec.pid != null ? c.dim("  pid " + spec.pid) : ""),
  )
  console.log(c.dim("next") + "  aq jobs logs " + id + " · aq jobs status " + id)
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
  throw tip(`unknown jobs command: ${sub}`, "aq jobs help")
}
