/** aq launch / aq go — sync a folder to a place, optional setup, land in SSH. */

import { existsSync, readdirSync, statSync } from "node:fs"
import { stdin, stdout } from "node:process"
import path from "node:path"
import {
  getPlace,
  listPlaceNames,
  loadSession,
  remoteTrainDir,
  saveSession,
  type SshPlace,
} from "./places.js"
import {
  estimateSync,
  rsyncToRemote,
  runRemote,
  setupAqOnRemote,
  sshInteractive,
  type SyncProfile,
} from "./ssh.js"
import { c, fmtBytes, prompt, step } from "./ui.js"

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function launchHelp(): string {
  return [
    "aq launch [dir] --on <place> [--setup|--no-setup] [-- <cmd>…]",
    "  pick a folder (prompts, like aq add), sync it, install aq, then SSH",
    "  pass [dir] to skip the folder prompt",
    "  --no-setup   skip aq install on the remote",
    "  -- <cmd>     run cmd on the remote instead of opening a shell",
    "",
    "aq go [place]   re-SSH to last launch (resync when local folder exists)",
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
  command: string[] | null
} {
  let dir: string | null = null
  let on = ""
  let setup = true
  let i = 0
  const command: string[] = []
  let sawDash = false

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
  return { dir, on, setup, command: sawDash ? command : null }
}

type FolderOpt = { label: string; abs: string; files: number; bytes: number }

function listFolderOptions(cwd: string): FolderOpt[] {
  const opts: FolderOpt[] = []
  const here = estimateSync(cwd)
  opts.push({ label: ".", abs: cwd, files: here.files, bytes: here.bytes })

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
    const abs = path.join(cwd, name)
    const est = estimateSync(abs)
    opts.push({ label: "./" + name, abs, files: est.files, bytes: est.bytes })
  }
  return opts
}

function fmtOpt(o: FolderOpt): string {
  return (
    c.cyan(o.label.padEnd(16)) +
    c.dim(fmtBytes(o.bytes) + " · " + o.files + " files")
  )
}

/** Pick sync folder — same prompt vibe as `aq add`. */
async function pickFolder(explicit: string | null): Promise<string> {
  if (explicit) return resolveDir(explicit)

  const cwd = resolveDir(".")
  if (!stdout.isTTY || !stdin.isTTY) return cwd

  const opts = listFolderOptions(cwd)
  console.log(c.bold("folder"))
  for (let i = 0; i < opts.length; i++) {
    console.log("  " + c.dim(String(i + 1).padStart(2)) + "  " + fmtOpt(opts[i]))
  }
  console.log(c.dim("  or type a path"))

  // Prefer a small child over slamming `.` when `.` is huge
  let def = "1"
  if (opts.length > 1 && (opts[0].files >= 1500 || opts[0].bytes >= 30 * 1024 * 1024)) {
    const best = opts
      .slice(1)
      .reduce((a, b) => (a.bytes <= b.bytes ? a : b), opts[1])
    def = String(opts.indexOf(best) + 1)
  }

  const ans = await prompt("folder", def)
  const n = Number(ans)
  if (Number.isFinite(n) && n >= 1 && n <= opts.length) {
    return opts[n - 1].abs
  }
  return resolveDir(ans)
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
  const { dir, on, setup, command } = parseLaunch(argv)
  let place: SshPlace
  try {
    const p = getPlace(on)
    if (p.kind !== "ssh") {
      throw tip(`place ${on} is ${p.kind}`, "only ssh works for now — aq add ssh")
    }
    place = p
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown place")) {
      throw tip(e.message.split("\n")[0], "aq places · aq add ssh")
    }
    throw e
  }

  console.log(c.bold("launch") + "  " + c.cyan(on) + c.dim("  ssh  ") + (place.user ? `${place.user}@` : "") + place.host)

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
    train: local,
    remoteDir,
    at: new Date().toISOString(),
  })

  if (command && command.length) {
    step("run", command.join(" "))
    const code = runRemote(place, remoteDir, command)
    if (code !== 0) process.exitCode = code
    console.log(c.dim("next") + "  aq go")
    return
  }

  step("shell", "cd " + remoteDir)
  const code = await sshInteractive(place, remoteDir)
  if (code !== 0) process.exitCode = code
}

export async function goCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  const session = loadSession()
  const name = argv[0] || session?.place
  if (!name) {
    throw tip("nothing to go to", "aq launch --on <place> first · aq places")
  }
  let place: SshPlace
  try {
    const p = getPlace(name)
    if (p.kind !== "ssh") {
      throw tip(`place ${name} is ${p.kind}`, "only ssh works for now")
    }
    place = p
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown place")) {
      throw tip(e.message.split("\n")[0], "aq places · aq add ssh")
    }
    throw e
  }

  let remoteDir = session?.remoteDir
  let local = session?.train
  if (session?.place !== name || !remoteDir) {
    local = resolveDir(".")
    remoteDir = remoteTrainDir(local)
  }

  console.log(c.bold("go") + "  " + c.cyan(name))
  console.log(c.dim("  ") + (local || remoteDir) + " → " + remoteDir)

  if (local && existsSync(local) && statSync(local).isDirectory()) {
    await rsyncToRemote(local, place, remoteDir)
    saveSession({
      place: name,
      train: local,
      remoteDir,
      at: new Date().toISOString(),
    })
  }

  step("shell", "cd " + remoteDir)
  const code = await sshInteractive(place, remoteDir)
  if (code !== 0) process.exitCode = code
}
