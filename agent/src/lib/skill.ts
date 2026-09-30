/** Skills live in skills/. Markdown, code, and optional MCP. Agent-only, not a CLI. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { McpSpec } from "./mcp.js"

const DOC_EXTS = [".md", ".txt"]
const CODE_EXTS = [".py", ".ts", ".js", ".mjs", ".cjs", ".sh"]
const RUN_FILES = [
  "run.py",
  "run.ts",
  "run.js",
  "run.mjs",
  "run.cjs",
  "run.sh",
  "main.py",
  "main.ts",
  "main.js",
  "main.mjs",
  "main.cjs",
]

export type Skill = {
  name: string
  body: string
  docPath?: string
  runPath?: string
  mcps: { name: string; spec: McpSpec }[]
}

function skillsDir(train: string): string {
  return path.join(train, "skills")
}

function skipName(name: string): boolean {
  if (name.startsWith(".")) return true
  if (name === ".keep") return true
  return false
}

export function listSkills(train: string): string[] {
  const dir = skillsDir(train)
  if (!existsSync(dir)) return []
  const names = new Set<string>()
  for (const f of readdirSync(dir)) {
    if (skipName(f)) continue
    const full = path.join(dir, f)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      names.add(f)
      continue
    }
    const ext = path.extname(f)
    const stem = path.basename(f, ext)
    if (DOC_EXTS.includes(ext) || CODE_EXTS.includes(ext) || f.endsWith(".mcp.json")) names.add(stem)
  }
  return [...names].sort()
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw }
  const end = raw.indexOf("\n---", 3)
  if (end < 0) return { meta: {}, body: raw }
  const yaml = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, "")
  return { meta: looseYaml(yaml), body }
}

function looseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let key = ""
  let obj: Record<string, unknown> | null = null
  let arr: string[] | null = null
  for (const line of text.split("\n")) {
    const t = line.trimEnd()
    if (!t.trim() || t.trim().startsWith("#")) continue
    const nested = t.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (nested && obj) {
      const v = nested[2]!.trim()
      if (v) obj[nested[1]!] = unquote(v)
      continue
    }
    const list = t.match(/^\s+-\s+(.*)$/)
    if (list && arr) {
      arr.push(unquote(list[1]!.trim()))
      continue
    }
    const m = t.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    key = m[1]!
    const rest = m[2]!.trim()
    if (!rest) {
      obj = {}
      arr = []
      out[key] = obj
      continue
    }
    obj = null
    arr = null
    if (rest.startsWith("{") || rest.startsWith("[")) {
      try {
        out[key] = JSON.parse(rest)
        continue
      } catch {
        /* plain */
      }
    }
    out[key] = unquote(rest)
  }
  return out
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

function readMcpFile(file: string): { name: string; spec: McpSpec }[] {
  let j: unknown
  try {
    j = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error(`bad mcp json: ${file}`)
  }
  return mcpFromJson(j)
}

function mcpFromJson(j: unknown): { name: string; spec: McpSpec }[] {
  if (!j || typeof j !== "object") return []
  const o = j as Record<string, unknown>
  if (typeof o.command === "string") {
    return [{ name: "default", spec: asSpec(o) }]
  }
  const servers = o.mcpServers
  if (servers && typeof servers === "object") {
    const out: { name: string; spec: McpSpec }[] = []
    for (const [name, v] of Object.entries(servers as Record<string, unknown>)) {
      if (v && typeof v === "object") out.push({ name, spec: asSpec(v as Record<string, unknown>) })
    }
    return out
  }
  return []
}

function asSpec(o: Record<string, unknown>): McpSpec {
  if (typeof o.command !== "string" || !o.command.trim()) throw new Error("mcp needs command")
  const args = Array.isArray(o.args) ? o.args.map(String) : []
  const env: Record<string, string> = {}
  if (o.env && typeof o.env === "object") {
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v
    }
  }
  return { command: o.command, args, env }
}

