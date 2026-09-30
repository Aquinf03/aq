/** Chats live in ~/.aq/chats/<id>/ (global). Spec records which train they belong to.
 * Agent start must never mkdir train-local artifacts/ (that is for train/eval only).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { isTrain } from "../core/schema.js"
import type { ChatMsg } from "./provider.js"
import { streamTurn } from "./provider.js"
import { artifactsDir } from "../core/paths.js"

export type ChatSpec = {
  id: string
  name: string
  created: string
  updated: string
  /** Absolute train path this chat was opened from. */
  train?: string
}

function aqHome(): string {
  return path.join(homedir(), ".aq")
}

function root(): string {
  return path.join(aqHome(), "chats")
}

function trainKey(cwd: string): string {
  return path.resolve(cwd)
}

function legacyRoot(cwd: string): string {
  return path.join(artifactsDir(cwd), "chats")
}

function specPath(id: string): string {
  return path.join(root(), id, "spec.json")
}

function msgsPath(id: string): string {
  return path.join(root(), id, "messages.json")
}

function isJunkName(name: string): boolean {
  return name === ".keep" || name === ".DS_Store" || name === "Thumbs.db"
}

/** Drop empty leftover artifacts/chats (and empty artifacts outside a train). */
function pruneChatResidue(cwd: string): void {
  const art = artifactsDir(cwd)
  const legacy = legacyRoot(cwd)
  if (existsSync(legacy)) {
    try {
      const left = readdirSync(legacy).filter((n) => !isJunkName(n))
      if (left.length === 0) rmSync(legacy, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  // Agent in a random cwd must not leave an empty artifacts/ behind.
  if (!isTrain(cwd) && existsSync(art)) {
    try {
      const names = readdirSync(art).filter((n) => !isJunkName(n))
      if (names.length === 0) {
        rmSync(art, { recursive: true, force: true })
        return
      }
      if (names.length === 1 && names[0] === "chats") {
        const chats = path.join(art, "chats")
        if (!existsSync(chats) || readdirSync(chats).filter((n) => !isJunkName(n)).length === 0) {
          rmSync(art, { recursive: true, force: true })
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/** One-time: move train-local artifacts/chats into ~/.aq/chats. Never creates artifacts/. */
function migrateLegacy(cwd: string): void {
  const legacy = legacyRoot(cwd)
  if (existsSync(legacy)) {
    mkdirSync(root(), { recursive: true })
    const train = trainKey(cwd)
    for (const name of readdirSync(legacy)) {
      if (isJunkName(name)) continue
      const from = path.join(legacy, name)
      const to = path.join(root(), name)
      if (existsSync(to)) continue
      try {
        renameSync(from, to)
        const sp = path.join(to, "spec.json")
        if (existsSync(sp)) {
          const spec = JSON.parse(readFileSync(sp, "utf8")) as ChatSpec
          if (!spec.train) {
            spec.train = train
            writeFileSync(sp, JSON.stringify(spec, null, 2) + "\n")
          }
        }
      } catch {
        /* leave legacy entry if move fails */
      }
    }
  }
  pruneChatResidue(cwd)
}

export function setTabTitle(name: string): void {
  const t = `aq · ${name}`
  process.stdout.write(`\x1b]0;${t}\x07`)
  process.stdout.write(`\x1b]2;${t}\x07`)
}

export function createChat(cwd: string): ChatSpec {
  migrateLegacy(cwd)
  const id = randomBytes(4).toString("hex")
  const now = new Date().toISOString()
  const spec: ChatSpec = {
    id,
    name: "new chat",
    created: now,
    updated: now,
    train: trainKey(cwd),
  }
  mkdirSync(path.join(root(), id), { recursive: true })
  writeFileSync(specPath(id), JSON.stringify(spec, null, 2) + "\n")
  writeFileSync(msgsPath(id), "[]\n")
  return spec
}

export function loadSpec(cwd: string, id: string): ChatSpec {
  migrateLegacy(cwd)
  const p = specPath(id)
  if (!existsSync(p)) throw new Error(`no chat ${id}`)
  return JSON.parse(readFileSync(p, "utf8")) as ChatSpec
}

export function loadMessages(cwd: string, id: string): ChatMsg[] {
  migrateLegacy(cwd)
  const p = msgsPath(id)
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as ChatMsg[]
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

export function saveChat(cwd: string, spec: ChatSpec, msgs: ChatMsg[]): void {
  if (!spec.train) spec.train = trainKey(cwd)
  spec.updated = new Date().toISOString()
  mkdirSync(path.join(root(), spec.id), { recursive: true })
  writeFileSync(specPath(spec.id), JSON.stringify(spec, null, 2) + "\n")
  writeFileSync(msgsPath(spec.id), JSON.stringify(msgs, null, 2) + "\n")
}

function readAllSpecs(): ChatSpec[] {
  const dir = root()
  if (!existsSync(dir)) return []
  const out: ChatSpec[] = []
  for (const name of readdirSync(dir)) {
    const p = specPath(name)
    if (!existsSync(p)) continue
    try {
      out.push(JSON.parse(readFileSync(p, "utf8")) as ChatSpec)
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : -1))
  return out
}

/** Chats for this train (default). Storage is still under ~/.aq. */
export function listChats(cwd: string): ChatSpec[] {
  migrateLegacy(cwd)
  const key = trainKey(cwd)
  return readAllSpecs().filter((c) => !c.train || path.resolve(c.train) === key)
}

/** Every chat on this machine. */
export function listAllChats(): ChatSpec[] {
  return readAllSpecs()
}

export function latestChat(cwd: string): ChatSpec | null {
  return listChats(cwd)[0] ?? null
}

export function renameChat(cwd: string, spec: ChatSpec, name: string, msgs: ChatMsg[]): ChatSpec {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 48) || "new chat"
  spec.name = n
  saveChat(cwd, spec, msgs)
  return spec
}

export function deleteChat(cwd: string, id: string): void {
  migrateLegacy(cwd)
  const dir = path.join(root(), id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** Delete every chat for this train (same set as listChats). Returns how many removed. */
export function deleteAllChats(cwd: string): number {
  const chats = listChats(cwd)
  for (const c of chats) deleteChat(cwd, c.id)
  return chats.length
}

function stubName(text: string): string {
  const s = text.replace(/\s+/g, " ").trim().slice(0, 48)
  return s || "new chat"
}

export async function nameChat(
  cwd: string,
  spec: ChatSpec,
  user: string,
  assistant: string,
  msgs: ChatMsg[],
): Promise<ChatSpec> {
  spec.name = stubName(user)
  saveChat(cwd, spec, msgs)
  setTabTitle(spec.name)
  try {
    const out = await streamTurn(
      [
        {
          role: "user",
          content: `Name this chat in 2-5 words. No quotes. No trailing punctuation.\n\nUser: ${user.slice(0, 400)}\nAssistant: ${assistant.slice(0, 400)}`,
        },
      ],
      () => {},
      { system: "Reply with only the name.", tools: [] },
    )
    const n = out.text
      .trim()
      .split("\n")[0]
      ?.replace(/^["'\s]+|["'\s.]+$/g, "")
      .slice(0, 48)
    if (n) spec.name = n
  } catch {
    /* stub name is enough */
  }
  saveChat(cwd, spec, msgs)
  setTabTitle(spec.name)
  return spec
}
