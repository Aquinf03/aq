/** SSH place: sync train, optional aq setup, interactive shell. */

import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs"
import { stdout } from "node:process"
import path from "node:path"
import { aqRoot } from "../core/root.js"
import type { PlaceResources, SshPlace } from "./places.js"
import { c, fmtMs, step, stepOk } from "./ui.js"

/** Dir/file names skipped when estimating size (defaults profile). */
export const SYNC_SKIP = new Set([
  ".git",
  "node_modules",
  "jobs",
  "__pycache__",
  ".venv",
  ".next",
])

export type SyncProfile = "defaults" | "lean" | "minimal"

export function excludeArgs(profile: SyncProfile): string[] {
  const pairs = (names: string[]) => names.flatMap((n) => ["--exclude", n])
  if (profile === "minimal") {
    return pairs([".git", "node_modules"])
  }
  const base = [
    ".git",
    "node_modules",
    "jobs",
    "**/__pycache__",
    ".venv",
    "**/.next",
    "artifacts/checkpoints",
  ]
  if (profile === "lean") {
    return pairs([
      ...base,
      "data",
      "datasets",
      "wandb",
      "runs",
      "**/*.pt",
      "**/*.ckpt",
      "**/*.safetensors",
    ])
  }
  return pairs(base)
}

export function estimateSync(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (SYNC_SKIP.has(ent.name)) continue
      if (ent.name === "checkpoints" && path.basename(dir) === "artifacts") continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      files += 1
      try {
        bytes += statSync(full).size
      } catch {
        /* skip */
      }
    }
  }
  walk(root)
  return { files, bytes }
}

export function sshTarget(place: SshPlace): string {
  const user = (place.user || "").trim()
  if (user) return `${user}@${place.host}`
  return place.host
}

export function sshBaseArgs(place: SshPlace): string[] {
  const args: string[] = []
  if (place.port != null && place.port !== 22) {
    args.push("-p", String(place.port))
  }
  if (place.key) {
    const key = place.key.startsWith("~")
      ? path.join(process.env.HOME || "", place.key.slice(1))
      : place.key
    args.push("-i", key)
  }
  args.push("-o", "StrictHostKeyChecking=accept-new")
  return args
}

function expandRemoteDir(remoteDir: string): string {
  // Keep ~/… for remote shell; rsync wants user@host:~/…
  return remoteDir
}

/** rsync ≥3.1 → one-line progress2; older → heartbeat + stats (no per-file spam). */
type ProgressMode = "progress2" | "heartbeat" | "quiet"

let cachedMode: ProgressMode | null = null

function rsyncProgressMode(): ProgressMode {
  if (cachedMode) return cachedMode
  if (!stdout.isTTY || process.env.AQ_RSYNC_QUIET === "1") {
    cachedMode = "quiet"
    return cachedMode
  }
  const ver = spawnSync("rsync", ["--version"], { encoding: "utf8" })
  const m = /rsync\s+version\s+(\d+)\.(\d+)/i.exec(ver.stdout || "")
  const major = m ? Number(m[1]) : 0
  const minor = m ? Number(m[2]) : 0
  cachedMode =
    major > 3 || (major === 3 && minor >= 1) ? "progress2" : "heartbeat"
  return cachedMode
}

function parseStats(text: string): string {
  const size = /Total transferred file size:\s*([\d,]+)\s*bytes/i.exec(text)
  const files = /Number of (?:regular )?files transferred:\s*([\d,]+)/i.exec(text)
  const bits: string[] = []
  if (files) bits.push(files[1].replace(/,/g, "") + " files")
  if (size) {
    const n = Number(size[1].replace(/,/g, ""))
    if (Number.isFinite(n)) {
      if (n >= 1e9) bits.push((n / 1e9).toFixed(1) + "GB")
      else if (n >= 1e6) bits.push((n / 1e6).toFixed(1) + "MB")
      else if (n >= 1e3) bits.push((n / 1e3).toFixed(0) + "KB")
      else bits.push(n + "B")
    }
  }
  return bits.join(" · ")
}

function clearLine(): void {
  if (stdout.isTTY) stdout.write("\r\x1b[K")
}

