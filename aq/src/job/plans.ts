/** Job plans: cron, sweep, pipeline, resume, agents.
 * Authoring: `plans:` in recipe.yaml. Runtime state: artifacts/jobs/plans/.
 * Legacy: jobs/plans/*.yaml still loaded if present.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fork } from "../handle/fork.js"
import { enqueueJob, waitForJob } from "./job.js"
import { startAgent } from "../agent/spawn.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { aqRoot } from "../core/root.js"
import { readRecipeFile, type YamlValue } from "../core/recipe-yaml.js"

export type JobPlan = {
  kind: "sweep" | "cron" | "resume" | "pipeline" | "agents"
  run?: string
  ask?: string
  steps?: string[]
  agents?: number
  n?: number
  every?: number
  on?: string
  max?: number
}

export type ListedPlan = {
  name: string
  spec: JobPlan
  /** Where it was declared. */
  source: "recipe" | "file"
  file?: string
}

type PlanState = { last?: string; count: number; retries: number }

function plansDir(train: string): string {
  return path.join(train, "jobs", "plans")
}

function legacySchedDir(train: string): string {
  return path.join(train, "schedules")
}

function migrateLegacyPlans(train: string): void {
  const legacy = legacySchedDir(train)
  if (!existsSync(legacy)) return
  mkdirSync(plansDir(train), { recursive: true })
  for (const f of readdirSync(legacy)) {
    if (f.startsWith(".")) continue
    if (!f.endsWith(".yaml") && !f.endsWith(".yml") && !f.endsWith(".json")) continue
    const dest = path.join(plansDir(train), f)
    if (!existsSync(dest)) {
      try {
        renameSync(path.join(legacy, f), dest)
      } catch {
        /* leave legacy copy if move fails */
      }
    }
  }
  try {
    const left = readdirSync(legacy).filter((n) => n !== ".keep")
    if (!left.length) rmSync(legacy, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function parsePlanYaml(text: string): JobPlan {
  const rec: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const s = line.split("#", 1)[0].trim()
    if (!s || !s.includes(":")) continue
    const [k, ...rest] = s.split(":")
    rec[k.trim()] = rest.join(":").trim()
  }
  return validatePlan(rec as unknown as JobPlan, "yaml")
}

function coerceSteps(raw: unknown): string[] | undefined {
  if (raw == null) return undefined
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean)
  }
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function validatePlan(raw: JobPlan & Record<string, unknown>, src: string): JobPlan {
  const kind = raw.kind
  if (kind !== "sweep" && kind !== "cron" && kind !== "resume" && kind !== "pipeline" && kind !== "agents") {
    throw new Error(`job plan: kind must be sweep, cron, resume, pipeline, or agents (${src})`)
  }
  const steps = coerceSteps(raw.steps)
  if (kind === "agents") {
    if (!raw.ask && !raw.run) throw new Error(`job plan: agents need ask (${src})`)
  } else if (kind !== "pipeline" && !raw.run) {
    throw new Error(`job plan: need run (${src})`)
  }
  if (kind === "pipeline" && !steps?.length) throw new Error(`job plan: pipeline needs steps (${src})`)
  return {
    kind,
    run: raw.run != null ? String(raw.run) : undefined,
    ask: raw.ask != null ? String(raw.ask) : undefined,
    steps,
    agents: raw.agents != null ? Number(raw.agents) : undefined,
    n: raw.n != null ? Number(raw.n) : undefined,
    every: raw.every != null ? Number(raw.every) : undefined,
    on: raw.on != null ? String(raw.on) : undefined,
    max: raw.max != null ? Number(raw.max) : undefined,
  }
}

function plansFromRecipe(train: string): ListedPlan[] {
  const recipe = readRecipeFile(train)
  const block = recipe.plans
  if (!block || typeof block !== "object" || Array.isArray(block)) return []
  const out: ListedPlan[] = []
  for (const [name, raw] of Object.entries(block as Record<string, YamlValue>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`recipe.yaml plans.${name}: expected a mapping`)
    }
    out.push({
      name,
      spec: validatePlan(raw as JobPlan & Record<string, unknown>, `recipe.yaml#plans.${name}`),
      source: "recipe",
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function plansFromFiles(train: string): ListedPlan[] {
  migrateLegacyPlans(train)
  const dir = plansDir(train)
  if (!existsSync(dir)) return []
  const out: ListedPlan[] = []
  for (const f of readdirSync(dir)) {
    if (f.startsWith(".")) continue
    if (!f.endsWith(".yaml") && !f.endsWith(".yml") && !f.endsWith(".json")) continue
    const name = f.replace(/\.(yaml|yml|json)$/, "")
    const file = path.join(dir, f)
    out.push({ name, spec: readPlanFile(file), source: "file", file })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Plans from recipe.yaml first; legacy jobs/plans/*.yaml fill names not already defined. */
export function listPlans(train: string): ListedPlan[] {
  const fromRecipe = plansFromRecipe(train)
  const names = new Set(fromRecipe.map((p) => p.name))
  const fromFiles = plansFromFiles(train).filter((p) => !names.has(p.name))
  return [...fromRecipe, ...fromFiles].sort((a, b) => a.name.localeCompare(b.name))
}

/** @deprecated use listPlans */
export function listPlanFiles(train: string): { name: string; file: string }[] {
  return listPlans(train)
    .filter((p) => p.file)
    .map((p) => ({ name: p.name, file: p.file! }))
}

export function readPlanFile(file: string): JobPlan {
  const text = readFileSync(file, "utf8")
  if (file.endsWith(".json")) {
    return validatePlan(JSON.parse(text) as JobPlan & Record<string, unknown>, file)
  }
  return parsePlanYaml(text)
}

/** @deprecated use readPlanFile / listPlans */
export function readPlan(file: string): JobPlan {
  return readPlanFile(file)
}

function statePath(train: string, name: string): string {
  return path.join(train, "artifacts", "jobs", "plans", name + ".json")
}

function loadState(train: string, name: string): PlanState {
  const p = statePath(train, name)
  if (!existsSync(p)) return { count: 0, retries: 0 }
  return JSON.parse(readFileSync(p, "utf8")) as PlanState
}

function saveState(train: string, name: string, st: PlanState): void {
  const p = statePath(train, name)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(st, null, 2) + "\n")
}

function aqArgv(args: string[]): string[] {
  const root = aqRoot()
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs")
  const cli = path.join(root, "src", "cli.ts")
  return [process.execPath, tsx, cli, ...args]
}

function runCmd(train: string, run: string): string[] {
  if (run.startsWith("tool:")) {
    return aqArgv(["tool", train, run.slice(5)])
  }
  if (run.startsWith("stage:")) {
    return aqArgv(["stage", train, run.slice(6)])
  }
  if (run === "train" || run === "eval" || run === "hash") {
    const cmd = run === "hash" ? ["data", "hash", train] : [run, train]
    return aqArgv(cmd)
  }
  throw new Error(`job plan: unknown run ${run} (train, eval, hash, tool:name, stage:name)`)
}

function logPath(train: string, name: string): string {
  return path.join(train, "artifacts", "jobs", "plans", name + ".log")
}

function logLine(train: string, name: string, line: string): void {
  const p = logPath(train, name)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, new Date().toISOString() + "  " + line + "\n", { flag: "a" })
}

async function runPipeline(train: string, name: string, spec: JobPlan): Promise<string[]> {
  const steps = spec.steps ?? []
  const lines: string[] = []
  for (const step of steps) {
    const id = await enqueueJob(train, runCmd(train, step))
    logLine(train, name, "start  " + step + "  " + id)
    const done = await waitForJob(train, id)
    const line = step + "  " + id + "  " + done.status + (done.code != null ? "  " + done.code : "")
    logLine(train, name, line)
    lines.push(name + "  " + line)
    if (done.status !== "exited" || (done.code != null && done.code !== 0)) {
      lines.push(name + "  stop")
      break
    }
  }
  const st = loadState(train, name)
  st.last = new Date().toISOString()
  st.count += 1
  saveState(train, name, st)
  return lines
}

async function runAgents(train: string, name: string, spec: JobPlan): Promise<string[]> {
  const n = spec.agents ?? 1
  if (n <= 1) return runPipeline(train, name, spec)
  const lines: string[] = []
  const kids: Promise<string[]>[] = []
  for (let i = 1; i <= n; i++) {
    const dest = path.join(train, "artifacts", "agents", String(i))
    if (!existsSync(dest)) await fork({ src: train, dest })
    kids.push(runPipeline(dest, name, spec).then((ls) => ls.map((l) => "agent" + i + "  " + l)))
  }
  for (const ls of await Promise.all(kids)) lines.push(...ls)
  return lines
}

async function fire(train: string, name: string, spec: JobPlan): Promise<string> {
  if (!spec.run) throw new Error("job plan: need run")
  const id = await enqueueJob(train, runCmd(train, spec.run))
  const st = loadState(train, name)
  st.last = new Date().toISOString()
  st.count += 1
  saveState(train, name, st)
  return id
}

function label(spec: JobPlan): string {
  if (spec.kind === "agents") return (spec.ask ?? spec.run ?? "") + (spec.n || spec.agents ? `  x${spec.n ?? spec.agents}` : "")
  if (spec.steps?.length) return spec.steps.join(",")
  return spec.run ?? ""
}

function dueCron(spec: JobPlan, st: PlanState): boolean {
  const every = spec.every ?? 60
  if (!st.last) return true
  return Date.now() - new Date(st.last).getTime() >= every * 60 * 1000
}

function evalFailed(train: string): boolean {
  const p = path.join(train, "artifacts", "eval.json")
  if (!existsSync(p)) return false
  const ev = JSON.parse(readFileSync(p, "utf8")) as { pass?: boolean | null }
  return ev.pass === false
}

async function tickOne(
  train: string,
  name: string,
  spec: JobPlan,
  force: boolean,
): Promise<string[]> {
  const lines: string[] = []
  const st = loadState(train, name)
  if (spec.kind === "sweep") {
    const n = spec.n ?? 1
    for (let i = 0; i < n; i++) {
      const id = await fire(train, name, spec)
      lines.push(name + "  sweep  " + id)
    }
    return lines
  }
  if (spec.kind === "cron") {
    if (!force && !dueCron(spec, st)) {
      lines.push(name + "  cron  skip")
      return lines
    }
    const id = await fire(train, name, spec)
    lines.push(name + "  cron  " + id)
    return lines
  }
  if (spec.kind === "resume") {
    const max = spec.max ?? 3
    if (!evalFailed(train)) {
      st.retries = 0
      saveState(train, name, st)
      lines.push(name + "  resume  skip")
      return lines
    }
    if (st.retries >= max) {
      lines.push(name + "  resume  max")
      return lines
    }
    const id = await fire(train, name, spec)
    const st2 = loadState(train, name)
    st2.retries = st.retries + 1
    saveState(train, name, st2)
    lines.push(name + "  resume  " + id)
    return lines
  }
  if (spec.kind === "pipeline") {
    return runAgents(train, name, spec)
  }
  if (spec.kind === "agents") {
    const prompt = spec.ask ?? spec.run ?? ""
    const n = spec.n ?? spec.agents ?? 1
    for (let i = 1; i <= n; i++) {
      const a = await startAgent(train, prompt, { name: `${name}-${i}` })
      logLine(train, name, `spawn  ${a.id}  ${a.jobId}`)
      lines.push(`${name}  spawn  ${a.id}  ${a.status}`)
    }
    const st2 = loadState(train, name)
    st2.last = new Date().toISOString()
    st2.count += 1
    saveState(train, name, st2)
    return lines
  }
  return lines
}

export function planHelp(): string {
  return [
    "  aq job plan [dir]              list plans from recipe.yaml (plans:)",
    "  aq job plan tick [dir]         run due cron/resume plans",
    "  aq job plan run [dir] <name>   fire that plan now",
  ].join("\n")
}

export async function jobPlan(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log("aq job plan\n")
    console.log(planHelp())
    return
  }
  if (!sub || sub === "list" || (sub !== "tick" && sub !== "run" && isTrain(path.resolve(sub)))) {
    let trainDir = "."
    if (sub === "list") trainDir = argv[1] ?? "."
    else if (sub && isTrain(path.resolve(sub))) trainDir = sub
    const train = assertTrain(trainDir)
    const plans = listPlans(train)
    if (!plans.length) {
      console.log("no job plans")
      return
    }
    for (const { name, spec, source } of plans) {
      const where = source === "recipe" ? "recipe.yaml" : "jobs/plans/"
      console.log(name + "  " + spec.kind + "  " + label(spec) + "  (" + where + ")")
    }
    return
  }
  if (sub === "tick") {
    const train = assertTrain(argv[1] ?? ".")
    const plans = listPlans(train)
    if (!plans.length) {
      console.log("no job plans")
      return
    }
    for (const { name, spec } of plans) {
      if (spec.kind === "sweep" || spec.kind === "pipeline") continue
      const lines = await tickOne(train, name, spec, false)
      for (const l of lines) console.log(l)
    }
    return
  }
  if (sub === "run") {
    const rest = argv.slice(1)
    let train: string
    let name: string
    if (rest.length === 1) {
      train = assertTrain(".")
      name = rest[0]
    } else if (rest.length === 2) {
      train = assertTrain(rest[0])
      name = rest[1]
    } else {
      throw new Error("usage: aq job plan run [dir] <name>")
    }
    const hit = listPlans(train).find((x) => x.name === name)
    if (!hit) throw new Error(`no job plan ${name}`)
    const lines = await tickOne(train, name, hit.spec, true)
    for (const l of lines) console.log(l)
    return
  }
  throw new Error(`unknown job plan command: ${sub}\n${planHelp()}`)
}

export function listPlanLogFiles(train: string): string[] {
  migrateLegacyPlans(train)
  const dir = path.join(train, "artifacts", "jobs", "plans")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".log")).sort()
}
