/** In-session undo for the last agent turn: files first, then chat. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { insideTrain } from "../core/paths.js"

type Rev =
  | { kind: "file"; rel: string; prev: Buffer | null }
  | { kind: "dir"; rel: string }
  | { kind: "mv"; from: string; to: string }
  | { kind: "tree"; files: { rel: string; body: Buffer }[]; dirs: string[] }

type Batch = { revs: Rev[]; historyLen: number }

let batch: Rev[] | null = null
let seen = new Set<string>()
let pendingHistory = 0
const stack: Batch[] = []

function norm(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || "."
}

export function beginUndo(historyLen: number): void {
  batch = []
  seen = new Set()
  pendingHistory = historyLen
}

export function commitUndo(): void {
  if (batch) stack.push({ revs: batch, historyLen: pendingHistory })
  batch = null
  seen = new Set()
}

export function clearUndo(): void {
  batch = null
  seen = new Set()
  stack.length = 0
}

export function recordFile(train: string, rel: string): void {
  if (!batch) return
  const n = norm(rel)
  if (seen.has("f:" + n)) return
  seen.add("f:" + n)
  const p = insideTrain(train, n)
  if (!existsSync(p) || statSync(p).isDirectory()) {
    batch.push({ kind: "file", rel: n, prev: null })
    return
  }
  batch.push({ kind: "file", rel: n, prev: readFileSync(p) })
}

export function recordParents(train: string, rel: string): void {
  if (!batch) return
  const dir = path.posix.dirname(norm(rel))
  if (!dir || dir === ".") return
  const parts = dir.split("/").filter(Boolean)
  let acc = ""
  let top: string | null = null
  for (const p of parts) {
    acc = acc ? acc + "/" + p : p
    const abs = insideTrain(train, acc)
    if (!existsSync(abs)) {
      if (!top) top = acc
    }
  }
  if (top && !seen.has("d:" + top)) {
    seen.add("d:" + top)
    batch.push({ kind: "dir", rel: top })
  }
}

export function recordDir(train: string, rel: string): void {
  if (!batch) return
  const n = norm(rel)
  const parts = n.split("/").filter(Boolean)
  let acc = ""
  let top: string | null = null
  for (const p of parts) {
    acc = acc ? acc + "/" + p : p
    const abs = insideTrain(train, acc)
    if (!existsSync(abs)) {
      if (!top) top = acc
    }
  }
  if (top && !seen.has("d:" + top)) {
    seen.add("d:" + top)
    batch.push({ kind: "dir", rel: top })
  }
}

export function recordMv(from: string, to: string): void {
  if (!batch) return
  batch.push({ kind: "mv", from: norm(from), to: norm(to) })
}

export function recordRm(train: string, rel: string): void {
  if (!batch) return
  const n = norm(rel)
  const p = insideTrain(train, n)
  if (!existsSync(p)) return
  const files: { rel: string; body: Buffer }[] = []
  const dirs: string[] = []
  const walk = (r: string) => {
    const abs = insideTrain(train, r)
    const st = statSync(abs)
    if (st.isDirectory()) {
      dirs.push(r)
      for (const name of readdirSync(abs)) {
        if (name === "." || name === "..") continue
        walk(r === "." ? name : r + "/" + name)
      }
    } else {
      files.push({ rel: r, body: readFileSync(abs) })
    }
  }
  walk(n)
  batch.push({ kind: "tree", files, dirs })
}

export function undoLast(train: string): { text: string; historyLen: number } {
  const t = stack.pop()
  if (!t) return { text: "nothing to undo", historyLen: -1 }
  for (const r of [...t.revs].reverse()) apply(train, r)
  const n = t.revs.length
  const files = n ? `  ${n} path${n === 1 ? "" : "s"}` : "  chat only"
  return { text: `undid last turn${files}`, historyLen: t.historyLen }
}

function apply(train: string, r: Rev): void {
  if (r.kind === "file") {
    const p = insideTrain(train, r.rel)
    if (r.prev == null) {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
      return
    }
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, r.prev)
    return
  }
  if (r.kind === "dir") {
    const p = insideTrain(train, r.rel)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    return
  }
  if (r.kind === "mv") {
    const src = insideTrain(train, r.to)
    const dest = insideTrain(train, r.from)
    if (!existsSync(src)) return
    mkdirSync(path.dirname(dest), { recursive: true })
    renameSync(src, dest)
    return
  }
  const dirs = [...r.dirs].sort((a, b) => a.split("/").length - b.split("/").length)
  for (const d of dirs) mkdirSync(insideTrain(train, d), { recursive: true })
  for (const f of r.files) {
    const p = insideTrain(train, f.rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, f.body)
  }
}