/** Returns a short stats summary when available. */
async function runRsync(baseArgs: string[]): Promise<string> {
  const mode = rsyncProgressMode()
  if (mode === "progress2") {
    const args = [...baseArgs.slice(0, 1), "--info=progress2", ...baseArgs.slice(1)]
    const r = spawnSync("rsync", args, { stdio: "inherit", encoding: "utf8" })
    if (r.error) throw new Error(`rsync: ${r.error.message} (is rsync installed?)`)
    if (r.status !== 0) throw new Error(`rsync failed (${r.status ?? "?"})`)
    return ""
  }

  const args = [...baseArgs.slice(0, 1), "--stats", ...baseArgs.slice(1)]
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString()
    })
    child.stderr?.on("data", (b: Buffer) => {
      out += b.toString()
    })
    const tick =
      mode === "heartbeat" && stdout.isTTY
        ? setInterval(() => {
            stdout.write(
              `\r${c.blue("sync")}${c.dim("  … " + fmtMs(Date.now() - t0) + "   ")}`,
            )
          }, 200)
        : undefined
    child.on("error", (err) => {
      if (tick) clearInterval(tick)
      clearLine()
      reject(new Error(`rsync: ${err.message} (is rsync installed?)`))
    })
    child.on("exit", (code) => {
      if (tick) clearInterval(tick)
      clearLine()
      if (code !== 0) {
        const one = out.trim().split("\n").filter(Boolean).pop() || `exit ${code}`
        reject(new Error(`rsync failed (${code ?? "?"}): ${one}`))
        return
      }
      resolve(parseStats(out))
    })
  })
}

export async function rsyncToRemote(
  train: string,
  place: SshPlace,
  remoteDir: string,
  profile: SyncProfile = "defaults",
): Promise<void> {
  const target = sshTarget(place)
  const dest = `${target}:${expandRemoteDir(remoteDir)}/`
  const sshArgs = sshBaseArgs(place)
  const shellSsh = ["ssh", ...sshArgs].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")

  step("sync", "mkdir remote")
  const t0 = Date.now()
  const mkdir = spawnSync(
    "ssh",
    [...sshBaseArgs(place), target, `mkdir -p ${remoteDir}`],
    { stdio: "inherit", encoding: "utf8" },
  )
  if (mkdir.status !== 0) throw new Error(`ssh mkdir failed (${mkdir.status ?? "?"})`)

  step("sync", `rsync → ${dest}` + (profile !== "defaults" ? c.dim(`  (${profile})`) : ""))
  const stats = await runRsync([
    "-az",
    "--delete",
    ...excludeArgs(profile),
    "-e",
    shellSsh,
    train + "/",
    dest,
  ])
  const extra = stats ? " · " + stats : ""
  stepOk("sync", "ok  " + fmtMs(Date.now() - t0) + extra)
}

/** Best-effort: ensure `aq` on remote PATH. */
export async function setupAqOnRemote(place: SshPlace): Promise<void> {
  const target = sshTarget(place)
  const localAq = path.join(aqRoot(), "bin", "aq")
  const hasLocal = existsSync(localAq)

  step("setup", "checking remote aq")
  const check = spawnSync(
    "ssh",
    [...sshBaseArgs(place), target, "command -v aq >/dev/null && aq version 2>/dev/null | head -1"],
    { encoding: "utf8" },
  )
  if (check.status === 0 && (check.stdout || "").trim()) {
    stepOk("setup", "already have  " + (check.stdout || "").trim())
    return
  }

  if (hasLocal) {
    const t0 = Date.now()
    step("setup", "rsync local aq → ~/.aquin/aq-pkg")
    const pkg = aqRoot()
    const remotePkg = "~/.aquin/aq-pkg"
    const mkdir = spawnSync(
      "ssh",
      [...sshBaseArgs(place), target, "mkdir -p ~/.aquin/aq-pkg ~/.aquin/bin"],
      { stdio: "inherit" },
    )
    if (mkdir.status !== 0) throw new Error("remote mkdir for aq-pkg failed")

    const sshArgs = sshBaseArgs(place)
    const shellSsh = ["ssh", ...sshArgs].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")
    await runRsync([
      "-az",
      "--delete",
      "--exclude",
      "node_modules",
      "--exclude",
      ".git",
      "--exclude",
      "kernel/.venv",
      "-e",
      shellSsh,
      pkg + "/",
      `${target}:${remotePkg}/`,
    ])

    step("setup", "link ~/.aquin/bin/aq")
    const link = spawnSync(
      "ssh",
      [
        ...sshBaseArgs(place),
        target,
        [
          "ln -sfn ~/.aquin/aq-pkg/bin/aq ~/.aquin/bin/aq",
          "grep -q '.aquin/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=\"$HOME/.aquin/bin:$PATH\"' >> ~/.bashrc",
          "export PATH=\"$HOME/.aquin/bin:$PATH\"",
          "command -v node >/dev/null || echo 'warn: node not found on remote — install Node >= 18'",
          "aq version 2>/dev/null || node ~/.aquin/aq-pkg/bin/aq version 2>/dev/null || true",
        ].join(" && "),
      ],
      { stdio: "inherit" },
    )
    if (link.status !== 0) throw new Error("remote aq link failed")
    stepOk("setup", "ok  " + fmtMs(Date.now() - t0))
    return
  }

  step("setup", "curl install.sh")
  const inst = spawnSync(
    "ssh",
    [
      ...sshBaseArgs(place),
      target,
      "curl -fsSL https://aq.aquin.app/framework/install.sh | bash",
    ],
    { stdio: "inherit" },
  )
  if (inst.status !== 0) {
    throw new Error(
      "remote aq install failed — install Node + aq on the host, or use --no-setup",
    )
  }
  stepOk("setup", "ok")
}

