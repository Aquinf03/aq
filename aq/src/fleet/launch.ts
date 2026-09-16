/** aq launch / aq go — sync train to a place, optional setup, land in SSH. */

import path from "node:path"
import { assertTrain, isTrain } from "../core/schema.js"
import {
  getPlace,
  loadSession,
  remoteTrainDir,
  saveSession,
  type SshPlace,
} from "./places.js"
import { rsyncToRemote, runRemote, setupAqOnRemote, sshInteractive } from "./ssh.js"

function launchHelp(): string {
  return [
    "aq launch [dir] --on <place> [--setup|--no-setup] [-- <cmd>…]",
    "  sync this train to the place, install aq (default), then SSH there",
    "  --no-setup   skip aq install on the remote",
    "  -- <cmd>     run cmd on the remote instead of opening a shell",
    "",
    "aq go [place]   re-SSH to last launch (or that place + last train)",
  ].join("\n")
}

function parseLaunch(argv: string[]): {
  dir: string
  on: string
  setup: boolean
  command: string[] | null
} {
  let dir = "."
  let on = ""
  let setup = true
  let i = 0
  const command: string[] = []
  let sawDash = false

  if (argv[0] && !argv[0].startsWith("-") && argv[0] !== "--") {
    if (isTrain(path.resolve(argv[0]))) {
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
      if (!v || v.startsWith("-")) throw new Error(launchHelp())
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
    if (a === "-h" || a === "--help" || a === "help") throw new Error(launchHelp())
    throw new Error(`unknown flag: ${a}\n${launchHelp()}`)
  }

  if (!on) throw new Error(`need --on <place>\n${launchHelp()}`)
  return { dir, on, setup, command: sawDash ? command : null }
}

export async function launchCmd(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(launchHelp())
    return
  }
  const { dir, on, setup, command } = parseLaunch(argv)
  const train = assertTrain(dir)
  const place = getPlace(on)
  if (place.kind !== "ssh") {
    throw new Error(`place ${on} is ${place.kind} — only ssh is supported in this MVP`)
  }
  const remoteDir = remoteTrainDir(train)

  console.log("launch")
  console.log("  " + on + "  ssh  " + (place.user ? `${place.user}@` : "") + place.host)
  console.log("  " + train)
  console.log("  → " + remoteDir)

  console.log("sync")
  rsyncToRemote(train, place, remoteDir)

  if (setup) {
    setupAqOnRemote(place)
  } else {
    console.log("setup")
    console.log("  skipped (--no-setup)")
  }

  saveSession({
    place: on,
    train,
    remoteDir,
    at: new Date().toISOString(),
  })

  if (command && command.length) {
    console.log("run")
    console.log("  " + command.join(" "))
    const code = runRemote(place, remoteDir, command)
    if (code !== 0) process.exitCode = code
    console.log("shell")
    console.log("  aq go")
    return
  }

  console.log("shell")
  console.log("  cd " + remoteDir + " · aq on PATH if setup ran")
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
    throw new Error("nothing to go to — aq launch --on <place> first")
  }
  const place = getPlace(name)
  if (place.kind !== "ssh") {
    throw new Error(`place ${name} is ${place.kind} — only ssh supported`)
  }

  let remoteDir = session?.remoteDir
  let train = session?.train
  if (session?.place !== name || !remoteDir) {
    const local = assertTrain(".")
    remoteDir = remoteTrainDir(local)
    train = local
  }

  console.log("go")
  console.log("  " + name)
  console.log("  " + (train || remoteDir))
  console.log("  → " + remoteDir)

  // Refresh sync if we still have the train locally
  if (train && isTrain(train)) {
    console.log("sync")
    rsyncToRemote(train, place as SshPlace, remoteDir)
    saveSession({
      place: name,
      train,
      remoteDir,
      at: new Date().toISOString(),
    })
  }

  const code = await sshInteractive(place as SshPlace, remoteDir)
  if (code !== 0) process.exitCode = code
}
