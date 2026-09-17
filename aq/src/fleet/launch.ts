/** aq launch / go / sync / shutdown — place workspace verbs. */

import { existsSync, readdirSync, statSync } from "node:fs"
import { stdin, stdout } from "node:process"
import path from "node:path"
import {
  clearSession,
  listPlaceNames,
  loadSession,
  remoteTrainDir,
  saveSession,
} from "./places.js"
import { describePick, resolveSshTarget } from "./pool.js"
import { cancelJobsOnPlace } from "./jobs.js"
import { forwardUrl, parsePortForward, type PortForward } from "./port.js"
import {
  remoteShellPath,
  rsyncToRemote,
  runRemote,
  setupAqOnRemote,
  sshExec,
  sshInteractive,
  type SyncProfile,
} from "./ssh.js"
import { c, prompt, step, stepOk } from "./ui.js"

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function launchHelp(): string {
  return [
    "Run these on your laptop (not inside the SSH session).",
    "",
    "aq launch [dir] --on <place> [--setup|--no-setup] [--shell] [--port N] [-- <cmd>…]",
    "  pick a folder, sync it, install/refresh aq on the place — stay on your laptop",
    "  pass [dir] to skip the folder prompt",
    "  --no-setup   skip aq install/refresh on the remote",
    "  --shell      open an SSH shell after sync (same as aq go)",
    "  --port N     SSH -L when using --shell (repeatable; N or local:remote)",
    "  -- <cmd>     run cmd once on the remote, then return to your laptop",
    "",
    "aq go [place] [--port N]       open SSH to last launch (resync when local folder exists)",
    "aq sync [dir] [--on place]     push/update local folder → place (no shell)",
    "aq shutdown [place] [--wipe]   stop jobs on place + clear session (--wipe removes remote dir)",
    "aq port <N> [--on place] [--bg]  tunnel only (see aq port help)",
    "",
    "Jobs / queue also run from the laptop: aq jobs train --on <place> …",
  ].join("\n")
}

function resolveDir(dir: string): string {
  const root = path.resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw tip(`not a directory: ${root}`, "cd into a folder, or pick one at the prompt")
  }
  return root
}

function parseLaunch(argv: string[]): {
  dir: string | null
  on: string
  setup: boolean
  shell: boolean
  command: string[] | null
  ports: PortForward[]
} {
  let dir: string | null = null
  let on = ""
  let setup = true
  let shell = false
  let i = 0
  const command: string[] = []
  let sawDash = false
  const ports: PortForward[] = []

  if (argv[0] && !argv[0].startsWith("-") && argv[0] !== "--") {
    const cand = path.resolve(argv[0])
    if (existsSync(cand) && statSync(cand).isDirectory()) {
      dir = argv[0]
      i = 1
    }
  }

  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      sawDash = true
      command.push(...argv.slice(i + 1))
      break
    }
    if (a === "--on") {
      const v = argv[i + 1]
      if (!v || v.startsWith("-")) {
        throw tip("need a place after --on", "aq places · aq add ssh")
      }
      on = v
      i += 2
      continue
    }
    if (a === "--no-setup") {
      setup = false
      i += 1
      continue
    }
    if (a === "--setup") {
      setup = true
      i += 1
      continue
    }
    if (a === "--shell" || a === "-s") {
      shell = true
      i += 1
      continue
    }
    if (a === "--port" || a === "-p") {
      const v = argv[i + 1]
      if (!v) throw tip("need N after --port", "aq launch --on temp --port 8000")
      ports.push(parsePortForward(v))
      i += 2
      continue
    }
    // kept for scripts; picker is the interactive path now
    if (a === "-y" || a === "--yes") {
      i += 1
      continue
    }
    if (a === "-h" || a === "--help" || a === "help") throw new Error(launchHelp())
    throw tip(`unknown flag: ${a}`, "aq launch --help")
  }

  if (!on) {
    const names = listPlaceNames()
    const known = names.length ? `known: ${names.join(", ")}` : "none yet — aq add ssh"
    throw tip("need --on <place>", `${known}`)
  }
  return { dir, on, setup, shell, command: sawDash ? command : null, ports }
}

type FolderOpt = { label: string; abs: string }

/** Fast listing — no recursive size walk (that froze the folder prompt). */
function listFolderOptions(cwd: string): FolderOpt[] {
  const opts: FolderOpt[] = [{ label: ".", abs: cwd }]

  let kids: string[] = []
  try {
    kids = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort()
      .slice(0, 9)
  } catch {
    kids = []
  }
  for (const name of kids) {
    opts.push({ label: "./" + name, abs: path.join(cwd, name) })
  }
  return opts
}