export function sshInteractive(
  place: SshPlace,
  remoteDir: string,
  opts: { forwards?: { local: number; remote: number }[] } = {},
): Promise<number> {
  const target = sshTarget(place)
  const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.aquin/bin:$PATH" && exec bash -l`
  const fwd = (opts.forwards || []).flatMap((f) => ["-L", `${f.local}:127.0.0.1:${f.remote}`])
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshBaseArgs(place), ...fwd, "-t", target, remoteCmd], {
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

export function sshCheck(place: SshPlace): { ok: boolean; detail: string } {
  const target = sshTarget(place)
  const r = spawnSync(
    "ssh",
    [...sshBaseArgs(place), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "echo ok"],
    { encoding: "utf8", timeout: 15_000 },
  )
  if (r.status === 0) {
    return { ok: true, detail: "reachable" }
  }
  const err = ((r.stderr || r.stdout || "") as string).trim() || `exit ${r.status}`
  return { ok: false, detail: formatSshError(err, place) }
}

/** Short, actionable SSH errors — no raw OpenSSH banner dumps. */
export function formatSshError(raw: string, place?: SshPlace): string {
  const t = raw.replace(/\r/g, "")
  if (/UNPROTECTED PRIVATE KEY|permissions .*are too open/i.test(t)) {
    const key = place?.key || "your .pem"
    return `key permissions too open — run: chmod 600 ${key}`
  }
  if (/Permission denied \(publickey\)/i.test(t)) {
    return "permission denied (check user + key)"
  }
  if (/Could not resolve hostname/i.test(t)) {
    return "could not resolve host"
  }
  if (/Connection refused/i.test(t)) {
    return "connection refused (host/port?)"
  }
  if (/Connection timed out|Operation timed out/i.test(t)) {
    return "connection timed out"
  }
  if (/No such file or directory/i.test(t) && place?.key) {
    return `key not found: ${place.key}`
  }
  const one = t.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "ssh failed"
  return one.length > 100 ? one.slice(0, 97) + "…" : one
}

/** If key is group/world-readable, tighten to 0600 (SSH requires this). */
export function fixKeyPermissions(keyPath: string): boolean {
  const key = keyPath.startsWith("~")
    ? path.join(process.env.HOME || "", keyPath.slice(1))
    : keyPath
  if (!existsSync(key)) return false
  try {
    const mode = statSync(key).mode & 0o777
    if ((mode & 0o077) === 0) return false
    chmodSync(key, 0o600)
    return true
  } catch {
    return false
  }
}

export function runRemote(
  place: SshPlace,
  remoteDir: string,
  command: string[],
): number {
  const target = sshTarget(place)
  const quoted = command.map((c) => `'${c.replace(/'/g, `'\"'\"'`)}'`).join(" ")
  const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.aquin/bin:$PATH" && ${quoted}`
  const r = spawnSync("ssh", [...sshBaseArgs(place), "-t", target, remoteCmd], {
    stdio: "inherit",
  })
  return r.status ?? 1
}

/** Non-interactive SSH; capture stdout/stderr. */
export function sshExec(
  place: SshPlace,
  remoteCmd: string,
  opts?: { timeoutMs?: number },
): { status: number; stdout: string; stderr: string } {
  const target = sshTarget(place)
  const r = spawnSync(
    "ssh",
    [
      ...sshBaseArgs(place),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      target,
      remoteCmd,
    ],
    {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 60_000,
    },
  )
  if (r.error) {
    return { status: 1, stdout: "", stderr: r.error.message }
  }
  return {
    status: r.status ?? 1,
    stdout: (r.stdout || "").toString(),
    stderr: (r.stderr || "").toString(),
  }
}

/** Probe CPU / RAM / disk / GPU on the remote box (best-effort). */
export function probeRemoteResources(place: SshPlace): PlaceResources | null {
  const py = `
import json, os, shutil, subprocess
cpu = os.cpu_count() or 0
ram = 0
try:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                ram = int(line.split()[1]) * 1024
                break
except Exception:
    pass
disk = 0
try:
    disk = shutil.disk_usage(os.path.expanduser("~")).free
except Exception:
    pass
kind, count = "none", 0
try:
    out = subprocess.check_output(["nvidia-smi", "-L"], text=True, stderr=subprocess.DEVNULL, timeout=8)
    n = sum(1 for l in out.splitlines() if l.strip().startswith("GPU"))
    if n:
        kind, count = "nvidia", n
except Exception:
    pass
if kind == "none":
    try:
        out = subprocess.check_output(["rocm-smi", "--showid"], text=True, stderr=subprocess.DEVNULL, timeout=8)
        ids = set(__import__("re").findall(r"GPU\\[(\\d+)\\]", out))
        if ids:
            kind, count = "amd", len(ids)
        elif os.path.exists("/dev/kfd"):
            kind, count = "amd", 1
    except Exception:
        pass
print(json.dumps({"cpu": cpu, "ram": ram, "disk": disk, "gpu": {"kind": kind, "count": count}}))
`.trim()

  const bash = `
CPU=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
RAM=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
DISK=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4*1024}' || echo 0)
GK=none; GC=0
if command -v nvidia-smi >/dev/null 2>&1; then
  GC=$(nvidia-smi -L 2>/dev/null | grep -c '^GPU' || true)
  if [ "\${GC:-0}" -gt 0 ]; then GK=nvidia; fi
fi
printf '{"cpu":%s,"ram":%s,"disk":%s,"gpu":{"kind":"%s","count":%s}}\\n' "$CPU" "$RAM" "$DISK" "$GK" "$GC"
`.trim()

  const script = [
    `if command -v python3 >/dev/null 2>&1; then`,
    `  echo ${shQuote(Buffer.from(py, "utf8").toString("base64"))} | base64 -d | python3`,
    `else`,
    bash,
    `fi`,
  ].join("\n")

  const r = sshExec(place, script, { timeoutMs: 20_000 })
  if (r.status !== 0) return null
  const line = (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop()
  if (!line) return null
  try {
    const raw = JSON.parse(line) as {
      cpu?: number
      ram?: number
      disk?: number
      gpu?: { kind?: string; count?: number }
    }
    const kindRaw = (raw.gpu?.kind || "none") as PlaceResources["gpu"]["kind"]
    const kind =
      kindRaw === "nvidia" || kindRaw === "amd" || kindRaw === "mps" ? kindRaw : "none"
    return {
      cpu: Number(raw.cpu) || 0,
      ram: Number(raw.ram) || 0,
      disk: Number(raw.disk) || 0,
      gpu: { kind, count: Number(raw.gpu?.count) || 0 },
      at: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function fmtPlaceResources(res: PlaceResources): string {
  const bits: string[] = []
  if (res.cpu > 0) bits.push(res.cpu + "cpu")
  if (res.ram > 0) {
    const gb = res.ram / 1e9
    bits.push((gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)) + "GB")
  }
  if (res.gpu.kind !== "none" && res.gpu.count > 0) {
    bits.push(res.gpu.count + "×" + res.gpu.kind)
  } else {
    bits.push("no-gpu")
  }
  return bits.join(" ")
}

/** Live load on a place (not capacity). */
export type PlaceTelemetry = {
  load1: number
  cpuPct: number | null
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  gpu: { index: number; util: number; memUsed: number; memTotal: number }[]
  at: string
}

function fmtBytesShort(n: number): string {
  if (!n || n < 0) return "?"
  const gb = n / 1e9
  if (gb >= 100) return gb.toFixed(0) + "G"
  if (gb >= 10) return gb.toFixed(0) + "G"
  if (gb >= 1) return gb.toFixed(1) + "G"
  const mb = n / 1e6
  return (mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)) + "M"
}

/** Compact live line: `load 0.4  cpu 12%  mem 3.1/16G  disk 40%  gpu0 80% 2/24G` */
export function fmtPlaceTelemetry(t: PlaceTelemetry): string {
  const bits: string[] = []
  if (Number.isFinite(t.load1)) bits.push("load " + t.load1.toFixed(1))
  if (t.cpuPct != null && Number.isFinite(t.cpuPct)) bits.push("cpu " + Math.round(t.cpuPct) + "%")
  if (t.memTotal > 0) {
    bits.push("mem " + fmtBytesShort(t.memUsed) + "/" + fmtBytesShort(t.memTotal))
  }
  if (t.diskTotal > 0) {
    const pct = Math.round((100 * t.diskUsed) / t.diskTotal)
    bits.push("disk " + pct + "%")
  }
  if (t.gpu.length) {
    for (const g of t.gpu) {
      const mem =
        g.memTotal > 0 ? " " + fmtBytesShort(g.memUsed) + "/" + fmtBytesShort(g.memTotal) : ""
      bits.push("gpu" + g.index + " " + Math.round(g.util) + "%" + mem)
    }
  }
  return bits.join("  ") || "…"
}

/** Live CPU / mem / disk / GPU util via SSH (best-effort). */
export function probeRemoteTelemetry(place: SshPlace): PlaceTelemetry | null {
  const py = `
import json, os, subprocess, time
load1 = 0.0
try:
    load1 = os.getloadavg()[0]
except Exception:
    pass
cpu_pct = None
try:
    with open("/proc/stat") as f:
        parts = f.readline().split()
    nums = [int(x) for x in parts[1:]]
    idle1, total1 = nums[3], sum(nums)
    time.sleep(0.15)
    with open("/proc/stat") as f:
        parts = f.readline().split()
    nums = [int(x) for x in parts[1:]]
    idle2, total2 = nums[3], sum(nums)
    dt, di = total2 - total1, idle2 - idle1
    if dt > 0:
        cpu_pct = max(0.0, min(100.0, 100.0 * (1.0 - di / dt)))
except Exception:
    pass
mem_total = mem_avail = 0
try:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = int(line.split()[1]) * 1024
except Exception:
    pass
mem_used = max(0, mem_total - mem_avail) if mem_total else 0
disk_total = disk_used = 0
try:
    import shutil
    u = shutil.disk_usage(os.path.expanduser("~"))
    disk_total, disk_used = u.total, u.used
except Exception:
    pass
gpus = []
try:
    out = subprocess.check_output(
        ["nvidia-smi",
         "--query-gpu=index,utilization.gpu,memory.used,memory.total",
         "--format=csv,noheader,nounits"],
        text=True, stderr=subprocess.DEVNULL, timeout=8,
    )
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4: continue
        gpus.append({
            "index": int(float(parts[0])),
            "util": float(parts[1]),
            "memUsed": float(parts[2]) * 1024 * 1024,
            "memTotal": float(parts[3]) * 1024 * 1024,
        })
except Exception:
    pass
print(json.dumps({
    "load1": load1, "cpuPct": cpu_pct,
    "memUsed": mem_used, "memTotal": mem_total,
    "diskUsed": disk_used, "diskTotal": disk_total,
    "gpu": gpus,
}))
`.trim()

  const bash = `
LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
MEM_T=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_A=$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_U=$(( MEM_T > MEM_A ? MEM_T - MEM_A : 0 ))
DISK_T=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $2*1024}' || echo 0)
DISK_U=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print ($2-$4)*1024}' || echo 0)
GPU_JSON="[]"
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_JSON=$(nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | awk -F',' '
    BEGIN{printf "["}
    {
      gsub(/ /,"",$1); gsub(/ /,"",$2); gsub(/ /,"",$3); gsub(/ /,"",$4);
      if(NR>1) printf ",";
      printf "{\\"index\\":%s,\\"util\\":%s,\\"memUsed\\":%s,\\"memTotal\\":%s}", $1+0, $2+0, ($3+0)*1048576, ($4+0)*1048576
    }
    END{printf "]"}
  ' || echo "[]")
fi
printf '{"load1":%s,"cpuPct":null,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"gpu":%s}\\n' \\
  "$LOAD" "$MEM_U" "$MEM_T" "$DISK_U" "$DISK_T" "$GPU_JSON"
`.trim()

  const script = [
    `if command -v python3 >/dev/null 2>&1; then`,
    `  echo ${shQuote(Buffer.from(py, "utf8").toString("base64"))} | base64 -d | python3`,
    `else`,
    bash,
    `fi`,
  ].join("\n")

  const r = sshExec(place, script, { timeoutMs: 20_000 })
  if (r.status !== 0) return null
  const line = (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop()
  if (!line) return null
  try {
    const raw = JSON.parse(line) as {
      load1?: number
      cpuPct?: number | null
      memUsed?: number
      memTotal?: number
      diskUsed?: number
      diskTotal?: number
      gpu?: { index?: number; util?: number; memUsed?: number; memTotal?: number }[]
    }
    return {
      load1: Number(raw.load1) || 0,
      cpuPct: raw.cpuPct == null || !Number.isFinite(Number(raw.cpuPct)) ? null : Number(raw.cpuPct),
      memUsed: Number(raw.memUsed) || 0,
      memTotal: Number(raw.memTotal) || 0,
      diskUsed: Number(raw.diskUsed) || 0,
      diskTotal: Number(raw.diskTotal) || 0,
      gpu: Array.isArray(raw.gpu)
        ? raw.gpu.map((g) => ({
            index: Number(g.index) || 0,
            util: Number(g.util) || 0,
            memUsed: Number(g.memUsed) || 0,
            memTotal: Number(g.memTotal) || 0,
          }))
        : [],
      at: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/** Refuse when place resources can't cover an ask. */
export function assertPlaceCanSatisfy(
  place: SshPlace,
  ask: { gpu?: number; cpu?: number },
): void {
  const res = place.resources
  if (!res) {
    if (ask.gpu && ask.gpu > 0) {
      throw new Error(
        "place has no probed resources yet\n  tip  aq places --probe  (or re-add the place)",
      )
    }
    return
  }
  if (ask.gpu != null && ask.gpu > 0) {
    if (res.gpu.kind === "none" || res.gpu.count < 1) {
      throw new Error("place has no GPU\n  tip  pick a GPU box · aq places")
    }
    if (ask.gpu > res.gpu.count) {
      throw new Error(
        `need ${ask.gpu} GPU(s), place has ${res.gpu.count}×${res.gpu.kind}\n  tip  aq places`,
      )
    }
  }
  if (ask.cpu != null && ask.cpu > 0 && res.cpu > 0 && ask.cpu > res.cpu) {
    throw new Error(`need ${ask.cpu} CPU(s), place has ${res.cpu}\n  tip  aq places`)
  }
}

/** Quote for embedding in a remote double-quoted bash -c / single-quoted segment. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`
}

/**
 * Remote path for use in bash scripts. `~/…` must not be single-quoted
 * (tilde won't expand) — rewrite as "$HOME/…".
 */
export function remoteShellPath(p: string): string {
  if (p === "~") return '"$HOME"'
  if (p.startsWith("~/")) {
    const rest = p.slice(2).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    return `"$HOME/${rest}"`
  }
  return shQuote(p)
}

/** Pull remote path → local dir (rsync). remotePath like ~/aq-runs/x/jobs/id/ */
export async function rsyncFromRemote(
  place: SshPlace,
  remotePath: string,
  localDir: string,
): Promise<void> {
  const { mkdirSync } = await import("node:fs")
  mkdirSync(localDir, { recursive: true })
  const target = sshTarget(place)
  const src = `${target}:${remotePath.replace(/\/?$/, "/")}`
  const sshArgs = sshBaseArgs(place)
  const shellSsh = ["ssh", ...sshArgs].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")
  const r = spawnSync(
    "rsync",
    ["-az", "-e", shellSsh, src, localDir.replace(/\/?$/, "/")],
    { stdio: "inherit", encoding: "utf8" },
  )
  if (r.error) throw new Error(`rsync: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`rsync pull failed (${r.status ?? "?"})`)
}
