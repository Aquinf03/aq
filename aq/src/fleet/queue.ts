/** SSH queues — push work; workers claim when free (ClearML-shaped, SSH backend). */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getPlace, loadSession } from "./places.js"
import { resolveSshTargets } from "./pool.js"
import {
  fleetDefaultRemoteDir,
  newJobId,
  startRemoteJob,
} from "./jobs.js"
import { c, step, stepOk } from "./ui.js"

export type QueueDef = {
  /** Place or pool workers claim against. */
  on: string
  /** Optional explicit worker place names (subset of pool / ssh). */
  workers?: string[]
  /** Whole queue paused — workers skip. */
  drained?: boolean
  /** Per-worker drain (place names). */
  drainedWorkers?: string[]
}

export type QueueItemStatus = "pending" | "claimed" | "running" | "canceled"

export type QueueItem = {
  id: string
  queue: string
  command: string[]
  status: QueueItemStatus
  priority: number
  queuedAt: string
  claimedAt?: string
  place?: string
  remoteDir?: string
  gpu?: number
  nodes?: number
  masterPort?: number
}

type QueueFile = {
  queues: Record<string, QueueDef>
  items: Record<string, QueueItem>
}

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function aquinDir(): string {
  const d = path.join(homedir(), ".aquin")
  mkdirSync(d, { recursive: true })
  return d
}

export function queuesPath(): string {
  return path.join(aquinDir(), "queues.json")
}

function lockPath(): string {
  return path.join(aquinDir(), "queues.lock")
}

function loadFile(): QueueFile {
  const p = queuesPath()
  if (!existsSync(p)) return { queues: {}, items: {} }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as QueueFile
    return {
      queues: raw.queues && typeof raw.queues === "object" ? raw.queues : {},
      items: raw.items && typeof raw.items === "object" ? raw.items : {},
    }
  } catch {
    throw tip(`bad queues file: ${p}`, "fix or delete ~/.aquin/queues.json")
  }
}

function saveFile(file: QueueFile): void {
  writeFileSync(queuesPath(), JSON.stringify(file, null, 2) + "\n", "utf8")
}

/** Exclusive file lock for claim/move (single controller). */
function withQueueLock<T>(fn: () => T): T {
  const lp = lockPath()
  let fd: number | undefined
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      fd = openSync(lp, "wx")
      writeFileSync(fd, String(process.pid))
      break
    } catch {
      const waitUntil = Date.now() + 40
      while (Date.now() < waitUntil) {
        /* spin */
      }
    }
  }
  if (fd == null) throw tip("queue lock busy", "retry · another aq queue worker?")
  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lp)
    } catch {
      /* ignore */
    }
  }
}

function queueHelp(): string {
  return [
    "aq queue                         list queues + pending counts",
    "aq queue add <name> --on <place|pool> [workers…]",
    "aq queue ls [name]               pending / claimed items",
    "aq queue push [name] [--priority N] [--gpu N] [--nodes N] [--json] -- <cmd>…",
    "aq queue move <id> --to <queue>",
    "aq queue drain <name> [--off] [--worker <place>]",
    "aq queue down <id>               cancel a pending item",
    "aq queue worker [name] [--once] [--poll sec] [--json]",
    "",
    "Push enqueues; `aq queue worker` claims onto SSH (same jobs/<id>/ as aq jobs).",
    "File: " + queuesPath(),
  ].join("\n")
}

function getQueue(name: string): QueueDef {
  const q = loadFile().queues[name]
  if (!q) throw tip(`unknown queue: ${name}`, "aq queue add " + name + " --on <place|pool>")
  return q
}

function pendingSorted(file: QueueFile, queueName?: string): QueueItem[] {
  return Object.values(file.items)
    .filter((it) => it.status === "pending" && (!queueName || it.queue === queueName))
    .sort((a, b) => b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt))
}

