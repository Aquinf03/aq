#!/usr/bin/env node

import path from "node:path"
import { checkout, parseCheckoutArgs } from "./handle/checkout.js"
import { fork, parseForkArgs } from "./handle/fork.js"
import { init, resolveInitRoot } from "./handle/init.js"
import { diffRuns } from "./handle/diff.js"
import { data } from "./handle/data.js"
import { plot } from "./handle/plot.js"
import { job } from "./job/job.js"
import { checkpoint, evalCmd, serve, train } from "./handle/step.js"
import { status } from "./handle/status.js"
import { stage } from "./handle/stage.js"
import { tool } from "./handle/tool.js"
import { runAgent } from "./agent/agent.js"
import { ask } from "./agent/ask.js"
import { chatCmd } from "./agent/chat.js"
import { providerCmd } from "./agent/provider.js"
import { doctorCmd } from "./agent/doctor.js"
import { spawnCmd } from "./agent/spawn.js"
import { loginCmd, logoutCmd, switchCmd } from "./handle/login.js"
import { updateCmd } from "./handle/update.js"
import { versionReport } from "./core/version.js"
import { InterruptedError } from "./core/python.js"

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
  if (!cmd || cmd === "agent" || cmd === "help" || cmd === "-h" || cmd === "--help") {
    await runAgent(argv, process.cwd())
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

  if (cmd === "fork") {
    const plan = parseForkArgs(argv.slice(1))
    const out = await fork(plan)
    const relSrc = path.relative(process.cwd(), out.src) || out.src
    const relDest = path.relative(process.cwd(), out.dest) || out.dest
    console.log("forked")
    console.log("  " + relSrc)
    console.log("  -> " + relDest)
    return
  }

  if (cmd === "job") {
    await job(argv.slice(1))
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

  if (cmd === "tool") {
    await tool(argv.slice(1))
    return
  }

  if (cmd === "stage") {
    await stage(argv.slice(1))
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

  if (cmd === "schedule") {
    await job(["plan", ...argv.slice(1)])
    return
  }

  if (cmd === "plot") {
    await plot(argv.slice(1))
    return
  }

  if (cmd === "doctor") {
    await doctorCmd(argv.slice(1))
    return
  }

  if (cmd === "spawn") {
    await spawnCmd(argv.slice(1))
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

  if (cmd === "provider") {
    await providerCmd(argv.slice(1))
    return
  }

  if (cmd === "ask") {
    await ask(argv.slice(1))
    return
  }

  if (cmd === "chat") {
    await chatCmd(argv.slice(1))
    return
  }

  if (cmd === "checkout") {
    const { dir, id, dest } = parseCheckoutArgs(argv.slice(1))
    const out = await checkout(dir, id, dest)
    const rel = path.relative(process.cwd(), out.dest) || out.dest
    console.log("checked out")
    console.log("  " + out.id)
    console.log("  -> " + rel)
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
