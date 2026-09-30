/** Active skills for this process: extra tools from MCP, code via skill_run. */

import { startMcp, type McpClient, type McpToolInfo } from "./mcp.js"
import { loadSkill } from "./skill.js"
import { runFileCaptured } from "./run-file.js"

export type ExtraTool = {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

type Session = {
  skill: string
  server: string
  client: McpClient
  tools: McpToolInfo[]
}

const sessions = new Map<string, Session>()

function key(train: string, skill: string, server: string): string {
  return `${train}::${skill}::${server}`
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)
}

export function mcpToolName(skill: string, tool: string): string {
  return `mcp_${safe(skill)}_${safe(tool)}`
}

function paramsFromSchema(schema: Record<string, unknown> | undefined): ExtraTool["parameters"] {
  if (schema && schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    return schema as ExtraTool["parameters"]
  }
  return { type: "object", properties: {} }
}

export function extraTools(train: string): ExtraTool[] {
  const out: ExtraTool[] = []
  for (const [k, s] of sessions) {
    if (!k.startsWith(train + "::")) continue
    for (const t of s.tools) {
      out.push({
        name: mcpToolName(s.skill, t.name),
        description: `${t.description || t.name} (mcp ${s.skill}/${s.server})`,
        parameters: paramsFromSchema(t.inputSchema),
      })
    }
  }
  return out
}

export async function activateSkill(train: string, name: string): Promise<string> {
  const skill = loadSkill(train, name)
  const lines = [`# ${skill.name}`, skill.body.trim()].filter(Boolean)
  if (skill.runPath) {
    lines.push("", `code: ${skill.runPath.replace(train + "/", "")}`, `run with skill_run name=${name}`)
  }
  for (const mcp of skill.mcps) {
    const k = key(train, skill.name, mcp.name)
    sessions.get(k)?.client.close()
    sessions.delete(k)
    try {
      const client = await startMcp(train, mcp.spec)
      const tools = await client.listTools()
      sessions.set(k, { skill: skill.name, server: mcp.name, client, tools })
      const names = tools.map((t) => mcpToolName(skill.name, t.name))
      lines.push("", `mcp ${mcp.name}  (${mcp.spec.command})`)
      lines.push(names.length ? names.map((n) => `  ${n}`).join("\n") : "  (no tools)")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lines.push("", `mcp ${mcp.name} failed: ${msg}`)
    }
  }
  return lines.join("\n")
}

export function runSkillCode(train: string, name: string, extra: string[] = []): string {
  const skill = loadSkill(train, name)
  if (!skill.runPath) throw new Error(`skill ${name} has no code (add run.py/ts/js/sh)`)
  return runFileCaptured(train, skill.runPath, extra)
}

export async function callMcpTool(train: string, toolName: string, rawArgs: string): Promise<string | null> {
  if (!toolName.startsWith("mcp_")) return null
  let args: Record<string, unknown> = {}
  if (rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      throw new Error("bad mcp args json")
    }
  }
  for (const [k, s] of sessions) {
    if (!k.startsWith(train + "::")) continue
    for (const t of s.tools) {
      if (mcpToolName(s.skill, t.name) === toolName) {
        return s.client.callTool(t.name, args)
      }
    }
  }
  throw new Error(`mcp tool not loaded: ${toolName}. skill_load first.`)
}

export function shutdownSkills(train?: string): void {
  for (const [k, s] of [...sessions]) {
    if (train && !k.startsWith(train + "::")) continue
    s.client.close()
    sessions.delete(k)
  }
}
