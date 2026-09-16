/** aq port — SSH LocalForward tunnels to expose remote training/inference ports. */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadSession, type SshPlace } from "./places.js"
import { describePick, resolveSshTarget } from "./pool.js"
import { sshBaseArgs, sshTarget } from "./ssh.js"
import { c, step, stepOk } from "./ui.js"

export type PortForward = {
  /** Local listen port on the laptop. */
  local: number
  /** Remote port on the place (usually 127.0.0.1:remote). */
  remote: number
}

export type TunnelRecord = {
  id: string
  place: string
  local: number
  remote: number
  pid: number
  url: string
  at: string
  jobId?: string
}

type PortsFile = { tunnels: TunnelRecord[] }

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function aquinDir(): string {
  const d = path.join(homedir(), ".aquin")
  mkdirSync(d, { recursive: true })
  return d
}

function portsPath(): string {
  return path.join(aquinDir(), "ports.json")
}

function loadPorts(): PortsFile {
  const p = portsPath()
  if (!existsSync(p)) return { tunnels: [] }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as PortsFile
    return { tunnels: Array.isArray(raw.tunnels) ? raw.tunnels : [] }
  } catch {
    return { tunnels: [] }
  }
}

function savePorts(file: PortsFile): void {
  writeFileSync(portsPath(), JSON.stringify(file, null, 2) + "\n", "utf8")
}

/** Parse `8000` or `local:remote` (e.g. `9000:8000`). */
export function parsePortForward(spec: string): PortForward {
  const s = spec.trim()
  const m = /^(\d+)(?::(\d+))?$/.exec(s)
  if (!m) throw tip(`bad port: ${spec}`, "aq port 8000 · aq port 9000:8000")
  const a = Number(m[1])
  const b = m[2] != null ? Number(m[2]) : a
  if (!Number.isFinite(a) || a < 1 || a > 65535 || !Number.isFinite(b) || b < 1 || b > 65535) {
    throw tip(`bad port: ${spec}`, "use 1–65535")
  }
  return { local: a, remote: b }
}

export function sshForwardArgs(fw: PortForward): string[] {
  return ["-L", `${fw.local}:127.0.0.1:${fw.remote}`]
}

export function forwardUrl(fw: PortForward): string {
  return `http://127.0.0.1:${fw.local}`
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pruneDead(): TunnelRecord[] {
  const file = loadPorts()
  const live = file.tunnels.filter((t) => alive(t.pid))
  if (live.length !== file.tunnels.length) savePorts({ tunnels: live })
  return live
}

function portHelp(): string {
  return [
    "aq port <port|local:remote> [--on place] [--bg]   SSH tunnel to place",
    "aq port ls                                       list open tunnels",
    "aq port down [id|port]                           close tunnel(s)",
    "",
    "Examples:",
    "  aq port 8000 --on temp          # laptop :8000 → place :8000 (foreground)",
    "  aq port 9000:6006 --on temp -b  # tensorboard-style, background",
    "  aq launch --on temp --port 8000 # interactive SSH with -L",
    "  aq jobs run --on temp --port 8000 -- python -m http.server 8000",
    "",
    "File: " + portsPath(),
  ].join("\n")
}

/** Background LocalForward; records pid in ~/.aquin/ports.json. */
export function openTunnelBg(
  place: SshPlace,
  placeName: string,
  fw: PortForward,
  opts: { jobId?: string; quiet?: boolean } = {},
): TunnelRecord {
  const target = sshTarget(place)
  const child = spawn(
    "ssh",
    [
      ...sshBaseArgs(place),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      ...sshForwardArgs(fw),
      target,
    ],
    { detached: true, stdio: "ignore" },
  )
  if (child.pid == null) throw tip("failed to start tunnel", "aq places")
  child.unref()

  const rec: TunnelRecord = {
    id: `${placeName}-${fw.local}-${Date.now().toString(36).slice(-4)}`,
    place: placeName,
    local: fw.local,
    remote: fw.remote,
    pid: child.pid,
    url: forwardUrl(fw),
    at: new Date().toISOString(),
    jobId: opts.jobId,
  }
  const file = loadPorts()
  file.tunnels = pruneDead().filter(
    (t) => !(t.place === placeName && t.local === fw.local),
  )
  file.tunnels.push(rec)
  savePorts(file)
  if (!opts.quiet) {
    stepOk("port", `${c.cyan(String(fw.local))} → ${placeName}:${fw.remote}  ${c.dim(rec.url)}`)
  }
  return rec
}

/** Foreground tunnel (blocks until Ctrl-C). */
export async function openTunnelFg(
  place: SshPlace,
  placeName: string,
  fw: PortForward,
): Promise<number> {
  const target = sshTarget(place)
  step("port", `${fw.local} → ${placeName}:${fw.remote}  ${c.dim(forwardUrl(fw))}`)
  console.log(c.dim("  ctrl-c to close"))
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        ...sshBaseArgs(place),
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        ...sshForwardArgs(fw),
        target,
      ],
      { stdio: "inherit" },
    )
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

