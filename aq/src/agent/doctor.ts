/** Health check for the CLI, train, skills, MCP, and agent deps. */

import { existsSync, accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isTrain, REQUIRED } from "../core/schema.js"
import { aqRoot, kernelRoot } from "../core/root.js"
import { listSkills, loadSkill } from "../lib/skill.js"
import { startMcp } from "../lib/mcp.js"
import { extraTools } from "../lib/skill-runtime.js"
import { activeId, activeLabel, entry, hasCreds } from "./provider.js"
import { pythonBin } from "../core/python.js"
import { frameworkVersion } from "../core/version.js"
import { artifactsDir } from "../core/paths.js"

export type Check = { ok: "ok" | "warn" | "fail"; name: string; detail: string }

function onPath(cmd: string): boolean {
  if (!cmd) return false
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd)
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
  const names = process.platform === "win32" ? [cmd, `${cmd}.cmd`, `${cmd}.exe`] : [cmd]
  for (const dir of dirs) {
    for (const n of names) {
      if (existsSync(path.join(dir, n))) return true
    }
  }
  return false
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function probeMcp(
  train: string,
  spec: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<string> {
  if (!onPath(spec.command)) throw new Error(`command not on PATH: ${spec.command}`)
  const client = await Promise.race([
    startMcp(train, spec),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout starting mcp")), 12_000)),
  ])
  try {
    const tools = await client.listTools()
    return `${tools.length} tool${tools.length === 1 ? "" : "s"}`
  } finally {
    client.close()
  }
}

export async function runDoctor(cwd: string): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = []
  const add = (ok: Check["ok"], name: string, detail: string) => checks.push({ ok, name, detail })

  add("ok", "aq", frameworkVersion().version)
  add("ok", "node", process.version)
  add(Number(process.versions.node.split(".")[0]) >= 18 ? "ok" : "fail", "node.major", "need node >= 18")

  try {
    add("ok", "python", pythonBin())
  } catch (err) {
    add("fail", "python", err instanceof Error ? err.message : String(err))
  }

  const kernel = path.join(kernelRoot(), "run.py")
  add(existsSync(kernel) ? "ok" : "fail", "kernel", existsSync(kernel) ? kernel : "kernel/run.py missing")

  const cfg = path.join(homedir(), ".aq", "config.json")
  add(existsSync(cfg) ? "ok" : "warn", "config", existsSync(cfg) ? cfg : "no ~/.aq/config.json yet")

  const id = activeId()
  if (!id) add("fail", "provider", "none. aq provider openai")
  else {
    const e = entry(id)
    add("ok", "provider", activeLabel())
    add(!e.needsKey || hasCreds(id) ? "ok" : "fail", "key", hasCreds(id) ? "set" : "missing")
    if (id === "ollama") {
      try {
        const base = e.base.replace(/\/v1$/, "")
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
        add(res.ok ? "ok" : "fail", "ollama", res.ok ? "reachable" : `http ${res.status}`)
      } catch (err) {
        add("fail", "ollama", err instanceof Error ? err.message : "unreachable")
      }
    }
  }

  const train = path.resolve(cwd)
  if (!isTrain(train)) {
    add("warn", "train", `not a train (need ${REQUIRED.join(" + ")}): ${train}`)
  } else {
    add("ok", "train", train)
    for (const f of REQUIRED) {
      add(existsSync(path.join(train, f)) ? "ok" : "fail", `train.${f}`, f)
    }
    const art = artifactsDir(train)
    // artifacts/ is created by train/eval — not by the agent (chats are in ~/.aq)
    if (existsSync(art)) {
      add(writable(art) ? "ok" : "fail", "artifacts", writable(art) ? "writable" : "not writable")
    } else {
      add("ok", "artifacts", "absent (ok until aq train)")
    }

    const names = listSkills(train)
    if (!names.length) add("ok", "skills", "none")
    const live = extraTools(train)
    for (const name of names) {
      try {
        const s = loadSkill(train, name)
        const bits: string[] = []
        if (s.runPath) bits.push("code")
        if (s.mcps.length) bits.push(`mcp ${s.mcps.map((m) => m.name).join(",")}`)
        add("ok", `skill.${name}`, bits.join(" · ") || "markdown")
        for (const mcp of s.mcps) {
          const prefix = `mcp_${name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)}_`
          const already = live.some((t) => t.name.startsWith(prefix))
          if (already) {
            add("ok", `mcp.${name}.${mcp.name}`, "already running")
            continue
          }
          try {
            add("ok", `mcp.${name}.${mcp.name}`, await probeMcp(train, mcp.spec))
          } catch (err) {
            add("fail", `mcp.${name}.${mcp.name}`, err instanceof Error ? err.message : String(err))
          }
        }
      } catch (err) {
        add("fail", `skill.${name}`, err instanceof Error ? err.message : String(err))
      }
    }
  }

  const ok = !checks.some((c) => c.ok === "fail")
  return { checks, ok }
}

export function formatDoctor(checks: Check[]): string {
  const pad = Math.max(8, ...checks.map((c) => c.name.length))
  const lines = ["doctor"]
  for (const c of checks) {
    const mark = c.ok === "ok" ? "ok  " : c.ok === "warn" ? "warn" : "fail"
    lines.push(`  ${mark}  ${c.name.padEnd(pad)}  ${c.detail}`)
  }
  const fails = checks.filter((c) => c.ok === "fail").length
  const warns = checks.filter((c) => c.ok === "warn").length
  lines.push("")
  lines.push(fails ? `fail  ${fails}` : warns ? `ok  ${warns} warning${warns === 1 ? "" : "s"}` : "ok")
  return lines.join("\n")
}

export async function doctorCmd(argv: string[]): Promise<void> {
  const dir = path.resolve(argv[0] ?? ".")
  const { checks, ok } = await runDoctor(dir)
  console.log(formatDoctor(checks))
  if (!ok) process.exitCode = 1
}
