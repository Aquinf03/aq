import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export function exists(p) {
  return existsSync(p)
}

export function read(p) {
  return readFileSync(p, "utf8")
}

export function sha(p) {
  if (!existsSync(p)) return ""
  return createHash("sha256").update(readFileSync(p)).digest("hex")
}

export function dirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => !n.startsWith("."))
}

function parseArgs(raw) {
  const s = String(raw || "").trim()
  if (!s) return {}
  try {
    const o = JSON.parse(s)
    if (o && typeof o === "object") return o
  } catch {
    /* plain */
  }
  return { raw: s }
}

export function argText(raw) {
  const o = parseArgs(raw)
  const bits = [o.args, o.command, o.name, o.path, o.raw, typeof raw === "string" ? raw : ""]
  return bits.filter((x) => typeof x === "string").join(" ")
}

export function usedAq(tools, verb) {
  return tools.some((t) => {
    if (t.name === `aq_${verb}`) return true
    if (t.name === "aq") {
      const a = argText(t.args).trim().split(/\s+/)
      return a[0] === verb
    }
    if (t.name === "run") return new RegExp(`\\baq\\s+${verb}\\b`).test(argText(t.args))
    return false
  })
}

export function firstAq(tools, verb) {
  return tools.findIndex((t) => {
    if (t.name === `aq_${verb}`) return true
    if (t.name === "aq") return argText(t.args).trim().split(/\s+/)[0] === verb
    if (t.name === "run") return new RegExp(`\\baq\\s+${verb}\\b`).test(argText(t.args))
    return false
  })
}

export function usedNamed(tools, name, needle) {
  return tools.some((t) => {
    if (t.name !== name) return false
    if (!needle) return true
    return argText(t.args).includes(needle)
  })
}

export function checkpoint(train) {
  return existsSync(path.join(train, "artifacts", "checkpoints", "last.json"))
}

export function evalRecord(train) {
  const p = path.join(train, "artifacts", "eval.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

export function sameFile(origin, train, rel) {
  const now = path.join(train, rel)
  if (!origin[rel]) return !existsSync(now)
  if (!existsSync(now)) return false
  return Buffer.compare(origin[rel], readFileSync(now)) === 0
}

export function jobs(train) {
  const root = path.join(train, "jobs")
  if (!existsSync(root)) return []
  return readdirSync(root).filter((id) => {
    if (id.startsWith(".")) return false
    return existsSync(path.join(root, id, "spec.json"))
  })
}

export function treeFiles(root, rel = "") {
  const dir = rel ? path.join(root, rel) : root
  if (!existsSync(dir)) return []
  const st = statSync(dir)
  if (!st.isDirectory()) return [rel]
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue
    const child = rel ? `${rel}/${name}` : name
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...treeFiles(root, child))
    else out.push(child)
  }
  return out
}