async function portOpen(argv: string[]): Promise<void> {
  let spec = ""
  let on = ""
  let bg = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--on") {
      on = argv[++i] || ""
      continue
    }
    if (a === "--bg" || a === "-b") {
      bg = true
      continue
    }
    if (!a.startsWith("-") && !spec) {
      spec = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq port 8000 --on <place>")
  }
  if (!spec) throw tip("need a port", "aq port 8000 --on temp")
  const fw = parsePortForward(spec)
  const session = loadSession()
  const placeName = on || session?.place
  if (!placeName) throw tip("need --on <place>", "aq places · or aq launch first")

  let resolved
  try {
    if (!on && session?.place === placeName && session.member) {
      resolved = resolveSshTarget(session.member)
      resolved = { ...resolved, requested: placeName, viaPool: placeName }
    } else {
      resolved = resolveSshTarget(placeName)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown place")) {
      throw tip(e.message.split("\n")[0], "aq places")
    }
    throw e
  }

  console.log(c.bold("port") + "  " + describePick(resolved))
  if (bg) {
    openTunnelBg(resolved.place, resolved.name, fw)
    console.log(c.dim("next") + "  open " + forwardUrl(fw) + " · aq port down " + fw.local)
    return
  }
  const code = await openTunnelFg(resolved.place, resolved.name, fw)
  if (code !== 0) process.exitCode = code
}

async function portList(): Promise<void> {
  const tunnels = pruneDead()
  if (!tunnels.length) {
    console.log(c.yellow("no tunnels"))
    console.log(c.dim("  tip") + "  aq port 8000 --on <place> --bg")
    return
  }
  console.log(c.bold("ports"))
  for (const t of tunnels) {
    console.log(
      "  " +
        c.cyan(String(t.local)) +
        " → " +
        t.place +
        ":" +
        t.remote +
        "  " +
        c.dim(t.url) +
        (t.jobId ? c.dim("  job " + t.jobId) : "") +
        c.dim("  pid " + t.pid),
    )
  }
}

async function portDown(argv: string[]): Promise<void> {
  const key = argv[0]
  const file = loadPorts()
  const tunnels = pruneDead()
  const match = key
    ? tunnels.filter(
        (t) =>
          t.id === key ||
          String(t.local) === key ||
          t.jobId === key ||
          t.place === key,
      )
    : tunnels
  if (!match.length) {
    throw tip(key ? `no tunnel matching ${key}` : "no tunnels", "aq port ls")
  }
  for (const t of match) {
    try {
      process.kill(t.pid, "SIGTERM")
    } catch {
      /* already dead */
    }
    stepOk("port", "closed  " + c.cyan(String(t.local)) + " → " + t.place + ":" + t.remote)
  }
  const ids = new Set(match.map((t) => t.id))
  savePorts({ tunnels: file.tunnels.filter((t) => !ids.has(t.id) && alive(t.pid)) })
}

export async function portCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(portHelp())
    return
  }
  if (sub === "list" || sub === "ls") {
    await portList()
    return
  }
  if (sub === "down" || sub === "close" || sub === "kill") {
    await portDown(argv.slice(1))
    return
  }
  // `aq port 8000 …`
  await portOpen(argv)
}

/** Close tunnels tied to a job id (best-effort). */
export function closeTunnelsForJob(jobId: string): void {
  const file = loadPorts()
  const match = file.tunnels.filter((t) => t.jobId === jobId)
  for (const t of match) {
    try {
      process.kill(t.pid, "SIGTERM")
    } catch {
      /* ignore */
    }
  }
  if (match.length) {
    const ids = new Set(match.map((t) => t.id))
    savePorts({ tunnels: pruneDead().filter((t) => !ids.has(t.id)) })
  }
}
