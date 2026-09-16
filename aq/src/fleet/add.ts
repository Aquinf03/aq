/** aq add — register a compute place (SSH first). */

import { getPlace, loadPlaces, placesPath, upsertPlace, type SshPlace } from "./places.js"
import {
  fixKeyPermissions,
  fmtPlaceResources,
  probeRemoteResources,
  sshCheck,
} from "./ssh.js"
import { c, prompt } from "./ui.js"

function addHelp(): string {
  return [
    "aq add ssh [name]     register an SSH place (prompts for host/user)",
    "aq places             list places (+ resources; --probe to refresh)",
    "",
    "Places file: " + placesPath(),
    "Later: aq add k8s | aws | …",
  ].join("\n")
}

function saveResources(name: string, place: SshPlace): SshPlace {
  process.stdout.write(c.dim("probe") + "  ")
  const res = probeRemoteResources(place)
  if (!res) {
    console.log(c.yellow("skip") + c.dim("  could not read cpu/gpu"))
    return place
  }
  const next: SshPlace = { ...place, resources: res }
  upsertPlace(name, next)
  console.log(c.green("ok") + "  " + fmtPlaceResources(res))
  if (res.gpu.kind === "none") {
    console.log(c.dim("  tip") + "  no GPU on this box — fine for CPU jobs")
  }
  return next
}

export async function placesCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(addHelp())
    return
  }
  const checkLive = !argv.includes("--no-check")
  const doProbe = argv.includes("--probe")
  const file = loadPlaces()
  const names = Object.keys(file.places).sort()
  if (!names.length) {
    console.log(c.yellow("no places"))
    console.log(c.dim("  tip") + "  aq add ssh")
    return
  }
  console.log(c.bold("places"))
  for (const name of names) {
    let p = file.places[name]
    if (p.kind === "ssh") {
      const who = p.user ? `${p.user}@${p.host}` : p.host
      const port = p.port && p.port !== 22 ? `:${p.port}` : ""
      let status = ""
      if (checkLive) {
        const r = sshCheck(p)
        status = r.ok ? c.green(" ok") : c.red(" fail")
        if (r.ok && (doProbe || !p.resources)) {
          const res = probeRemoteResources(p)
          if (res) {
            p = { ...p, resources: res }
            upsertPlace(name, p)
          }
        }
      } else if (doProbe) {
        const res = probeRemoteResources(p)
        if (res) {
          p = { ...p, resources: res }
          upsertPlace(name, p)
        }
      }
      const resTxt = p.resources ? c.dim("  " + fmtPlaceResources(p.resources)) : ""
      console.log("  " + c.cyan(name) + "  " + c.dim("ssh") + "  " + who + port + status + resTxt)
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
    resources: prefill?.resources,
  })

  console.log(c.bold("place") + "  " + c.cyan(name))

  let place = getPlace(name)
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
    place = saveResources(name, place)
  } else {
    console.log(c.red("fail") + "  " + check.detail)
  }
  console.log(c.dim("next") + "  aq launch --on " + name)
}
