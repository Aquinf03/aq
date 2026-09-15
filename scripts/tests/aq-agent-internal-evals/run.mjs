#!/usr/bin/env node
/** Internal agent evals. Not a user CLI. */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
const casesDir = path.join(here, "cases")
const fixture = path.join(here, "fixtures", "tiny")
const workRoot = path.join(here, ".work")

function aqCmd() {
  if (process.env.AQ) return process.env.AQ.split(/\s+/).filter(Boolean)
  const dist = path.join(repo, "aq", "dist", "cli.js")
  if (existsSync(dist)) return [process.execPath, dist]
  const tsx = path.join(repo, "aq", "node_modules", "tsx", "dist", "cli.mjs")
  const src = path.join(repo, "aq", "src", "cli.ts")
  if (existsSync(tsx) && existsSync(src)) return [process.execPath, tsx, src]
  throw new Error("build aq first (cd aq && npm run build) or set AQ")
}

function listCases() {
  return readdirSync(casesDir)
    .filter((n) => existsSync(path.join(casesDir, n, "prompt.txt")))
    .sort()
}

function copyTrain(id) {
  const dest = path.join(workRoot, id, "train")
  rmSync(path.join(workRoot, id), { recursive: true, force: true })
  mkdirSync(path.dirname(dest), { recursive: true })
  cpSync(fixture, dest, { recursive: true })
  const overlay = path.join(casesDir, id, "overlay")
  if (existsSync(overlay)) cpSync(overlay, dest, { recursive: true })
  return dest
}

function snapshot(train) {
  const files = ["experiment.md", "recipe.yaml", "data.csv"]
  const out = {}
  for (const rel of files) {
    const p = path.join(train, rel)
    if (existsSync(p)) out[rel] = readFileSync(p)
  }
  return out
}

function ask(train, prompt) {
  const cmd = aqCmd()
  const r = spawnSync(cmd[0], [...cmd.slice(1), "ask", "-y", "--json", train, prompt], {
    cwd: train,
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, AQ_QUIET: "1" },
  })
  const stdout = r.stdout ?? ""
  const stderr = r.stderr ?? ""
  let payload = { text: "", tools: [] }
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""
  try {
    payload = JSON.parse(line)
  } catch {
    payload = { text: stdout.trim(), tools: [] }
  }
  if (!Array.isArray(payload.tools)) payload.tools = []
  return {
    ok: r.status === 0,
    status: r.status,
    error: r.status === 0 ? "" : (stderr.trim() || stdout.trim() || `exit ${r.status}`),
    text: typeof payload.text === "string" ? payload.text : "",
    tools: payload.tools,
  }
}

async function runOne(id) {
  const dir = path.join(casesDir, id)
  const prompt = readFileSync(path.join(dir, "prompt.txt"), "utf8").trim()
  const train = copyTrain(id)
  const origin = snapshot(train)
  const parent = path.dirname(train)
  rmSync("/tmp/aq-internal-eval-escape.yaml", { force: true })
  rmSync(path.join(parent, "escaped.yaml"), { force: true })
  const asked = ask(train, prompt)
  const errors = []
  if (!asked.ok) errors.push(`ask failed: ${asked.error}`)
  const probePath = path.join(dir, "probe.mjs")
  const mod = await import(pathToFileURL(probePath).href)
  const fn = mod.probe || mod.probe
  if (typeof fn !== "function") throw new Error(`no probe() in ${id}`)
  const more = await fn({
    train,
    parent,
    origin,
    text: asked.text,
    tools: asked.tools,
    repo,
  })
  if (Array.isArray(more)) errors.push(...more)
  return errors
}

async function main() {
  const want = process.argv.slice(2)
  const ids = listCases().filter((id) => !want.length || want.includes(id))
  if (!ids.length) {
    console.error("no cases")
    process.exit(1)
  }
  mkdirSync(workRoot, { recursive: true })
  let failed = 0
  for (const id of ids) {
    const errors = await runOne(id)
    if (errors.length) {
      failed += 1
      console.log(`${id}  fail`)
      for (const e of errors) console.log(`  ${e}`)
    } else {
      console.log(`${id}  pass`)
    }
  }
  const n = ids.length
  console.log(`${n - failed} passed  ${failed} failed`)
  writeFileSync(
    path.join(workRoot, "last.json"),
    JSON.stringify({ at: new Date().toISOString(), n, failed }, null, 2) + "\n",
  )
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
