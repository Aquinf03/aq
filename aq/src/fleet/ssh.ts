/** SSH place: sync train, optional aq setup, interactive shell. */

import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs"
import { stdout } from "node:process"
import path from "node:path"
import { aqRoot } from "../core/root.js"
import type { SshPlace } from "./places.js"
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

export function sshInteractive(place: SshPlace, remoteDir: string): Promise<number> {
  const target = sshTarget(place)
  const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.aquin/bin:$PATH" && exec bash -l`
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshBaseArgs(place), "-t", target, remoteCmd], {
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
