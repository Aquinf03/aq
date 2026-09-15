/** Worker aq agents. Directory is the API: artifacts/agents/<id>/. Work is a job. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { cancelJob, enqueueJob, jobLogPath, waitForPid } from "../job/job.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { aqRoot } from "../core/root.js"

const KILLER_PREAMBLE = [
  "Your job is the cheapest disproof, not agreement.",
  "Find the fastest way this fork is wrong: leak, tiny eval, broken split, recipe that cannot beat the parent.",
  "Kill bad forks quickly. Do not cheerlead. Do not propose a bigger model until you have a cheap counterexample on disk (eval or a memory note).",
].join(" ")

export type AgentSpec = {
  id: string
  name: string
  prompt: string
  jobId: string
  status: string
  created: string
  updated: string
}

function agentsDir(train: string): string {
  return path.join(train, "artifacts", "agents")
}

function specPath(train: string, id: string): string {
  return path.join(agentsDir(train), id, "spec.json")
}

function aqArgv(args: string[]): string[] {
  const root = aqRoot()
  const dist = path.join(root, "dist", "cli.js")
  if (existsSync(dist)) return [process.execPath, dist, ...args]
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs")
  return [process.execPath, tsx, path.join(root, "src", "cli.ts"), ...args]
}

function newId(train: string): string {
  for (let i = 0; i < 8; i++) {
    const id = randomBytes(3).toString("hex")
    if (!existsSync(path.join(agentsDir(train), id))) return id
  }
  throw new Error("could not allocate an agent id")
}

function readSpec(train: string, id: string): AgentSpec {
  const p = specPath(train, id)
  if (!existsSync(p)) throw new Error(`no agent ${id}`)
  return JSON.parse(readFileSync(p, "utf8")) as AgentSpec
}

function writeSpec(train: string, spec: AgentSpec): void {
  mkdirSync(path.dirname(specPath(train, spec.id)), { recursive: true })
  writeFileSync(specPath(train, spec.id), JSON.stringify(spec, null, 2) + "\n")
}

function jobStatus(train: string, jobId: string): string {
  const p = path.join(train, "jobs", jobId, "spec.json")
  if (!existsSync(p)) return "missing"
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { status?: string }
    return j.status ?? "unknown"
  } catch {
    return "unknown"
  }
}

export function refreshAgent(train: string, spec: AgentSpec): AgentSpec {
  spec.status = jobStatus(train, spec.jobId)
  spec.updated = new Date().toISOString()
  writeSpec(train, spec)
  return spec
}

export function listAgents(train: string): AgentSpec[] {
  const dir = agentsDir(train)
  if (!existsSync(dir)) return []
  const out: AgentSpec[] = []
  for (const name of readdirSync(dir)) {
    const p = specPath(train, name)
    if (!existsSync(p)) continue
    try {
      out.push(refreshAgent(train, readSpec(train, name)))
    } catch {
      continue
    }
  }
  out.sort((a, b) => (a.created < b.created ? 1 : -1))
  return out
}

export async function startAgent(
  train: string,
  prompt: string,
  opts?: { name?: string; kill?: boolean },
): Promise<AgentSpec> {
  const raw = prompt.trim()
  const text = (opts?.kill ? KILLER_PREAMBLE + "\n\n" : "") + raw
  if (!raw) throw new Error("need a prompt")
  const id = newId(train)
  const name = (opts?.name ?? (opts?.kill ? "kill: " + raw : raw)).replace(/\s+/g, " ").trim().slice(0, 48) || id
  mkdirSync(path.join(agentsDir(train), id), { recursive: true })
  writeFileSync(path.join(agentsDir(train), id, "prompt.txt"), text + "\n")
  const cmd = aqArgv(["ask", "-y", "--json", train, text])
  const jobId = await enqueueJob(train, cmd)
  await waitForPid(train, jobId)
  const now = new Date().toISOString()
  const spec: AgentSpec = {
    id,
    name,
    prompt: text,
    jobId,
    status: jobStatus(train, jobId),
    created: now,
    updated: now,
  }
  writeSpec(train, spec)
  return spec
}

export async function cancelAgent(train: string, id: string): Promise<AgentSpec> {
  const spec = readSpec(train, id)
  try {
    await cancelJob(train, spec.jobId)
  } catch (err) {
    spec.status = "canceled"
    spec.updated = new Date().toISOString()
    writeSpec(train, spec)
    throw err
  }
  return refreshAgent(train, spec)
}

export function agentLog(train: string, id: string, tail = 40): string {
  const spec = refreshAgent(train, readSpec(train, id))
  const p = jobLogPath(train, spec.jobId)
  const body = existsSync(p) ? readFileSync(p, "utf8") : ""
  const lines = body.trimEnd().split("\n")
  const slice = lines.slice(-Math.max(1, tail)).join("\n")
  return [`${spec.name}  ${spec.id}  ${spec.status}  job ${spec.jobId}`, spec.prompt, "", slice || "(no log yet)"].join("\n")
}

export function formatAgents(train: string): string {
  const rows = listAgents(train)
  if (!rows.length) return "no agents"
  return rows.map((a) => `${a.id}  ${a.status.padEnd(8)}  ${a.name}`).join("\n")
}

export function spawnHelp(): string {
  return [
    "aq spawn",
    "",
    "  aq spawn agent [dir] [--name NAME] [--kill] -- <prompt>",
    "  aq spawn list [dir]",
    "  aq spawn log [dir] <id>",
    "  aq spawn cancel [dir] <id>",
  ].join("\n")
}

export async function spawnCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h") {
    console.log(spawnHelp())
    return
  }
  if (sub === "list") {
    const train = assertTrain(argv[1] ?? ".")
    console.log(formatAgents(train))
    return
  }
  if (sub === "log") {
    const rest = argv.slice(1)
    const train = rest.length === 2 ? assertTrain(rest[0]) : assertTrain(".")
    const id = rest.length === 2 ? rest[1] : rest[0]
    if (!id) throw new Error("usage: aq spawn log [dir] <id>")
    console.log(agentLog(train, id))
    return
  }
  if (sub === "cancel") {
    const rest = argv.slice(1)
    const train = rest.length === 2 ? assertTrain(rest[0]) : assertTrain(".")
    const id = rest.length === 2 ? rest[1] : rest[0]
    if (!id) throw new Error("usage: aq spawn cancel [dir] <id>")
    const spec = await cancelAgent(train, id)
    console.log("canceled")
    console.log("  " + spec.id)
    return
  }
  if (sub === "agent") {
    // was: aq spawn run
    const rest = argv.slice(1)
    let dir = "."
    let name: string | undefined
    let kill = false
    let i = 0
    if (rest[0] && !rest[0].startsWith("-") && isTrain(path.resolve(rest[0]))) {
      dir = rest[0]
      i = 1
    }
    while (i < rest.length) {
      if (rest[i] === "--") {
        const prompt = rest.slice(i + 1).join(" ").trim()
        const train = assertTrain(dir)
        const spec = await startAgent(train, prompt, { name, kill })
        console.log("spawned")
        console.log("  " + spec.id + "  " + spec.status + "  " + spec.name)
        return
      }
      if (rest[i] === "--name") {
        name = rest[i + 1]
        i += 2
        continue
      }
      if (rest[i] === "--kill") {
        kill = true
        i += 1
        continue
      }
      const prompt = rest.slice(i).join(" ").trim()
      const train = assertTrain(dir)
      const spec = await startAgent(train, prompt, { name, kill })
      console.log("spawned")
      console.log("  " + spec.id + "  " + spec.status + "  " + spec.name)
      return
    }
    throw new Error("usage: aq spawn agent [dir] [--name NAME] [--kill] -- <prompt>")
  }
  throw new Error(`unknown spawn command: ${sub}\n${spawnHelp()}`)
}
