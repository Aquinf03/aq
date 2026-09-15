import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FORK_SKIP } from "../handle/fork.js"
import { clampAsk, detectHost, type HostResources, type ResourceAsk } from "./resources.js"

/** Internal queue used by spawn / agent detach. Not a public CLI. */

export type JobStatus = "queued" | "starting" | "running" | "exited" | "canceled" | "error"

export type JobSpec = {
  id: string
  command: string[]
  cwd: string
  pid: number | null
  waiterPid?: number | null
  status: JobStatus
  code: number | null
  signal: string | null
  queuedAt: string
  started: string
  ended: string | null
  host?: HostResources
  resources?: ResourceAsk
}

const waiterPath = fileURLToPath(new URL("./job-wait.mjs", import.meta.url))

function jobsRoot(train: string): string {
  return path.join(train, "jobs")
}

function specPath(train: string, id: string): string {
  return path.join(jobsRoot(train), id, "spec.json")
}

function logPath(train: string, id: string): string {
  return path.join(jobsRoot(train), id, "log")
}

function alive(pid: number | null): boolean {
  if (pid == null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readSpec(train: string, id: string): Promise<JobSpec> {
  const p = specPath(train, id)
  if (!existsSync(p)) throw new Error(`no such job: ${id}`)
  return JSON.parse(await readFile(p, "utf8")) as JobSpec
}

async function writeSpec(train: string, spec: JobSpec): Promise<void> {
  await writeFile(specPath(train, spec.id), JSON.stringify(spec, null, 2) + "\n", "utf8")
}

async function refresh(train: string, spec: JobSpec): Promise<JobSpec> {
  if (spec.status === "running" && !alive(spec.pid)) {
    spec.status = "exited"
    spec.ended = spec.ended ?? new Date().toISOString()
    await writeSpec(train, spec)
  }
  if (
    spec.status === "starting" &&
    !alive(spec.pid) &&
    !alive(spec.waiterPid ?? null)
  ) {
    spec.status = "error"
    spec.ended = spec.ended ?? new Date().toISOString()
    await writeSpec(train, spec)
  }
  return spec
}

function pump(train: string): void {
  const r = spawnSync(process.execPath, [waiterPath, "--dispatch", jobsRoot(train)], {
    cwd: train,
    stdio: "ignore",
    env: process.env,
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error("queue dispatch failed")
}

async function captureTree(train: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(train, { withFileTypes: true })
  for (const e of entries) {
    if (FORK_SKIP.has(e.name)) continue
    await cp(path.join(train, e.name), path.join(dest, e.name), { recursive: true })
  }
}

async function newId(train: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = randomBytes(4).toString("hex")
    if (!existsSync(path.join(jobsRoot(train), id))) return id
  }
  throw new Error("could not allocate a job id")
}

export async function enqueueJob(
  train: string,
  command: string[],
  ask?: ResourceAsk,
): Promise<string> {
  const host = detectHost(train)
  const resources = ask && Object.keys(ask).length ? clampAsk(host, ask) : undefined
  const id = await newId(train)
  const home = path.join(jobsRoot(train), id)
  await mkdir(home, { recursive: true })
  await writeFile(path.join(home, "log"), "", "utf8")
  await captureTree(train, path.join(home, "tree"))
  const now = new Date().toISOString()
  const spec: JobSpec = {
    id,
    command,
    cwd: train,
    pid: null,
    status: "queued",
    code: null,
    signal: null,
    queuedAt: now,
    started: now,
    ended: null,
    host,
    resources,
  }
  await writeSpec(train, spec)
  pump(train)
  return id
}

export async function waitForPid(train: string, id: string, timeoutMs = 2000): Promise<JobSpec> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const spec = await readSpec(train, id)
    if (spec.status === "queued") return spec
    if (spec.pid != null || spec.status === "running" || spec.status === "error") return spec
    if (spec.status !== "starting") return spec
    await new Promise((r) => setTimeout(r, 20))
  }
  return readSpec(train, id)
}

export function jobLogPath(train: string, id: string): string {
  return logPath(train, id)
}

export async function cancelJob(train: string, id: string): Promise<JobSpec> {
  const spec = await refresh(train, await readSpec(train, id))
  if (spec.status === "queued" || spec.status === "starting") {
    if (spec.pid != null && alive(spec.pid)) {
      try {
        process.kill(-spec.pid, "SIGTERM")
      } catch {
        process.kill(spec.pid, "SIGTERM")
      }
    }
    spec.status = "canceled"
    spec.ended = new Date().toISOString()
    await writeSpec(train, spec)
    pump(train)
    return spec
  }
  if (spec.status !== "running" || !alive(spec.pid)) {
    throw new Error(`not running: ${id} (${spec.status})`)
  }
  const pid = spec.pid as number
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    process.kill(pid, "SIGTERM")
  }
  spec.status = "canceled"
  spec.signal = "SIGTERM"
  spec.ended = new Date().toISOString()
  await writeSpec(train, spec)
  return spec
}