function mcpFromMeta(meta: Record<string, unknown>): { name: string; spec: McpSpec }[] {
  const mcp = meta.mcp
  if (!mcp) return []
  return mcpFromJson(mcp)
}

function findRun(dir: string): string | undefined {
  for (const f of RUN_FILES) {
    const p = path.join(dir, f)
    if (existsSync(p)) return p
  }
  return undefined
}

export function loadSkill(train: string, name: string): Skill {
  const dir = skillsDir(train)
  const folder = path.join(dir, name)
  const mcps: { name: string; spec: McpSpec }[] = []
  let body = ""
  let docPath: string | undefined
  let runPath: string | undefined

  if (existsSync(folder) && statSync(folder).isDirectory()) {
    const skillMd = path.join(folder, "SKILL.md")
    const readme = path.join(folder, "README.md")
    const doc = existsSync(skillMd) ? skillMd : existsSync(readme) ? readme : undefined
    if (doc) {
      docPath = doc
      const parsed = parseFrontmatter(readFileSync(doc, "utf8"))
      body = parsed.body
      mcps.push(...mcpFromMeta(parsed.meta))
    }
    const mcpFile = path.join(folder, "mcp.json")
    if (existsSync(mcpFile)) mcps.push(...readMcpFile(mcpFile))
    runPath = findRun(folder)
    if (!body.trim() && runPath) body = `(code skill ${path.relative(train, runPath)})`
    if (!body.trim() && mcps.length) body = `(mcp skill: ${mcps.map((m) => m.name).join(", ")})`
    if (!body.trim() && !runPath && !mcps.length) throw new Error(`empty skill ${name}`)
    return { name, body, docPath, runPath, mcps }
  }

  for (const ext of DOC_EXTS) {
    const p = path.join(dir, name + ext)
    if (!existsSync(p)) continue
    docPath = p
    const parsed = parseFrontmatter(readFileSync(p, "utf8"))
    body = parsed.body
    mcps.push(...mcpFromMeta(parsed.meta))
  }
  for (const ext of CODE_EXTS) {
    const p = path.join(dir, name + ext)
    if (existsSync(p)) runPath = p
  }
  const mcpFile = path.join(dir, `${name}.mcp.json`)
  if (existsSync(mcpFile)) mcps.push(...readMcpFile(mcpFile))
  if (!body.trim() && runPath) body = `(code skill ${path.relative(train, runPath)})`
  if (!docPath && !runPath && !mcps.length) throw new Error(`no skill ${name} in ${dir}`)
  return { name, body, docPath, runPath, mcps }
}

export function skillBlurb(train: string, name: string): string {
  try {
    const s = loadSkill(train, name)
    const bits: string[] = []
    const line = s.body.trim().split("\n").find((l) => l.trim()) ?? ""
    const title = line.replace(/^#+\s*/, "").slice(0, 120)
    if (title && !title.startsWith("(")) bits.push(title)
    if (s.runPath) bits.push("code")
    if (s.mcps.length) bits.push("mcp")
    return bits.join(" · ") || name
  } catch {
    return name
  }
}

export function searchSkills(train: string, query: string, limit = 12): { name: string; blurb: string }[] {
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  const rows = listSkills(train).map((name) => {
    const blurb = skillBlurb(train, name)
    const hay = `${name} ${blurb}`.toLowerCase()
    let n = q.length ? 0 : 1
    for (const w of q) {
      if (name.toLowerCase() === w) n += 8
      else if (name.toLowerCase().includes(w)) n += 4
      if (hay.includes(w)) n += 1
    }
    return { name, blurb, n }
  })
  return rows
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, blurb }) => ({ name, blurb }))
}

export function skillsDigest(train: string): string {
  const names = listSkills(train)
  if (!names.length) return ""
  const lines = [`skills (${names.length}): skill_load to activate. code -> skill_run. mcp tools appear after load.`]
  for (const name of names.slice(0, 12)) {
    lines.push(`- ${name}: ${skillBlurb(train, name)}`)
  }
  return lines.join("\n")
}
