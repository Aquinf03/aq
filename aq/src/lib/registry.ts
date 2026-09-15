/** Live tool index. Builtins + CLI verbs + skills, searchable. */

import { listSkills, skillBlurb } from "./skill.js"

export type ToolSource = "builtin" | "cli" | "skill"

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
    description: "Search the tool registry (builtins, aq commands, skills).",
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
    description: "Create or overwrite a file in the train (recipe, skills, …).",
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
    description: "Run an aq CLI subcommand in this train (status, train, eval, job, spawn, …).",
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
    description: "Start a worker aq agent (`aq spawn agent`).",
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
  { name: "aq_status", source: "cli", description: "Last run, eval, metrics." },
  { name: "aq_train", source: "cli", description: "Fit. Writes artifacts/checkpoints/last.json." },
  { name: "aq_eval", source: "cli", description: "Score evals/. Human-owned gate." },
  { name: "aq_checkpoint", source: "cli", description: "List or keep a checkpoint." },
  { name: "aq_data", source: "cli", description: "Hash recipe data.path." },
  { name: "aq_diff", source: "cli", description: "Compare run records." },
  { name: "aq_spawn", source: "cli", description: "spawn agent / list / log / cancel worker agents." },
  { name: "aq_plot", source: "cli", description: "Charts from artifacts (metrics, jobs, runs). Same as plot tool." },
  { name: "aq_provider", source: "cli", description: "List or set model providers." },
]

export function catalog(train: string): ToolCard[] {
  const skills = listSkills(train).map((name) => ({
    name: `skill:${name}`,
    source: "skill" as const,
    description: skillBlurb(train, name) || `skills/${name}. skill_load to use.`,
  }))
  return [...BUILTINS, ...CLI_VERBS, ...skills]
}

export function toolsDigest(_train: string): string {
  return ""
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