/** Pick sync folder — same prompt vibe as `aq add`. */
async function pickFolder(explicit: string | null): Promise<string> {
  if (explicit) return resolveDir(explicit)

  const cwd = resolveDir(".")
  if (!stdout.isTTY || !stdin.isTTY) return cwd

  const opts = listFolderOptions(cwd)
  console.log(c.bold("folder"))
  for (let i = 0; i < opts.length; i++) {
    console.log("  " + c.dim(String(i + 1).padStart(2)) + "  " + c.cyan(opts[i].label))
  }
  console.log(c.dim("  or type a path"))

  const ans = await prompt("folder", "1")
  const n = Number(ans)
  if (Number.isFinite(n) && n >= 1 && n <= opts.length) {
    return opts[n - 1].abs
  }
  return resolveDir(ans || ".")
}

async function pickProfile(): Promise<SyncProfile> {
  if (!stdout.isTTY || !stdin.isTTY) return "defaults"

  console.log(c.bold("skip"))
  console.log("  " + c.dim("1") + "  " + c.cyan("defaults") + c.dim("  .git node_modules .venv .next checkpoints"))
  console.log("  " + c.dim("2") + "  " + c.cyan("lean") + c.dim("      + data wandb runs *.pt *.ckpt"))
  console.log("  " + c.dim("3") + "  " + c.cyan("minimal") + c.dim("  only .git node_modules"))

  const ans = await prompt("skip", "1")
  if (ans === "2" || ans === "lean") return "lean"
  if (ans === "3" || ans === "minimal") return "minimal"
  return "defaults"
}

export async function launchCmd(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  const { dir, on, setup, shell, command, ports } = parseLaunch(argv)
  let resolved
  try {
    resolved = resolveSshTarget(on)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown place")) {
      throw tip(e.message.split("\n")[0], "aq places · aq add ssh · aq add pool")
    }
    throw e
  }
  const place = resolved.place

  console.log(
    c.bold("launch") +
      "  " +
      describePick(resolved) +
      c.dim("  ssh  ") +
      (place.user ? `${place.user}@` : "") +
      place.host,
  )

  const local = await pickFolder(dir)
  const profile = await pickProfile()
  const remoteDir = remoteTrainDir(local)

  console.log(c.dim("  ") + local + " → " + remoteDir)

  await rsyncToRemote(local, place, remoteDir, profile)

  if (setup) {
    await setupAqOnRemote(place)
  } else {
    console.log(c.yellow("setup") + c.dim("  skipped"))
  }

  saveSession({
    place: on,
    member: resolved.viaPool ? resolved.name : undefined,
    train: local,
    remoteDir,
    at: new Date().toISOString(),
  })

  if (command && command.length) {
    step("run", command.join(" "))
    const code = runRemote(place, remoteDir, command)
    if (code !== 0) process.exitCode = code
    console.log(c.dim("next") + "  aq go   ·  aq jobs train --on " + on)
    return
  }

  if (shell || ports.length) {
    if (ports.length) {
      for (const p of ports) {
        console.log(c.dim("  port") + "  " + p.local + " → " + p.remote + "  " + c.dim(forwardUrl(p)))
      }
    }
    step("shell", "cd " + remoteDir)
    const code = await sshInteractive(place, remoteDir, { forwards: ports })
    if (code !== 0) process.exitCode = code
    return
  }

  stepOk("ready", remoteDir)
  console.log(c.dim("next") + "  aq sync --on " + on + "   # from this laptop")
  console.log(c.dim("    ") + "  aq go                  # open SSH when you want a shell")
  console.log(c.dim("    ") + "  aq jobs train --on " + on)
}