async function queueAdd(argv: string[]): Promise<void> {
  let name = ""
  let on = ""
  const workers: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--on") {
      on = argv[++i] || ""
      continue
    }
    if (a === "--workers") {
      while (argv[i + 1] && !argv[i + 1].startsWith("-")) workers.push(argv[++i])
      continue
    }
    if (!a.startsWith("-") && !name) {
      name = a
      continue
    }
    if (!a.startsWith("-")) {
      workers.push(a)
      continue
    }
    throw tip(`unknown: ${a}`, "aq queue add <name> --on <place|pool> [workers…]")
  }
  if (!name) throw tip("need a queue name", "aq queue add gpus --on gpus")
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw tip(`bad queue name: ${name}`, "letters, numbers, _-")
  }
  if (!on) throw tip("need --on <place|pool>", "aq queue add gpus --on gpus")
  getPlace(on) // validate
  for (const w of workers) getPlace(w)

  const file = loadFile()
  file.queues[name] = {
    on,
    ...(workers.length ? { workers } : {}),
    drained: false,
    drainedWorkers: [],
  }
  saveFile(file)
  stepOk("queue", c.cyan(name) + "  on  " + c.cyan(on) + (workers.length ? c.dim("  workers " + workers.join(",")) : ""))
  console.log(c.dim("next") + "  aq queue push " + name + " -- sleep 20 · aq queue worker " + name)
}

async function queueList(argv: string[]): Promise<void> {
  const name = argv.find((a) => !a.startsWith("-"))
  const file = loadFile()
  const names = Object.keys(file.queues).sort()
  if (!names.length) {
    console.log(c.yellow("no queues"))
    console.log(c.dim("  tip") + "  aq queue add gpus --on <pool>")
    return
  }

  if (name) {
    const q = getQueue(name)
    console.log(
      c.bold("queue") +
        "  " +
        c.cyan(name) +
        "  on  " +
        c.cyan(q.on) +
        (q.drained ? c.yellow("  drained") : ""),
    )
    if (q.workers?.length) console.log(c.dim("  workers") + "  " + q.workers.join(", "))
    if (q.drainedWorkers?.length) {
      console.log(c.dim("  drain") + "    " + q.drainedWorkers.join(", "))
    }
    const items = Object.values(file.items)
      .filter((it) => it.queue === name)
      .sort((a, b) => b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt))
    if (!items.length) {
      console.log(c.dim("  (empty)"))
      return
    }
    for (const it of items) printItem(it)
    return
  }

  console.log(c.bold("queues"))
  for (const n of names) {
    const q = file.queues[n]
    const pending = Object.values(file.items).filter((it) => it.queue === n && it.status === "pending").length
    const running = Object.values(file.items).filter(
      (it) => it.queue === n && (it.status === "running" || it.status === "claimed"),
    ).length
    console.log(
      "  " +
        c.cyan(n) +
        "  on  " +
        q.on +
        (q.drained ? c.yellow("  drained") : "") +
        c.dim(`  pending ${pending}  active ${running}`),
    )
  }
}

function printItem(it: QueueItem): void {
  const cmd = it.command.join(" ")
  const st =
    it.status === "pending"
      ? c.yellow(it.status)
      : it.status === "running" || it.status === "claimed"
        ? c.green(it.status)
        : c.dim(it.status)
  console.log(
    "  " +
      c.cyan(it.id) +
      "  " +
      st +
      c.dim(`  p${it.priority}`) +
      (it.place ? "  " + c.dim(it.place) : "") +
      "  " +
      c.dim(cmd.length > 50 ? cmd.slice(0, 47) + "…" : cmd),
  )
}

