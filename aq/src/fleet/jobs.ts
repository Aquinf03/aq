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
  remoteShellPath,
  rsyncFromRemote,
  shQuote,
  sshBaseArgs,
  sshExec,
  sshTarget,
} from "./ssh.js"
import { c, step, stepOk } from "./ui.js"

export type RemoteJobStatus = "running" | "exited" | "canceled" | "error"

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
}

type JobsIndex = {
  jobs: Record<
    string,
    { place: string; remoteDir: string; command: string[]; started: string }
  >
}

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function jobsHelp(): string {
  return [
    "aq jobs                     list jobs on last launch place",
    "aq jobs list [--on <place>]",
    "aq jobs run [--on <place>] -- <cmd>…   start cmd in background on the place",
    "aq jobs status <id>",
    "aq jobs logs <id> [-n N|-f]            fetch or follow remote log",
    "aq jobs pull <id> [dir]                download jobs/<id>/ (default: ./jobs-pull/<id>)",
    "aq jobs down <id>                      kill remote job",
    "",
    "Jobs live on the place under <remoteDir>/jobs/<id>/ (spec.json, log, pid).",
    "Need a place: aq launch --on <place>  (or pass --on)",
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

function rememberJob(spec: RemoteJobSpec): void {
  const idx = loadIndex()
  idx.jobs[spec.id] = {
    place: spec.place,
    remoteDir: spec.remoteDir,
    command: spec.command,
    started: spec.started,
  }
  saveIndex(idx)
}

function resolveContext(onFlag: string | undefined): {
  placeName: string
  place: SshPlace
  remoteDir: string
  session: FleetSession | null
} {
  const session = loadSession()
  const placeName = onFlag || session?.place
  if (!placeName) {
    throw tip("no place", "aq launch --on <place> first · or pass --on <place>")
  }
  const p = getPlace(placeName)
  if (p.kind !== "ssh") {
    throw tip(`place ${placeName} is ${p.kind}`, "only ssh for now")
  }
  const remoteDir =
    session?.place === placeName && session.remoteDir
      ? session.remoteDir
      : `~/aq-runs/${path.basename(session?.train || process.cwd())}`
  return { placeName, place: p, remoteDir, session }
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
  if (st === "error") return c.red(st)
  return c.dim(st)
}

function printJob(spec: RemoteJobSpec): void {
  const cmd = spec.command.join(" ")
  console.log(
    "  " +
      c.cyan(spec.id) +
      "  " +
      statusColor(spec.status) +
      (spec.code != null ? c.dim(` exit ${spec.code}`) : "") +
      "  " +
      c.dim(cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd),
  )
}

async function jobsRun(argv: string[]): Promise<void> {
  let on: string | undefined
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
    throw tip(`unknown flag: ${a}`, "aq jobs run --on <place> -- <cmd>")
  }
  if (!sawDash || !cmd.length) {
    throw tip("need a command after --", "aq jobs run --on temp -- sleep 30")
  }

  const { placeName, place, remoteDir } = resolveContext(on)
  const id = newId()
  const started = new Date().toISOString()
  const dir = remoteJobDir(remoteDir, id)
  const runLine = cmd.map(shQuote).join(" ")

  const runSh = [
    "#!/bin/bash",
    "set +e",
    `cd ${remoteShellPath(remoteDir)} || exit 90`,
    'export PATH="$HOME/.aquin/bin:$PATH"',
    runLine,
    `echo $? > ${remoteShellPath(dir + "/code")}`,
  ].join("\n")

  const spec: RemoteJobSpec = {
    id,
    place: placeName,
    remoteDir,
    command: cmd,
    pid: null,
    status: "running",
    code: null,
    started,
    ended: null,
  }
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

  step("jobs", "start  " + cmd.join(" "))
  const r = sshExec(place, script, { timeoutMs: 30_000 })
  if (r.status !== 0) {
    throw tip(
      `failed to start job: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "ssh error"}`,
      "aq places · aq launch --on " + placeName,
    )
  }
  const pid = Number((r.stdout || "").trim().split("\n").pop())
  if (Number.isFinite(pid)) spec.pid = pid
  rememberJob(spec)

  stepOk("jobs", "id  " + c.cyan(id) + (spec.pid != null ? c.dim("  pid " + spec.pid) : ""))
  console.log(c.dim("next") + "  aq jobs logs " + id + " · aq jobs status " + id)
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
  const { placeName, place, remoteDir } = resolveContext(on)
  console.log(c.bold("jobs") + "  " + c.cyan(placeName) + c.dim("  " + remoteDir))
  const ids = listRemoteIds(place, remoteDir)
  const fromIdx = Object.entries(loadIndex().jobs)
    .filter(([, j]) => j.place === placeName)
    .map(([id]) => id)
  const all = [...new Set([...ids, ...fromIdx])].sort()
  if (!all.length) {
    console.log(c.yellow("no jobs"))
    console.log(c.dim("  tip") + "  aq jobs run --on " + placeName + " -- sleep 20")
    return
  }
  for (const id of all) {
    try {
      const meta = loadIndex().jobs[id]
      const rd = meta?.remoteDir || remoteDir
      printJob(refreshRemote(place, rd, id))
    } catch {
      console.log("  " + c.cyan(id) + "  " + c.red("missing"))
    }
  }
}

async function jobsStatus(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let on: string | undefined
  if (argv[1] === "--on") on = argv[2]
  const { placeName, place, remoteDir } = lookupJob(id, on)
  const spec = refreshRemote(place, remoteDir, id)
  console.log(c.bold("job") + "  " + c.cyan(spec.id))
  console.log(c.dim("  place") + "   " + placeName)
  console.log(c.dim("  status") + "  " + statusColor(spec.status))
  console.log(c.dim("  cmd") + "     " + spec.command.join(" "))
  if (spec.pid != null) console.log(c.dim("  pid") + "     " + spec.pid)
  if (spec.code != null) console.log(c.dim("  exit") + "    " + spec.code)
  console.log(c.dim("  start") + "   " + spec.started)
  if (spec.ended) console.log(c.dim("  end") + "     " + spec.ended)
}

async function jobsLogs(argv: string[]): Promise<void> {
  let id = ""
  let follow = false
  let lines = 80
  let on: string | undefined
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
    if (!id && !a.startsWith("-")) {
      id = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq jobs logs <id> [-n 80|-f]")
  }
  if (!id) throw tip("need a job id", "aq jobs list")
  const { place, remoteDir } = lookupJob(id, on)
  const log = remoteJobDir(remoteDir, id) + "/log"
  if (follow) {
    step("logs", id + "  follow")
    const target = sshTarget(place)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ssh",
        [...sshBaseArgs(place), "-t", target, `tail -n ${lines} -f ${remoteShellPath(log)}`],
        { stdio: "inherit" },
      )
      child.on("error", reject)
      child.on("exit", () => resolve())
    })
    return
  }
  const r = sshExec(
    place,
    `tail -n ${lines} ${remoteShellPath(log)} 2>/dev/null || echo '(no log yet)'`,
  )
  process.stdout.write(r.stdout || "")
  if (r.stderr) process.stderr.write(r.stderr)
}

async function jobsPull(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let dest = ""
  let on: string | undefined
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--on") {
      on = argv[++i]
      continue
    }
    if (!dest && !argv[i].startsWith("-")) {
      dest = argv[i]
      continue
    }
  }
  const { place, remoteDir } = lookupJob(id, on)
  const local = path.resolve(dest || path.join("jobs-pull", id))
  step("pull", remoteJobDir(remoteDir, id) + " → " + local)
  await rsyncFromRemote(place, remoteJobDir(remoteDir, id), local)
  stepOk("pull", local)
}

async function jobsDown(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq jobs list")
  let on: string | undefined
  if (argv[1] === "--on") on = argv[2]
  const { place, remoteDir } = lookupJob(id, on)
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
  step("down", id)
  const r = sshExec(place, script)
  if (r.status !== 0) {
    throw tip(`down failed: ${(r.stderr || r.stdout || "").trim()}`, "aq jobs status " + id)
  }
  stepOk("down", "canceled  " + id)
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
  throw tip(`unknown jobs command: ${sub}`, "aq jobs help")
}
