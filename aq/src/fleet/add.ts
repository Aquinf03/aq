/** aq add — register a compute place (SSH first). */

import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline"
import { getPlace, loadPlaces, placesPath, upsertPlace } from "./places.js"
import { fixKeyPermissions, sshCheck } from "./ssh.js"
import { c } from "./ui.js"

function prompt(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  const hint = fallback ? c.dim(` [${fallback}]`) : ""
  return new Promise((resolve) => {
    rl.question(c.magenta(question) + hint + c.cyan(": "), (ans) => {
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
  const checkLive = !argv.includes("--no-check")
  const file = loadPlaces()
  const names = Object.keys(file.places).sort()
  if (!names.length) {
    console.log(c.yellow("no places"))
    console.log(c.dim("  tip") + "  aq add ssh")
    return
  }
  console.log(c.bold("places"))
  for (const name of names) {
    const p = file.places[name]
    if (p.kind === "ssh") {
      const who = p.user ? `${p.user}@${p.host}` : p.host
      const port = p.port && p.port !== 22 ? `:${p.port}` : ""
      let status = ""
      if (checkLive) {
        const r = sshCheck(p)
        status = r.ok ? c.green(" ok") : c.red(" fail")
      }
      console.log("  " + c.cyan(name) + "  " + c.dim("ssh") + "  " + who + port + status)
    } else {
      console.log("  " + c.cyan(name) + "  " + (p as { kind: string }).kind)
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

  // Blank prompts for a new place. Prefill only when re-adding the same name.
  const existing = (() => {
    try {
      return getPlace(name)
    } catch {
      return null
    }
  })()
  const prefill = argv[0] && existing?.kind === "ssh" ? existing : null

  const host = await prompt("ssh host", prefill?.host ?? "")
  if (!host) throw new Error("need a host")
  const user = await prompt("ssh user", prefill?.user ?? "")
  const portRaw = await prompt("ssh port", prefill?.port != null ? String(prefill.port) : "22")
  const port = Number(portRaw || "22")
  if (!Number.isFinite(port) || port < 1) throw new Error(`bad port: ${portRaw}`)
  const key = await prompt("ssh key path", prefill?.key ?? "")

  if (key) {
    if (fixKeyPermissions(key)) {
      console.log(c.yellow("key") + "  chmod 600 " + key)
    }
  }

  upsertPlace(name, {
    kind: "ssh",
    host,
    user: user || undefined,
    port: port === 22 ? undefined : port,
    key: key || undefined,
  })

  console.log(c.bold("place") + "  " + c.cyan(name))

  const place = getPlace(name)
  if (place.kind !== "ssh") return
  process.stdout.write(c.dim("check") + "  ")
  let check = sshCheck(place)
  if (!check.ok && place.key && /permissions too open/i.test(check.detail)) {
    if (fixKeyPermissions(place.key)) {
      console.log(c.yellow("fixing key perms…"))
      process.stdout.write(c.dim("check") + "  ")
      check = sshCheck(place)
    }
  }
  if (check.ok) {
    console.log(c.green("ok") + c.dim("  " + check.detail))
  } else {
    console.log(c.red("fail") + "  " + check.detail)
  }
  console.log(c.dim("next") + "  aq launch --on " + name)
}