async function queuePush(argv: string[]): Promise<void> {
  let queueName = ""
  let priority = 0
  let gpu: number | undefined
  let nodes = 1
  let masterPort = 29500
  let jsonOut = false
  const cmd: string[] = []
  let sawDash = false
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      sawDash = true
      cmd.push(...argv.slice(i + 1))
      break
    }
    if (a === "--priority" || a === "-p") {
      priority = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--gpu" || a === "--gpus") {
      gpu = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--nodes") {
      nodes = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--master-port") {
      masterPort = Number(argv[i + 1])
      i += 2
      continue
    }
    if (a === "--json") {
      jsonOut = true
      i += 1
      continue
    }
    if (a === "--queue" || a === "--on") {
      queueName = argv[i + 1] || ""
      i += 2
      continue
    }
    if (!a.startsWith("-") && !queueName) {
      queueName = a
      i += 1
      continue
    }
    throw tip(`unknown: ${a}`, "aq queue push <name> -- <cmd>")
  }
  if (!queueName) {
    const names = Object.keys(loadFile().queues)
    if (names.length === 1) queueName = names[0]
  }
  if (!queueName) throw tip("need a queue name", "aq queue push gpus -- sleep 20")
  if (!sawDash || !cmd.length) throw tip("need a command after --", "aq queue push gpus -- sleep 20")
  getQueue(queueName)

  const id = newJobId()
  const item: QueueItem = {
    id,
    queue: queueName,
    command: cmd,
    status: "pending",
    priority: Number.isFinite(priority) ? priority : 0,
    queuedAt: new Date().toISOString(),
    gpu,
    nodes: Number.isFinite(nodes) && nodes >= 1 ? nodes : 1,
    masterPort,
  }
  withQueueLock(() => {
    const file = loadFile()
    if (!file.queues[queueName]) throw tip(`unknown queue: ${queueName}`, "aq queue add")
    file.items[id] = item
    saveFile(file)
  })

  if (jsonOut) {
    console.log(JSON.stringify(item))
    return
  }
  stepOk("queue", "queued  " + c.cyan(id) + c.dim(`  ${queueName}  p${item.priority}`))
  console.log(c.dim("next") + "  aq queue worker " + queueName + " · aq queue ls " + queueName)
}

async function queueMove(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need an item id", "aq queue ls")
  let to = ""
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--to") to = argv[++i] || ""
  }
  if (!to) throw tip("need --to <queue>", "aq queue move " + id + " --to cpu")
  getQueue(to)
  withQueueLock(() => {
    const file = loadFile()
    const it = file.items[id]
    if (!it) throw tip(`no such item: ${id}`, "aq queue ls")
    if (it.status !== "pending") {
      throw tip(`can only move pending (got ${it.status})`, "aq jobs status " + id)
    }
    it.queue = to
    saveFile(file)
  })
  stepOk("queue", "moved  " + c.cyan(id) + "  →  " + c.cyan(to))
}

async function queueDrain(argv: string[]): Promise<void> {
  const name = argv[0]
  if (!name) throw tip("need a queue name", "aq queue drain gpus")
  let off = false
  let worker: string | undefined
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--off") off = true
    else if (argv[i] === "--worker") worker = argv[++i]
  }
  getQueue(name)
  withQueueLock(() => {
    const file = loadFile()
    const q = file.queues[name]
    if (worker) {
      getPlace(worker)
      const set = new Set(q.drainedWorkers || [])
      if (off) set.delete(worker)
      else set.add(worker)
      q.drainedWorkers = [...set]
    } else {
      q.drained = !off
    }
    saveFile(file)
  })
  if (worker) {
    stepOk("queue", (off ? "undrain worker  " : "drain worker  ") + c.cyan(worker) + "  on  " + name)
  } else {
    stepOk("queue", (off ? "open  " : "drained  ") + c.cyan(name))
  }
}

async function queueDown(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need an item id", "aq queue ls")
  withQueueLock(() => {
    const file = loadFile()
    const it = file.items[id]
    if (!it) throw tip(`no such item: ${id}`, "aq queue ls")
    if (it.status !== "pending" && it.status !== "claimed") {
      throw tip(`item is ${it.status} — use aq jobs down ${id}`, "aq jobs down " + id)
    }
    it.status = "canceled"
    saveFile(file)
  })
  stepOk("queue", "canceled  " + c.cyan(id))
}

function claimNext(queueName?: string): QueueItem | null {
  return withQueueLock(() => {
    const file = loadFile()
    const candidates = pendingSorted(file, queueName)
    for (const it of candidates) {
      const q = file.queues[it.queue]
      if (!q || q.drained) continue
      it.status = "claimed"
      it.claimedAt = new Date().toISOString()
      file.items[it.id] = it
      saveFile(file)
      return { ...it }
    }
    return null
  })
}

function markItem(
  id: string,
  patch: Partial<QueueItem>,
): void {
  withQueueLock(() => {
    const file = loadFile()
    const it = file.items[id]
    if (!it) return
    Object.assign(it, patch)
    saveFile(file)
  })
}

function releaseClaim(id: string): void {
  markItem(id, { status: "pending", claimedAt: undefined, place: undefined })
}

