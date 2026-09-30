#!/usr/bin/env node
/** aq-agent CLI — chat / ask / spawn. Framework verbs live in the separate `aq` package. */

import { runAgent } from "./agent/agent.js"
import { ask } from "./agent/ask.js"
import { chatCmd } from "./agent/chat.js"
import { providerCmd } from "./agent/provider.js"
import { doctorCmd } from "./agent/doctor.js"
import { spawnCmd } from "./agent/spawn.js"
import { versionReport } from "./core/version.js"
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

  if (!cmd || cmd === "agent" || cmd === "help" || cmd === "-h" || cmd === "--help") {
    await runAgent(argv, process.cwd())
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

  console.error(`unknown command: ${cmd}`)
  console.error("aq-agent help")
  process.exitCode = 1
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exitCode = 1
})
