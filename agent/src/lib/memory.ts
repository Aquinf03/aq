/** Agent memory lives in ~/.aq/memory/<train-id>/ like chats — not in the train folder. */

import { createHash, randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const EXTS = [".md", ".txt"]

export type MemorySpec = {
  id: string
  name: string
  train: string
  created: string
  updated: string
}

export type MemoryEntry = {
  id: string
  ts: string
  title: string
  content: string
}

function aqHome(): string {
  return path.join(homedir(), ".aq")
}

function root(): string {
  return path.join(aqHome(), "memory")
}

function trainKey(train: string): string {
  return path.resolve(train)
}

function memoryId(train: string): string {
  return createHash("sha256").update(trainKey(train)).digest("hex").slice(0, 16)
}

function memoryDir(train: string): string {
  return path.join(root(), memoryId(train))
}

function specPath(train: string): string {
  return path.join(memoryDir(train), "spec.json")
}

function entriesPath(train: string): string {
  return path.join(memoryDir(train), "entries.json")
}

function legacyDir(train: string): string {
  return path.join(train, "memory")
}

function safeTitle(name: string): string {
  const n = name.trim().replace(/\\/g, "/").split("/").pop() ?? ""
  const stem = n.replace(/\.(md|txt)$/i, "")
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,63}$/.test(stem)) {
    throw new Error(`bad memory title: ${name}`)
  }
  return stem
}

function readEntries(train: string): MemoryEntry[] {
  const p = entriesPath(train)
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as MemoryEntry[]
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

function writeEntries(train: string, spec: MemorySpec, entries: MemoryEntry[]): void {
  spec.updated = new Date().toISOString()
  mkdirSync(memoryDir(train), { recursive: true })
  writeFileSync(specPath(train), JSON.stringify(spec, null, 2) + "\n")
  writeFileSync(entriesPath(train), JSON.stringify(entries, null, 2) + "\n")
}

function ensureSpec(train: string): MemorySpec {
  migrateLegacy(train)
  const p = specPath(train)
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, "utf8")) as MemorySpec
  }
  const now = new Date().toISOString()
  const base = path.basename(trainKey(train)) || "train"
  const spec: MemorySpec = {
    id: memoryId(train),
    name: `${base} memory`,
    train: trainKey(train),
    created: now,
    updated: now,
  }
  writeEntries(train, spec, [])
  return spec
}

/** One-time: import train/memory/*.md into ~/.aq/memory and drop the empty folder. */
function migrateLegacy(train: string): void {
  const legacy = legacyDir(train)
  if (!existsSync(legacy)) return

  const files: { title: string; body: string }[] = []
  for (const f of readdirSync(legacy)) {
    if (f.startsWith(".")) continue
    const ext = path.extname(f)
    if (!EXTS.includes(ext)) continue
    const body = readFileSync(path.join(legacy, f), "utf8")
    files.push({ title: path.basename(f, ext), body })
  }
  if (!files.length) return

  const spec = existsSync(specPath(train))
    ? (JSON.parse(readFileSync(specPath(train), "utf8")) as MemorySpec)
    : {
        id: memoryId(train),
        name: `${path.basename(trainKey(train)) || "train"} memory`,
        train: trainKey(train),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      }

  const entries = readEntries(train)
  const have = new Set(entries.map((e) => e.title.toLowerCase()))
  for (const f of files) {
    if (have.has(f.title.toLowerCase())) continue
    entries.push({
      id: randomBytes(4).toString("hex"),
      ts: new Date().toISOString(),
      title: f.title,
      content: f.body.trim() + (f.body.endsWith("\n") ? "" : "\n"),
    })
  }
  writeEntries(train, spec, entries)

  try {
    const left = readdirSync(legacy).filter((n) => n !== ".keep")
    for (const n of left) {
      rmSync(path.join(legacy, n), { force: true })
    }
    if (readdirSync(legacy).every((n) => n === ".keep")) {
      rmSync(legacy, { recursive: true, force: true })
    }
  } catch {
    /* leave legacy dir if cleanup fails */
  }
}

export function listMemory(train: string): string[] {
  ensureSpec(train)
  return readEntries(train)
    .map((e) => e.title)
    .sort()
}

export function readMemory(train: string, name: string): string {
  ensureSpec(train)
  const title = safeTitle(name)
  const hit = readEntries(train).find((e) => e.title.toLowerCase() === title.toLowerCase())
  if (!hit) throw new Error(`no memory entry ${name}`)
  return hit.content
}

export function writeMemory(train: string, name: string, body: string): string {
  const spec = ensureSpec(train)
  const title = safeTitle(name)
  const text = body.trim() + (body.endsWith("\n") ? "" : "\n")
  const entries = readEntries(train)
  const idx = entries.findIndex((e) => e.title.toLowerCase() === title.toLowerCase())
  if (idx >= 0) {
    entries[idx] = { ...entries[idx]!, content: text, ts: new Date().toISOString() }
  } else {
    entries.push({
      id: randomBytes(4).toString("hex"),
      ts: new Date().toISOString(),
      title,
      content: text,
    })
  }
  writeEntries(train, spec, entries)
  return title
}

function score(query: string, title: string, body: string): number {
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  if (!q.length) return 0
  const hay = (title + "\n" + body).toLowerCase()
  let n = 0
  for (const w of q) {
    if (title.toLowerCase() === w) n += 8
    else if (title.toLowerCase().includes(w)) n += 4
    if (hay.includes(w)) n += 1
  }
  return n
}

export function searchMemory(
  train: string,
  query: string,
  limit = 8,
): { name: string; score: number; snippet: string }[] {
  ensureSpec(train)
  const hits: { name: string; score: number; snippet: string }[] = []
  for (const e of readEntries(train)) {
    const s = score(query, e.title, e.content)
    if (s <= 0) continue
    const snippet = e.content.trim().replace(/\s+/g, " ").slice(0, 180)
    hits.push({ name: e.title, score: s, snippet })
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return hits.slice(0, limit)
}

export function memoryDigest(train: string, maxChars = 1200): string {
  ensureSpec(train)
  const entries = readEntries(train)
  if (!entries.length) return ""
  const spec = JSON.parse(readFileSync(specPath(train), "utf8")) as MemorySpec
  const parts = [`memory (${entries.length}) in ~/.aq/memory/${spec.id}: ${entries.map((e) => e.title).join(", ")}`]
  let used = parts[0]!.length
  for (const e of entries.slice(-6)) {
    const body = e.content.trim().replace(/\s+/g, " ").slice(0, 160)
    const line = `- ${e.title}: ${body}`
    if (used + line.length > maxChars) break
    parts.push(line)
    used += line.length
  }
  return parts.join("\n")
}

/** Recent memory entries formatted like chat turns (for context). */
export function memoryThread(train: string, maxEntries = 12): string {
  ensureSpec(train)
  const entries = readEntries(train).slice(-maxEntries)
  if (!entries.length) return ""
  return entries.map((e) => `[${e.title}]\n${e.content.trim()}`).join("\n\n")
}