async function startClaimed(it: QueueItem, quiet: boolean): Promise<void> {
  const q = getQueue(it.queue)
  const session = loadSession()
  const remoteDir = session?.remoteDir || fleetDefaultRemoteDir(session)
  const nodes = it.nodes || 1
  const ask = { gpu: it.gpu }
  const qPlace = getPlace(q.on)
  const exclude = [...(q.drainedWorkers || [])]
  if (q.workers?.length && qPlace.kind === "pool") {
    const allowed = new Set(q.workers)
    for (const m of qPlace.members) {
      if (!allowed.has(m)) exclude.push(m)
    }
  }

  let gang
  try {
    gang = resolveSshTargets(q.on, ask, nodes, { exclude })
  } catch (e) {
    releaseClaim(it.id)
    throw e
  }

  if (!quiet) {
    step("worker", "claim  " + c.cyan(it.id) + "  →  " + gang.map((g) => g.name).join(","))
  }

  try {
    const spec = await startRemoteJob({
      id: it.id,
      gang,
      remoteDir,
      command: it.command,
      masterPort: it.masterPort || 29500,
      pool: gang[0].viaPool || (getPlace(q.on).kind === "pool" ? q.on : undefined),
      quiet,
      syncTrain: session?.train,
    })
    markItem(it.id, {
      status: "running",
      place: spec.place,
      remoteDir: spec.remoteDir,
    })
    if (!quiet) {
      stepOk("worker", "running  " + c.cyan(it.id) + "  on  " + c.cyan(spec.place))
      console.log(c.dim("next") + "  aq jobs logs " + it.id + " · aq jobs status " + it.id)
    }
  } catch (e) {
    releaseClaim(it.id)
    throw e
  }
}

async function queueWorker(argv: string[]): Promise<void> {
  let queueName = ""
  let once = false
  let pollSec = 3
  let jsonOut = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--once") {
      once = true
      continue
    }
    if (a === "--poll") {
      pollSec = Number(argv[++i] || 3)
      continue
    }
    if (a === "--json") {
      jsonOut = true
      continue
    }
    if (a === "--queue") {
      queueName = argv[++i] || ""
      continue
    }
    if (!a.startsWith("-") && !queueName) {
      queueName = a
      continue
    }
    throw tip(`unknown: ${a}`, "aq queue worker [name] [--once] [--poll 3]")
  }
  if (queueName) getQueue(queueName)
  else if (!Object.keys(loadFile().queues).length) {
    throw tip("no queues", "aq queue add gpus --on <pool>")
  }

  if (!jsonOut) {
    step(
      "worker",
      "watching  " + (queueName ? c.cyan(queueName) : c.dim("all queues")) + c.dim(`  poll ${pollSec}s`),
    )
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (;;) {
    const claimed = claimNext(queueName || undefined)
    if (claimed) {
      try {
        await startClaimed(claimed, jsonOut)
        if (jsonOut) {
          console.log(JSON.stringify({ id: claimed.id, status: "running" }))
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (jsonOut) console.log(JSON.stringify({ id: claimed.id, error: msg }))
        else console.error(c.red("worker") + "  " + msg)
      }
      if (once) return
      continue
    }
    if (once) {
      if (jsonOut) console.log(JSON.stringify({ idle: true }))
      else console.log(c.dim("worker") + "  idle — nothing pending")
      return
    }
    await sleep(Math.max(1, pollSec) * 1000)
  }
}

export async function queueCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "list" || sub === "ls") {
    await queueList(sub === "list" || sub === "ls" ? argv.slice(1) : argv)
    return
  }
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(queueHelp())
    return
  }
  if (sub === "add" || sub === "create") {
    await queueAdd(argv.slice(1))
    return
  }
  if (sub === "push" || sub === "submit" || sub === "enqueue") {
    await queuePush(argv.slice(1))
    return
  }
  if (sub === "move") {
    await queueMove(argv.slice(1))
    return
  }
  if (sub === "drain") {
    await queueDrain(argv.slice(1))
    return
  }
  if (sub === "down" || sub === "cancel" || sub === "kill") {
    await queueDown(argv.slice(1))
    return
  }
  if (sub === "worker" || sub === "work") {
    await queueWorker(argv.slice(1))
    return
  }
  // bare `aq queue gpus` → list that queue
  if (!sub.startsWith("-") && loadFile().queues[sub]) {
    await queueList([sub, ...argv.slice(1)])
    return
  }
  throw tip(`unknown queue command: ${sub}`, "aq queue help")
}
