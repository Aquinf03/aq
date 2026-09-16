/** aq add — register a compute place (SSH first). */

import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline"
import { getPlace, loadPlaces, placesPath, upsertPlace } from "./places.js"
import { sshCheck } from "./ssh.js"

function prompt(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  const hint = fallback ? ` [${fallback}]` : ""
  return new Promise((resolve) => {
    rl.question(question + hint + ": ", (ans) => {
      rl.close()
      const v = ans.trim()
      resolve(v || fallback)
    })
  })
}

function addHelp(): string {
  return [
    "aq add ssh [name]     register an SSH place (prompts for host/user)",
    "aq places             list places",
    "",
    "Places file: " + placesPath(),
    "Later: aq add k8s | aws | …",
  ].join("\n")
}

export async function placesCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(addHelp())
    return
  }
  const file = loadPlaces()
  const names = Object.keys(file.places).sort()
  if (!names.length) {
    console.log("no places")
    console.log("  aq add ssh")
    return
  }
  console.log("places")
  for (const name of names) {
    const p = file.places[name]
    if (p.kind === "ssh") {
      const who = p.user ? `${p.user}@${p.host}` : p.host
      const port = p.port && p.port !== 22 ? `:${p.port}` : ""
      console.log(`  ${name}  ssh  ${who}${port}`)
    } else {
      console.log(`  ${name}  ${(p as { kind: string }).kind}`)
    }
  }
}

export async function addCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(addHelp())
    return
  }
  if (sub === "ssh") {
    await addSsh(argv.slice(1))
    return
  }
  throw new Error(`unknown add kind: ${sub}\n${addHelp()}`)
}

async function addSsh(argv: string[]): Promise<void> {
  let name = argv[0]
  if (!name) name = await prompt("place name", "lab")
  if (!name) throw new Error("need a place name")

  const existing = (() => {
    try {
      return getPlace(name)
    } catch {
      return null
    }
  })()

  const host = await prompt("ssh host", existing?.kind === "ssh" ? existing.host : "")
  if (!host) throw new Error("need a host")
  const user = await prompt(
    "ssh user (empty = default)",
    existing?.kind === "ssh" ? existing.user || "" : "",
  )
  const portRaw = await prompt(
    "ssh port",
    existing?.kind === "ssh" && existing.port ? String(existing.port) : "22",
  )
  const port = Number(portRaw || "22")
  if (!Number.isFinite(port) || port < 1) throw new Error(`bad port: ${portRaw}`)
  const key = await prompt(
    "ssh key path (empty = agent/default)",
    existing?.kind === "ssh" ? existing.key || "" : "",
  )

  upsertPlace(name, {
    kind: "ssh",
    host,
    user: user || undefined,
    port: port === 22 ? undefined : port,
    key: key || undefined,
  })

  console.log("place")
  console.log("  " + name)
  console.log("  " + placesPath())

  const place = getPlace(name)
  if (place.kind !== "ssh") return
  process.stdout.write("check … ")
  const c = sshCheck(place)
  if (c.ok) {
    console.log("ok")
    console.log("  " + c.detail)
  } else {
    console.log("fail")
    console.log("  " + c.detail)
    console.log("  fix SSH, then: aq launch --on " + name)
  }
  console.log("next")
  console.log("  cd <train> && aq launch --on " + name)
}
