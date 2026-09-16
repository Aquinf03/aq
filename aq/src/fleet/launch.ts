/** aq launch / aq go — sync a folder to a place, optional setup, land in SSH. */

import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import {
  getPlace,
  listPlaceNames,
  loadSession,
  remoteTrainDir,
  saveSession,
  type SshPlace,
} from "./places.js"
import { estimateSync, rsyncToRemote, runRemote, setupAqOnRemote, sshInteractive } from "./ssh.js"
import { c, confirm, fmtBytes, step } from "./ui.js"

/** Prompt when payload is bigger than a typical train folder. */
const BIG_FILES = 1500
const BIG_BYTES = 30 * 1024 * 1024

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function launchHelp(): string {
  return [
    "aq launch [dir] --on <place> [-y] [--setup|--no-setup] [-- <cmd>…]",
    "  sync that folder (default: .) to the place, install aq, then SSH",
    "  pass a train dir — don't launch from a huge monorepo root",
    "  -y / --yes   skip the big-folder confirm",
    "  --no-setup   skip aq install on the remote",
    "  -- <cmd>     run cmd on the remote instead of opening a shell",
    "",
    "aq go [place]   re-SSH to last launch (resync when local folder exists)",
  ].join("\n")
}

function resolveDir(dir: string): string {
  const root = path.resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw tip(`not a directory: ${root}`, "cd into a folder, or pass one: aq launch ./my-run --on <place>")
  }
  return root
}

function parseLaunch(argv: string[]): {
  dir: string
  on: string
  setup: boolean
  yes: boolean
  command: string[] | null
} {
  let dir = "."
  let on = ""
  let setup = true
  let yes = false
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
    if (a === "-y" || a === "--yes") {
      yes = true
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
  return { dir, on, setup, yes, command: sawDash ? command : null }
}

function childDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .slice(0, 8)
  } catch {
    return []
  }
}

/** Stop monorepo slam-dunks: show size and ask before syncing a huge tree. */
async function confirmBigSync(local: string, yes: boolean): Promise<boolean> {
  const { files, bytes } = estimateSync(local)
  const big = files >= BIG_FILES || bytes >= BIG_BYTES
  console.log(
    c.dim("  ") + fmtBytes(bytes) + " · " + files + " files" + (big ? c.yellow("  (looks big)") : ""),
  )
  if (!big || yes) return true

  const kids = childDirs(local)
  if (kids.length >= 2) {
    console.log(c.dim("  tip") + "  sync a train folder, not the whole repo:")
    console.log(c.dim("       ") + "aq launch ./" + kids[0] + " --on <place>")
    if (kids.length > 1) {
      console.log(c.dim("       ") + "or: " + kids.slice(0, 5).map((k) => "./" + k).join("  "))
    }
  } else {
    console.log(c.dim("  tip") + "  aq launch ./my-run --on <place>")
  }

  return confirm("sync this folder anyway?", false)
}

export async function launchCmd(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  const { dir, on, setup, yes, command } = parseLaunch(argv)
  const local = resolveDir(dir)
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
  const remoteDir = remoteTrainDir(local)

  console.log(c.bold("launch") + "  " + c.cyan(on) + c.dim("  ssh  ") + (place.user ? `${place.user}@` : "") + place.host)
  console.log(c.dim("  ") + local + " → " + remoteDir)

  if (!(await confirmBigSync(local, yes))) {
    console.log(c.yellow("aborted"))
    return
  }

  await rsyncToRemote(local, place, remoteDir)

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
