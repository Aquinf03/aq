/** Walk the train: list dirs, find paths, read files. Stays inside the train. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { insideTrain } from "../core/paths.js"

const SKIP = new Set([".git", "node_modules", "dist"])
const MAX_HITS = 80
const MAX_BYTES = 8000

function globToRe(pat: string): RegExp {
  const esc = pat.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")
  return new RegExp(`^${esc}$`, "i")
}

function matches(rel: string, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  const base = path.basename(rel)
  if (q.includes("*")) {
    const re = globToRe(q.replace(/\\/g, "/"))
    return re.test(rel) || re.test(base)
  }
  const n = q.toLowerCase()
  return rel.toLowerCase().includes(n) || base.toLowerCase().includes(n)
}

function walk(root: string, dir: string, query: string, hits: string[], depth: number): void {
  if (hits.length >= MAX_HITS || depth > 16) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(".") && name !== ".") continue
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    const rel = path.relative(root, full).replace(/\\/g, "/")
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (matches(rel + "/", query) || matches(rel, query)) hits.push(rel + "/")
      walk(root, full, query, hits, depth + 1)
    } else if (st.isFile() && matches(rel, query)) {
      hits.push(rel)
    }
    if (hits.length >= MAX_HITS) return
  }
}

export function ls(train: string, rel = "."): string {
  const d = insideTrain(train, rel || ".")
  if (!existsSync(d)) throw new Error(`no path ${rel}`)
  const st = statSync(d)
  if (st.isFile()) return `file  ${rel || path.basename(d)}`
  const names = readdirSync(d)
    .filter((n) => !n.startsWith(".") && !SKIP.has(n))
    .sort()
  if (!names.length) return "(empty)"
  const lines: string[] = []
  for (const name of names) {
    const full = path.join(d, name)
    try {
      const s = statSync(full)
      lines.push(s.isDirectory() ? `${name}/` : name)
    } catch {
      lines.push(name)
    }
  }
  return lines.join("\n")
}

export function find(train: string, query: string, rootRel = "."): string {
  const root = path.resolve(train)
  const start = insideTrain(train, rootRel || ".")
  if (!existsSync(start)) throw new Error(`no path ${rootRel}`)
  const hits: string[] = []
  const st = statSync(start)
  if (st.isFile()) return path.relative(root, start).replace(/\\/g, "/")
  walk(root, start, query, hits, 0)
  if (!hits.length) return "no matches"
  const extra = hits.length >= MAX_HITS ? `\n… truncated at ${MAX_HITS}` : ""
  return hits.join("\n") + extra
}

export function glob(train: string, pattern: string, rootRel = "."): string {
  return find(train, pattern.includes("*") ? pattern : `**/${pattern}`, rootRel)
}

export function grep(
  train: string,
  query: string,
  rootRel = ".",
  fileGlob = "",
): string {
  const q = query.trim()
  if (!q) throw new Error("need query")
  let re: RegExp
  try {
    re = new RegExp(q, "i")
  } catch {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }
  const root = path.resolve(train)
  const start = insideTrain(train, rootRel || ".")
  if (!existsSync(start)) throw new Error(`no path ${rootRel}`)
  const files: string[] = []
  const st = statSync(start)
  if (st.isFile()) files.push(path.relative(root, start).replace(/\\/g, "/"))
  else walk(root, start, fileGlob || "", files, 0)
  const lines: string[] = []
  for (const rel of files) {
    if (rel.endsWith("/")) continue
    if (fileGlob && !matches(rel, fileGlob) && !matches(path.basename(rel), fileGlob)) continue
    const full = path.join(root, rel)
    let buf: Buffer
    try {
      buf = readFileSync(full)
    } catch {
      continue
    }
    if (buf.length > 400_000 || buf.includes(0)) continue
    const text = buf.toString("utf8")
    const rows = text.split("\n")
    for (let i = 0; i < rows.length; i++) {
      if (!re.test(rows[i]!)) continue
      const snippet = rows[i]!.trim().slice(0, 160)
      lines.push(`${rel}:${i + 1}: ${snippet}`)
      if (lines.length >= MAX_HITS) {
        return lines.join("\n") + `\n… truncated at ${MAX_HITS}`
      }
    }
  }
  return lines.length ? lines.join("\n") : "no matches"
}

export function readPath(train: string, rel: string): string {
  const p = insideTrain(train, rel)
  if (!existsSync(p)) throw new Error(`no path ${rel}`)
  const st = statSync(p)
  if (st.isDirectory()) return ls(train, rel)
  const buf = readFileSync(p)
  if (buf.includes(0)) return `binary  ${rel}  ${buf.length} bytes`
  const text = buf.toString("utf8")
  if (text.length > MAX_BYTES) return text.slice(0, MAX_BYTES) + "\n…"
  return text
}
