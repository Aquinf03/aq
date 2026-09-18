/** Create, edit, move, and remove paths. Always stays inside the train. */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { insideTrain } from "../core/paths.js"
import { recordDir, recordFile, recordMv, recordParents, recordRm } from "../agent/undo.js"
import { formatUnifiedDiff } from "./textdiff.js"

function norm(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || "."
}

export function guarded(rel: string): boolean {
  const n = norm(rel)
  return n === "jobs" || n.startsWith("jobs/") || n === "artifacts" || n.startsWith("artifacts/")
}

function parent(abs: string): void {
  mkdirSync(path.dirname(abs), { recursive: true })
}

/** Read current file text, or "" if missing (for write previews). */
export function readTextAt(train: string, rel: string): string {
  const p = insideTrain(train, rel)
  if (!existsSync(p) || statSync(p).isDirectory()) return ""
  return readFileSync(p, "utf8")
}

/** Proposed write/create diff without touching disk. */
export function previewWriteDiff(train: string, rel: string, body: string): string {
  const before = readTextAt(train, rel)
  return formatUnifiedDiff(before, body, norm(rel))
}

/** Proposed edit diff without touching disk. */
export function previewEditDiff(
  train: string,
  rel: string,
  old: string,
  neu: string,
  all = false,
): string {
  if (!old) throw new Error("need old")
  const p = insideTrain(train, rel)
  if (!existsSync(p)) throw new Error(`no path ${rel}`)
  if (statSync(p).isDirectory()) throw new Error(`${rel} is a directory`)
  const text = readFileSync(p, "utf8")
  const n = text.split(old).length - 1
  if (n === 0) throw new Error(`old text not found in ${rel}`)
  if (!all && n > 1) throw new Error(`old text found ${n} times in ${rel}; pass all true or a unique snippet`)
  const after = all ? text.split(old).join(neu) : text.replace(old, neu)
  return formatUnifiedDiff(text, after, norm(rel))
}

export function writeFileAt(train: string, rel: string, body: string): string {
  const p = insideTrain(train, rel)
  const before = existsSync(p) && !statSync(p).isDirectory() ? readFileSync(p, "utf8") : ""
  recordParents(train, rel)
  recordFile(train, rel)
  parent(p)
  writeFileSync(p, body)
  const diff = formatUnifiedDiff(before, body, norm(rel))
  return `wrote ${norm(rel)}  ${Buffer.byteLength(body)} bytes\n${diff}`
}

export function editFileAt(train: string, rel: string, old: string, neu: string, all = false): string {
  if (!old) throw new Error("need old")
  const p = insideTrain(train, rel)
  if (!existsSync(p)) throw new Error(`no path ${rel}`)
  if (statSync(p).isDirectory()) throw new Error(`${rel} is a directory`)
  recordFile(train, rel)
  const text = readFileSync(p, "utf8")
  const n = text.split(old).length - 1
  if (n === 0) throw new Error(`old text not found in ${rel}`)
  if (!all && n > 1) throw new Error(`old text found ${n} times in ${rel}; pass all true or a unique snippet`)
  const after = all ? text.split(old).join(neu) : text.replace(old, neu)
  writeFileSync(p, after)
  const count = all ? n : 1
  const diff = formatUnifiedDiff(text, after, norm(rel))
  return `edited ${norm(rel)}  ${count} replacement${count === 1 ? "" : "s"}\n${diff}`
}

export function mkdirAt(train: string, rel: string): string {
  const p = insideTrain(train, rel)
  recordDir(train, rel)
  mkdirSync(p, { recursive: true })
  return `mkdir ${norm(rel)}`
}

export function mvAt(train: string, from: string, to: string): string {
  if (guarded(from) || guarded(to)) throw new Error("do not move jobs/ or artifacts/")
  const src = insideTrain(train, from)
  if (!existsSync(src)) throw new Error(`no path ${from}`)
  let dest = insideTrain(train, to)
  if (existsSync(dest) && statSync(dest).isDirectory()) {
    dest = path.join(dest, path.basename(src))
    insideTrain(train, path.relative(path.resolve(train), dest))
  } else parent(dest)
  const destRel = path.relative(path.resolve(train), dest).replace(/\\/g, "/")
  recordParents(train, destRel)
  if (existsSync(dest) && statSync(dest).isFile()) recordFile(train, destRel)
  recordMv(from, destRel)
  renameSync(src, dest)
  return `moved ${norm(from)}  ->  ${destRel}`
}

export function cpAt(train: string, from: string, to: string): string {
  const src = insideTrain(train, from)
  if (!existsSync(src)) throw new Error(`no path ${from}`)
  if (statSync(src).isDirectory()) throw new Error("copy a file, not a directory")
  let dest = insideTrain(train, to)
  if (existsSync(dest) && statSync(dest).isDirectory()) dest = path.join(dest, path.basename(src))
  else parent(dest)
  const destRel = path.relative(path.resolve(train), dest).replace(/\\/g, "/")
  recordParents(train, destRel)
  recordFile(train, destRel)
  copyFileSync(src, dest)
  return `copied ${norm(from)}  ->  ${destRel}`
}

export function rmAt(train: string, rel: string): string {
  if (guarded(rel)) throw new Error("do not delete jobs/ or artifacts/")
  const p = insideTrain(train, rel)
  if (!existsSync(p)) throw new Error(`no path ${rel}`)
  recordRm(train, rel)
  rmSync(p, { recursive: true, force: true })
  return `removed ${norm(rel)}`
}
