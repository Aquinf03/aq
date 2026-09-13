/** Live tool index. No registration file. tools/ plus builtins, searchable. */

import { readFileSync } from "node:fs"
import { listSkills, skillBlurb } from "./skill.js"
import { listTools, resolveTool } from "../handle/tool.js"

export type ToolSource = "builtin" | "train" | "cli" | "skill"

export type ToolCard = {
  name: string
  source: ToolSource
  description: string
  path?: string
}

export const BUILTINS: ToolCard[] = [
  {
    name: "memory_search",
    source: "builtin",
    description: "Search memory notes for this train (~/.aq/memory, like chats).",
  },
  {
    name: "memory_read",
    source: "builtin",
    description: "Read one memory entry by title (from ~/.aq/memory for this train).",
  },
  {
    name: "memory_write",
    source: "builtin",
    description: "Append or update a memory entry for this train (~/.aq/memory). Short markdown.",
  },
  {
    name: "tools_search",
    source: "builtin",
    description: "Search the tool registry (builtins, tools/, aq commands, skills).",
  },
  {
    name: "ls",
    source: "builtin",
    description: "List a directory in the train.",
  },
  {
    name: "find",
    source: "builtin",
    description: "Find files and dirs by name, substring, or glob.",
  },
  {
    name: "glob",
    source: "builtin",
    description: "Find paths by glob pattern (*.ts, **/*.md).",
  },
  {
    name: "grep",
    source: "builtin",
    description: "Search inside files. Optional glob to limit which files.",
  },
  {
    name: "read",
    source: "builtin",
    description: "Read a file in the train. Directories list instead.",
  },
  {
    name: "write",
    source: "builtin",
    description: "Create or overwrite a file in the train (tools/, skills/, recipe, ...).",
  },
  {
    name: "edit",
    source: "builtin",
    description: "Replace text in a file. Unique snippet unless all true.",
  },
  {
    name: "mkdir",
    source: "builtin",
    description: "Create a directory in the train.",
  },
  {
    name: "mv",
    source: "builtin",
    description: "Move or rename a file or folder in the train.",
  },
  {
    name: "cp",
    source: "builtin",
    description: "Copy a file in the train.",
  },
  {
    name: "rm",
    source: "builtin",
    description: "Delete a file or folder. Not jobs/ or artifacts/.",
  },
  {
    name: "web_search",
    source: "builtin",
    description: "Search the public web. Then web_fetch a URL for the page.",
  },
  {
    name: "web_fetch",
    source: "builtin",
    description: "Fetch an http(s) URL as readable text.",
  },
  {
    name: "run",
    source: "builtin",
    description: "Run a shell command. Human must approve. detach true for servers/watchers (jobs/, survives prompt).",
  },
  {
    name: "aq",
    source: "builtin",
    description: "Run an aq CLI subcommand in this train (status, train, eval, job, fork, ...).",
  },
  {
    name: "tool",
    source: "builtin",
    description: "Run a file in tools/<name> (py/ts/js/sh). Same as aq tool.",
  },
  {
    name: "skill_load",
    source: "builtin",
    description: "Activate a skill: markdown, code, and MCP tools.",
  },
  {
    name: "skill_run",
    source: "builtin",
    description: "Run the code attached to a skill.",
  },
  {
    name: "skills_search",
    source: "builtin",
    description: "Search skills/ by name or first line.",
  },
  {
    name: "plot",
    source: "builtin",
    description: "Generate matplotlib charts: loss curve, job status, run comparison. artifacts/plots/.",
  },
  {
    name: "spawn",
    source: "builtin",
    description: "Start a worker aq agent on this train.",
  },
  {
    name: "spawn_list",
    source: "builtin",
    description: "List worker agents.",
  },
]

export const CLI_VERBS: ToolCard[] = [
  { name: "aq_help", source: "cli", description: "CLI help text. Native aq help." },
  { name: "aq_init", source: "cli", description: "Create a run folder (recipe.yaml + example.py + artifacts/); does not dump into cwd." },
  { name: "aq_status", source: "cli", description: "Jobs, job plans, last run, eval." },
  { name: "aq_train", source: "cli", description: "Fit. Writes artifacts/checkpoints/last.json." },
  { name: "aq_eval", source: "cli", description: "Score evals/. Human-owned gate." },
  { name: "aq_checkpoint", source: "cli", description: "List or keep a checkpoint." },
  { name: "aq_data", source: "cli", description: "Hash recipe data.path." },
  { name: "aq_job", source: "cli", description: "Run/list/log jobs; job plan for cron/sweeps/pipelines." },
  { name: "aq_fork", source: "cli", description: "Copy this train; skip jobs/ runs and artifacts/." },
  { name: "aq_checkout", source: "cli", description: "Restore a run tree." },
  { name: "aq_diff", source: "cli", description: "Compare run records." },
  { name: "aq_spawn", source: "cli", description: "Start/list/log/cancel worker agents." },
  { name: "aq_stage", source: "cli", description: "Nested trains." },
  { name: "aq_plot", source: "cli", description: "Charts from artifacts (metrics, jobs, runs). Same as plot tool." },
  { name: "aq_provider", source: "cli", description: "List or set model providers." },
]

function blurb(file: string): string {
  const head = readFileSync(file, "utf8").slice(0, 1200)
  const lines = head.split("\n").slice(0, 24)
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/^(#|\/\/|--)\s+(.+)/) || t.match(/^"""\s*(.+)/) || t.match(/^'''\s*(.+)/)
    if (m?.[2]) return m[2].slice(0, 200)
    if (m?.[1] && t.startsWith('"""')) return m[1].slice(0, 200)
  }
  return "train tool"
}

export function trainTools(train: string): ToolCard[] {
  return listTools(train).map((name) => {
    const p = resolveTool(train, name)
    return { name, source: "train" as const, description: blurb(p), path: p }
  })
}

export function catalog(train: string): ToolCard[] {
  const skills = listSkills(train).map((name) => ({
    name: `skill:${name}`,
    source: "skill" as const,
    description: skillBlurb(train, name) || `skills/${name}. skill_load to use.`,
  }))
  return [...BUILTINS, ...trainTools(train), ...CLI_VERBS, ...skills]
}

export function toolsDigest(train: string): string {
  const tools = trainTools(train)
  if (!tools.length) return ""
  const lines = [`tools (${tools.length}): use tool`]
  for (const t of tools.slice(0, 12)) {
    lines.push(`- ${t.name}: ${t.description}`)
  }
  return lines.join("\n")
}

function score(query: string, card: ToolCard): number {
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  if (!q.length) return 1
  const hay = `${card.name} ${card.description} ${card.source}`.toLowerCase()
  let n = 0
  for (const w of q) {
    if (card.name.toLowerCase() === w) n += 10
    else if (card.name.toLowerCase().includes(w)) n += 5
    if (hay.includes(w)) n += 1
  }
  return n
}

export function searchTools(train: string, query: string, limit = 12): ToolCard[] {
  const q = query.trim()
  const cards = catalog(train)
  if (!q) return cards.slice(0, limit)
  return cards
    .map((c) => ({ card: c, n: score(q, c) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.card.name.localeCompare(b.card.name))
    .slice(0, limit)
    .map((x) => x.card)
}

export function formatCards(cards: ToolCard[]): string {
  if (!cards.length) return "no matches"
  return cards.map((c) => `${c.name}  (${c.source})  ${c.description}`).join("\n")
}