export async function goCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  const ports: PortForward[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") {
      ports.push(parsePortForward(argv[++i] || ""))
      continue
    }
    rest.push(argv[i])
  }
  const session = loadSession()
  const name = rest[0] || session?.place
  if (!name) {
    throw tip("nothing to go to", "aq launch --on <place> first · aq places")
  }

  // Prefer sticky member from last launch on this pool; else pick fresh
  let resolved
  try {
    if (session?.place === name && session.member) {
      resolved = resolveSshTarget(session.member)
      resolved = { ...resolved, requested: name, viaPool: name }
    } else {
      resolved = resolveSshTarget(name)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown place")) {
      throw tip(e.message.split("\n")[0], "aq places · aq add ssh")
    }
    throw e
  }
  const place = resolved.place

  let remoteDir = session?.remoteDir
  let local = session?.train
  if (session?.place !== name || !remoteDir) {
    local = resolveDir(".")
    remoteDir = remoteTrainDir(local)
  }

  console.log(c.bold("go") + "  " + describePick(resolved))
  console.log(c.dim("  ") + (local || remoteDir) + " → " + remoteDir)

  if (local && existsSync(local) && statSync(local).isDirectory()) {
    await rsyncToRemote(local, place, remoteDir)
    saveSession({
      place: name,
      member: resolved.viaPool ? resolved.name : session?.member,
      train: local,
      remoteDir,
      at: new Date().toISOString(),
    })
  }

  if (ports.length) {
    for (const p of ports) {
      console.log(c.dim("  port") + "  " + p.local + " → " + p.remote + "  " + c.dim(forwardUrl(p)))
    }
  }
  step("shell", "cd " + remoteDir)
  const code = await sshInteractive(place, remoteDir, { forwards: ports })
  if (code !== 0) process.exitCode = code
}

export async function syncCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  let dir: string | null = null
  let on = ""
  let profile: SyncProfile = "defaults"
  let i = 0
  if (argv[0] && !argv[0].startsWith("-")) {
    const cand = path.resolve(argv[0])
    if (existsSync(cand) && statSync(cand).isDirectory()) {
      dir = argv[0]
      i = 1
    }
  }
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--on") {
      on = argv[i + 1] || ""
      i += 2
      continue
    }
    if (a === "--lean") {
      profile = "lean"
      i += 1
      continue
    }
    if (a === "--minimal") {
      profile = "minimal"
      i += 1
      continue
    }
    if (a === "--profile") {
      const v = argv[i + 1] as SyncProfile
      if (v !== "defaults" && v !== "lean" && v !== "minimal") {
        throw tip("bad --profile", "defaults | lean | minimal")
      }
      profile = v
      i += 2
      continue
    }
    throw tip(`unknown: ${a}`, "aq sync [dir] --on <place>")
  }

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
      throw tip(e.message.split("\n")[0], "aq places · aq add ssh")
    }
    throw e
  }

  const local = resolveDir(dir || session?.train || ".")
  const remoteDir =
    session &&
    (session.place === placeName || session.member === resolved.name) &&
    session.remoteDir &&
    path.basename(session.remoteDir.replace(/\/$/, "")) === path.basename(local)
      ? session.remoteDir
      : remoteTrainDir(local)

  console.log(c.bold("sync") + "  " + describePick(resolved) + c.dim(`  (${profile})`))
  console.log(c.dim("  ") + local + " → " + remoteDir)
  await rsyncToRemote(local, resolved.place, remoteDir, profile)
  saveSession({
    place: placeName,
    member: resolved.viaPool ? resolved.name : session?.member,
    train: local,
    remoteDir,
    at: new Date().toISOString(),
  })
  stepOk("sync", "pushed  " + c.cyan(path.basename(local)))
  console.log(c.dim("next") + "  aq jobs train --on " + placeName + " · aq go")
}

export async function shutdownCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  let wipe = false
  let name = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--wipe") {
      wipe = true
      continue
    }
    if (!a.startsWith("-") && !name) {
      name = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq shutdown [place] [--wipe]")
  }

  const session = loadSession()
  const placeName = name || session?.place
  if (!placeName) throw tip("nothing to shut down", "aq launch --on <place> · aq places")

  let resolved
  try {
    if (session?.place === placeName && session.member) {
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

  const remoteDir = session?.remoteDir || remoteTrainDir(session?.train || process.cwd())
  console.log(c.bold("shutdown") + "  " + describePick(resolved))

  step("shutdown", "stop jobs")
  const killed = cancelJobsOnPlace(resolved.place, resolved.name, remoteDir)
  if (killed.length) stepOk("shutdown", "canceled  " + killed.map((id) => c.cyan(id)).join(" "))
  else console.log(c.dim("  no running jobs on this remoteDir"))

  if (wipe) {
    step("shutdown", "wipe  " + remoteDir)
    const r = sshExec(resolved.place, `rm -rf ${remoteShellPath(remoteDir)}`, { timeoutMs: 60_000 })
    if (r.status !== 0) {
      throw tip(
        `wipe failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "ssh error"}`,
        "check SSH · aq places",
      )
    }
    stepOk("shutdown", "wiped  " + remoteDir)
  }

  if (!name || session?.place === placeName) clearSession()
  stepOk("shutdown", "session cleared")
  console.log(c.dim("next") + "  aq launch --on <place>  when you want the box again")
}
