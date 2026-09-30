#!/usr/bin/env node
/** aq framework CLI — train / eval / fleet. Agent chat is the separate `aq-agent` package. */

import path from "node:path"
import { init, resolveInitRoot } from "./handle/init.js"
import { diffRuns } from "./handle/diff.js"
import { data } from "./handle/data.js"
import { plot } from "./handle/plot.js"
import { checkpoint, evalCmd, serve, train } from "./handle/step.js"
import { status } from "./handle/status.js"
import { track } from "./handle/track.js"
import { addCmd, placesCmd } from "./fleet/add.js"
import { goCmd, launchCmd, shutdownCmd, syncCmd } from "./fleet/launch.js"
import { jobsCmd } from "./fleet/jobs.js"
import { queueCmd } from "./fleet/queue.js"
import { portCmd } from "./fleet/port.js"
import { tagCmd } from "./fleet/tag.js"
import { loginCmd, logoutCmd, switchCmd } from "./handle/login.js"
import { updateCmd } from "./handle/update.js"
import { versionReport } from "./core/version.js"
import { InterruptedError } from "./core/python.js"
import { help } from "./help.js"

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    const verbose =
      cmd === "version" && (argv.includes("--verbose") || argv.includes("-V") || argv.slice(1).includes("-v"))
    console.log(versionReport(verbose))
    return
  }
  if (cmd === "update") {
    await updateCmd(argv.slice(1))
    return
  }
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(help())
    return
  }

  if (cmd === "init") {
    const root = resolveInitRoot(argv[1])
    const { created, skipped } = await init(root)
    const rel = path.relative(process.cwd(), root) || root
    console.log("run")
    console.log("  " + rel)
    console.log("  recipe.yaml + example.py + artifacts/ — YAML and/or SDK")
    if (created.length) {
      console.log("created")
      for (const f of created) console.log("  " + f)
    }
    if (skipped.length) {
      console.log("already there")
      for (const f of skipped) console.log("  " + f)
    }
    if (!created.length && skipped.length) {
      console.log("already initialized. edit recipe.yaml / example.py.")
    } else {
      console.log("next")
      console.log("  cd " + rel)
      console.log("  edit recipe.yaml  (or Aquin.define in example.py)")
      console.log("  python example.py   # or: aq train && aq eval")
    }
    return
  }

  if (cmd === "data") {
    await data(argv.slice(1))
    return
  }

  if (cmd === "train") {
    await train(argv.slice(1))
    return
  }

  if (cmd === "eval") {
    await evalCmd(argv.slice(1))
    return
  }

  if (cmd === "checkpoint") {
    await checkpoint(argv.slice(1))
    return
  }

  if (cmd === "serve") {
    await serve(argv.slice(1))
    return
  }

  if (cmd === "diff") {
    await diffRuns(argv.slice(1))
    return
  }

  if (cmd === "status") {
    await status(argv.slice(1))
    return
  }

  if (cmd === "track") {
    await track(argv.slice(1))
    return
  }

  if (cmd === "plot") {
    await plot(argv.slice(1))
    return
  }

  if (cmd === "login") {
    await loginCmd(argv.slice(1))
    return
  }

  if (cmd === "logout") {
    await logoutCmd(argv.slice(1))
    return
  }

  if (cmd === "switch") {
    await switchCmd(argv.slice(1))
    return
  }

  if (cmd === "add") {
    await addCmd(argv.slice(1))
    return
  }

  if (cmd === "places") {
    await placesCmd(argv.slice(1))
    return
  }

  if (cmd === "launch") {
    await launchCmd(argv.slice(1))
    return
  }

  if (cmd === "go") {
    await goCmd(argv.slice(1))
    return
  }

  if (cmd === "sync") {
    await syncCmd(argv.slice(1))
    return
  }

  if (cmd === "shutdown" || cmd === "teardown") {
    await shutdownCmd(argv.slice(1))
    return
  }

  if (cmd === "jobs") {
    await jobsCmd(argv.slice(1))
    return
  }

  if (cmd === "queue" || cmd === "queues") {
    await queueCmd(argv.slice(1))
    return
  }

  if (cmd === "port" || cmd === "ports" || cmd === "tunnel") {
    await portCmd(argv.slice(1))
    return
  }

  if (cmd === "tag" || cmd === "tags" || cmd === "label" || cmd === "labels") {
    await tagCmd(argv.slice(1))
    return
  }

  if (
    cmd === "agent" ||
    cmd === "ask" ||
    cmd === "chat" ||
    cmd === "provider" ||
    cmd === "doctor" ||
    cmd === "spawn"
  ) {
    console.error(`'aq ${cmd}' moved to the aq-agent package.`)
    console.error("  cd agent && npm i && npm link   # or: npx aq-agent …")
    console.error(`  aq-agent ${cmd === "agent" ? "" : cmd + " "}…`)
    process.exitCode = 1
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.error("aq help")
  process.exitCode = 1
}

main().catch((err: unknown) => {
  if (err instanceof InterruptedError) {
    process.exitCode = err.exitCode
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exitCode = 1
})
