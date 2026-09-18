/** Builtin agent tools. */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { aqRoot } from "../core/root.js"
import { memoryDigest, readMemory, searchMemory, writeMemory } from "../lib/memory.js"
import { formatCards, searchTools, toolsDigest } from "../lib/registry.js"
import { find as findPaths, glob as globPaths, grep as grepFiles, ls, readPath } from "../lib/explore.js"
import { cpAt, editFileAt, mkdirAt, mvAt, previewEditDiff, previewWriteDiff, rmAt, writeFileAt } from "../lib/files.js"
import { clipToolLog } from "../lib/textdiff.js"
import { searchSkills, skillsDigest } from "../lib/skill.js"
import { activateSkill, callMcpTool, extraTools, runSkillCode } from "../lib/skill-runtime.js"
import { childTrains, isTrain, trainInArgv } from "../core/schema.js"
import { enqueueJob, waitForPid } from "../job/job.js"
import { agentLog, cancelAgent, formatAgents, startAgent } from "./spawn.js"
import { webFetch, webSearch } from "../lib/web.js"

export type AgentToolDef = {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

function nativeAqTools(): AgentToolDef[] {
  const verbs: [string, string][] = [
    ["init", "Create a run folder (aq-run or named): recipe.yaml + example.py + artifacts/. Paths live in the YAML."],
    ["help", "CLI help text."],
    ["status", "Last run, eval, metrics. If cwd is not a train, args MUST be the train folder."],
    ["train", "Fit locally. If cwd is not a train, args MUST be the train folder. Writes artifacts/checkpoints/last.json."],
    ["eval", "Score evals/ locally. If cwd is not a train, args starts with the train folder. Humans approve each step."],
    ["checkpoint", "List or keep a checkpoint. If cwd is not a train, pass the train folder in args."],
    ["serve", "Run last checkpoint locally: LLM completion, VLM (+ --image), vision classify, CLIP score, or tabular predict."],
    ["data", "Hash recipe data.path. Extra args after data."],
    ["diff", "Compare run records."],
    ["plot", "Generate charts from artifacts: loss/lr (metrics), job status (jobs), run comparison (runs), or all. Writes artifacts/plots/*.png. Use when the user asks for a graph, chart, or plot."],
    ["spawn", "Worker agents: spawn agent / list / log / cancel."],
    ["provider", "List or set model providers."],
    ["update", "Install the latest aq release (same as curl install.sh | bash)."],
    ["version", "Print framework version."],
    ["places", "List SSH places / pools (live check). Read-only."],
    [
      "add",
      "Register compute. Prefer non-interactive: aq_add args \"ssh <name> --host H [--user U] [--port P] [--key PATH]\". Or pool: \"pool <name> m1 m2\".",
    ],
    ["launch", "Sync train folder to a place and install/refresh remote aq. Args e.g. \"--on <place>\" or train path + --on."],
    ["sync", "Re-sync train folder to the place session. Args: train and/or --on <place>."],
    ["go", "Open a shell on a place (interactive). Prefer jobs for non-interactive work."],
    ["shutdown", "Tear down a launch session on a place."],
    [
      "jobs",
      "Remote jobs on a place/pool: train|eval|serve|run|list|status|logs|wait|pull|down|recover|watch|sweep. After run/train/eval/serve, call wait <id> (polls status + log snapshots until done — never bare logs follow). Example: \"train --on lab\" then \"wait <id>\".",
    ],
    ["queue", "Local/remote job queues: add/push/worker/drain/move."],
    ["port", "SSH port forwards for a place/session."],
    ["tag", "Labels on places or jobs."],
  ]
  return verbs.map(([verb, description]) => ({
    name: `aq_${verb}`,
    description: `${description} Native aq ${verb}. Same as \`aq ${verb}\`.`,
    parameters: {
      type: "object" as const,
      properties: {
        args: { type: "string", description: `extra argv after '${verb}', space-separated` },
      },
    },
  }))
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: "memory_search",
    description: "Search memory for this train (~/.aq/memory, keyed like chats).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "keywords" } },
      required: ["query"],
    },
  },
  {
    name: "memory_read",
    description: "Read one memory entry by title (~/.aq/memory for this train).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "note stem" } },
      required: ["name"],
    },
  },
  {
    name: "memory_write",
    description: "Save a durable memory entry for this train (~/.aq/memory). Like pinning a chat note — not a file in the experiment folder.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "stem like run-notes" },
        body: { type: "string", description: "markdown body" },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "tools_search",
    description: "Search builtins, tools/, aq commands, and skills.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "keywords" } },
      required: ["query"],
    },
  },
  {
    name: "ls",
    description: "List a directory in the train. Default is .",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "relative dir, default ." } },
    },
  },
  {
    name: "find",
    description: "Find files and dirs in the train by name, substring, or glob (* and **).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "name, substring, or glob" },
        path: { type: "string", description: "relative root to search, default ." },
      },
      required: ["query"],
    },
  },
  {
    name: "glob",
    description: "Find paths by glob (*.ts, **/*.yaml). Names only, not file contents.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern" },
        path: { type: "string", description: "relative root, default ." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents in the train. Optional glob to limit files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "text or regex" },
        path: { type: "string", description: "relative root, default ." },
        glob: { type: "string", description: "optional file glob like *.ts" },
      },
      required: ["query"],
    },
  },
  {
    name: "read",
    description: "Read a file in the train. If path is a directory, lists it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "relative path" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a file in the train. Makes parent dirs. Use for tools/, skills/, recipe, anything in this folder.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative path" },
        content: { type: "string", description: "full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Replace text in a file. old must be unique unless all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative path" },
        old: { type: "string", description: "exact text to find" },
        new: { type: "string", description: "replacement" },
        all: { type: "boolean", description: "replace every match" },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "mkdir",
    description: "Create a directory in the train (and parents).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "relative dir" } },
      required: ["path"],
    },
  },
  {
    name: "mv",
    description: "Move or rename a file or folder inside the train.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "existing path" },
        to: { type: "string", description: "new path or destination dir" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "cp",
    description: "Copy a file inside the train.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "existing file" },
        to: { type: "string", description: "new path or destination dir" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "rm",
    description: "Delete a file or folder in the train. Not jobs/ or artifacts/.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "relative path" } },
      required: ["path"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the public web. OpenAI, Anthropic, and Grok use their built-in search (same API key). Ollama uses a key-free fallback. Then web_fetch a URL if you need the page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "search query" },
        count: { type: "number", description: "how many results, default 5, max 8" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a public http(s) URL and return readable text. HTML is stripped. Use after web_search or when the user gives a link.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "http or https URL" } },
      required: ["url"],
    },
  },
  {
    name: "skill_load",
    description:
      "Activate skills/<name>. Loads markdown, starts MCP servers from mcp.json, and registers mcp_* tools for the rest of this session.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "skill_run",
    description: "Run the code in a skill (skills/<name>/run.py|ts|js|sh or skills/<name>.py|ts|js|sh).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill name" },
        args: { type: "string", description: "optional argv, space-separated" },
      },
      required: ["name"],
    },
  },
  {
    name: "run",
    description:
      "Run a shell command in the train. Human must approve. Set detach true for servers/watchers so they live in jobs/ and survive this prompt dying.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "the full command" },
        detach: {
          type: "boolean",
          description: "true for long-running: job in jobs/, log file, survives disconnect",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "aq",
    description:
      "Run any aq CLI verb in this train. Prefer the native aq_* tools when you know the verb. args is space-separated, no pipes.",
    parameters: {
      type: "object",
      properties: { args: { type: "string", description: "e.g. status  or  eval smoke" } },
      required: ["args"],
    },
  },
  ...nativeAqTools(),
  {
    name: "spawn",
    description:
      "Start a worker aq agent on this train (same as `aq spawn agent`). Runs in the background as a job (artifacts/agents/<id>/). Use spawn_list and spawn_log to follow. kill true = cheapest-disproof critic, not a cheerleader.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "what the worker should do" },
        name: { type: "string", description: "optional short name" },
        kill: { type: "boolean", description: "true: critic whose job is cheapest disproof" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "spawn_list",
    description: "List worker agents on this train.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "spawn_log",
    description: "Show a worker agent's log and status.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "agent id" } },
      required: ["id"],
    },
  },
  {
    name: "spawn_cancel",
    description: "Stop a worker agent.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "agent id" } },
      required: ["id"],
    },
  },
  {
    name: "plot",
    description:
      "Generate matplotlib charts for this train. kind=metrics (loss/lr curve), jobs (status bar chart), runs (experiment comparison), or all. Writes under artifacts/plots/. Use when the user asks for a graph, chart, diagram, or plot of training or jobs.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "metrics | jobs | runs | all (default all)",
        },
      },
    },
  },
  {
    name: "skills_search",
    description: "Search skills/ by name or first line. Empty query lists them.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "keywords, or empty to list" } },
    },
  },
]

const ALLOW = new Set([
  "help",
  "init",
  "status",
  "train",
  "eval",
  "checkpoint",
  "serve",
  "data",
  "diff",
  "plot",
  "provider",
  "spawn",
  "update",
  "version",
  "places",
  "add",
  "launch",
  "sync",
  "go",
  "shutdown",
  "jobs",
  "queue",
  "port",
  "tag",
])

/** Fleet / remote verbs often need sync + SSH — longer than local train. */
const LONG_AQ = new Set(["launch", "sync", "jobs", "go", "shutdown", "queue"])

const READ_AQ = new Set(["help", "status", "version", "places", "diff"])

function aqPartsNeedPermit(parts: string[]): boolean {
  const head = parts[0]
  if (!head) return true
  if (READ_AQ.has(head)) return false
  if (head === "jobs") {
    const sub = parts[1] ?? "list"
    if (sub === "list" || sub === "status" || sub === "logs" || sub === "help" || sub === "wait") return false
  }
  if (head === "checkpoint" && parts.length <= 1) return false
  if (head === "provider" && (parts.length <= 1 || parts[1] === "list")) return false
  return true
}

const READ_TOOLS = new Set([
  "memory_search",
  "memory_read",
  "tools_search",
  "ls",
  "find",
  "glob",
  "grep",
  "read",
  "web_search",
  "web_fetch",
  "skills_search",
  "spawn_list",
  "spawn_log",
])

/** Whether this tool call needs a human yes/no before running. */
export function toolNeedsPermit(name: string, rawArgs: string): boolean {
  if (name === "run") return true
  if (READ_TOOLS.has(name)) return false
  if (name === "aq" || name.startsWith("aq_")) {
    let args: Record<string, unknown> = {}
    if (rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>
      } catch {
        return true
      }
    }
    const extra = typeof args.args === "string" ? args.args.trim().split(/\s+/).filter(Boolean) : []
    const parts = name === "aq" ? extra : [name.slice(3), ...extra]
    return aqPartsNeedPermit(parts)
  }
  return true
}

/** One-line (or multi-line for file diffs) label shown in the yes/no picker. */
export function permitLabel(train: string, name: string, rawArgs: string): string {
  if (name === "run") {
    try {
      const spec = parseRunCommand(rawArgs)
      return spec.detach ? `${spec.command}  [detach]` : spec.command
    } catch {
      return "run …"
    }
  }
  let args: Record<string, unknown> = {}
  if (rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      return name
    }
  }
  if (name === "write") {
    const p = typeof args.path === "string" ? args.path : "?"
    const body = typeof args.content === "string" ? args.content : ""
    try {
      const diff = previewWriteDiff(train, p, body)
      return `write ${p}\n${diff}`
    } catch (err) {
      return `write ${p}\n(${err instanceof Error ? err.message : String(err)})`
    }
  }
  if (name === "edit") {
    const p = typeof args.path === "string" ? args.path : "?"
    const old = typeof args.old === "string" ? args.old : ""
    const neu = typeof args.new === "string" ? args.new : ""
    const all = args.all === true
    try {
      const diff = previewEditDiff(train, p, old, neu, all)
      return `edit ${p}\n${diff}`
    } catch (err) {
      return `edit ${p}\n(${err instanceof Error ? err.message : String(err)})`
    }
  }
  if (name === "aq" || name.startsWith("aq_")) {
    const extra = typeof args.args === "string" ? args.args.trim() : ""
    const verb = name === "aq" ? "" : name.slice(3)
    return `aq ${verb} ${extra}`.replace(/\s+/g, " ").trim()
  }
  if (name === "read") {
    const p = typeof args.path === "string" ? args.path : "?"
    return `read ${p}`
  }
  if (name === "mkdir" || name === "rm") {
    const p = typeof args.path === "string" ? args.path : "?"
    return `${name} ${p}`
  }
  if (typeof args.args === "string" && args.args.trim()) {
    return `${name} ${args.args.trim()}`.slice(0, 120)
  }
  return name
}

/** Colorize a permit/tool blob if it looks like a unified diff. */
export function formatPermitDisplay(label: string): string {
  const nl = label.indexOf("\n")
  if (nl < 0) return label
  const head = label.slice(0, nl)
  const rest = label.slice(nl + 1)
  if (!rest.includes("--- a/") || !rest.includes("+++ b/")) return label
  const colored = rest
    .split("\n")
    .map((ln) => {
      if (ln.startsWith("+") && !ln.startsWith("+++")) return `\x1b[38;5;114m${ln}\x1b[0m`
      if (ln.startsWith("-") && !ln.startsWith("---")) return `\x1b[38;5;203m${ln}\x1b[0m`
      return `\x1b[38;5;245m${ln}\x1b[0m`
    })
    .join("\n")
  return `${head}\n${colored}`
}

export { clipToolLog }

function aqBin(): string {
  return path.join(aqRoot(), "bin", "aq")
}

function jsonArg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== "string") throw new Error(`need ${key}`)
  return v
}

export function workspaceLines(train: string): string[] {
  const kids = childTrains(train)
  const lines = [
    `Workspace path: ${train}`,
    `This folder is a train: ${isTrain(train) ? "yes" : "no"}`,
  ]
  if (!isTrain(train)) {
    if (kids.length) {
      lines.push(`Child trains: ${kids.join(", ")}`)
      lines.push(`Use aq_* with args set to one of those names. Example: aq_train args "${kids[0]}"`)
    } else {
      lines.push("No child trains. aq_init a subfolder, then pass that name to aq_train / aq_status.")
    }
  } else if (kids.length) {
    lines.push(`Nested trains: ${kids.join(", ")}`)
  }
  return lines
}

export function contextBlock(train: string): string {
  const bits = [
    workspaceLines(train).join("\n"),
    memoryDigest(train),
    skillsDigest(train),
    toolsDigest(train),
  ]
  return ["", ...bits].filter(Boolean).join("\n")
}

export function toolsForTrain(train: string): AgentToolDef[] {
  return [...AGENT_TOOLS, ...extraTools(train)]
}

export async function runAgentTool(train: string, name: string, rawArgs: string): Promise<string> {
  const mcp = await callMcpTool(train, name, rawArgs)
  if (mcp != null) return mcp
  let args: Record<string, unknown> = {}
  if (rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      throw new Error("bad tool args json")
    }
  }
  if (name === "memory_search") {
    const hits = searchMemory(train, jsonArg(args, "query"))
    return hits.length ? hits.map((h) => `${h.name}: ${h.snippet}`).join("\n") : "no memory hits"
  }
  if (name === "memory_read") return readMemory(train, jsonArg(args, "name"))
  if (name === "memory_write") {
    const n = writeMemory(train, jsonArg(args, "name"), jsonArg(args, "body"))
    return `wrote memory entry "${n}" (~/.aq/memory)`
  }
  if (name === "tools_search") return formatCards(searchTools(train, jsonArg(args, "query")))
  if (name === "ls") {
    const p = typeof args.path === "string" && args.path.trim() ? args.path : "."
    return ls(train, p)
  }
  if (name === "find") {
    const root = typeof args.path === "string" && args.path.trim() ? args.path : "."
    return findPaths(train, jsonArg(args, "query"), root)
  }
  if (name === "glob") {
    const root = typeof args.path === "string" && args.path.trim() ? args.path : "."
    return globPaths(train, jsonArg(args, "pattern"), root)
  }
  if (name === "grep") {
    const root = typeof args.path === "string" && args.path.trim() ? args.path : "."
    const g = typeof args.glob === "string" ? args.glob : ""
    return grepFiles(train, jsonArg(args, "query"), root, g)
  }
  if (name === "read") return readPath(train, jsonArg(args, "path"))
  if (name === "write") return writeFileAt(train, jsonArg(args, "path"), jsonArg(args, "content"))
  if (name === "edit") {
    const all = args.all === true
    return editFileAt(train, jsonArg(args, "path"), jsonArg(args, "old"), jsonArg(args, "new"), all)
  }
  if (name === "mkdir") return mkdirAt(train, jsonArg(args, "path"))
  if (name === "mv") return mvAt(train, jsonArg(args, "from"), jsonArg(args, "to"))
  if (name === "cp") return cpAt(train, jsonArg(args, "from"), jsonArg(args, "to"))
  if (name === "rm") return rmAt(train, jsonArg(args, "path"))
  if (name === "web_search") {
    const n = typeof args.count === "number" ? args.count : Number(args.count)
    return webSearch(jsonArg(args, "query"), Number.isFinite(n) ? n : 5)
  }
  if (name === "web_fetch") return webFetch(jsonArg(args, "url"))
  if (name === "skill_load") return activateSkill(train, jsonArg(args, "name"))
  if (name === "skill_run") {
    const extra = typeof args.args === "string" ? args.args.trim().split(/\s+/).filter(Boolean) : []
    return runSkillCode(train, jsonArg(args, "name"), extra)
  }
  if (name === "skills_search") {
    const q = typeof args.query === "string" ? args.query : ""
    const hits = searchSkills(train, q)
    return hits.length ? hits.map((h) => `${h.name}: ${h.blurb}`).join("\n") : "no skills"
  }
  if (name === "plot") {
    const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "all"
    return runAq(train, ["plot", kind])
  }
  if (name === "spawn") {
    const spec = await startAgent(train, jsonArg(args, "prompt"), {
      name: typeof args.name === "string" ? args.name : undefined,
      kill: args.kill === true,
    })
    return `spawned ${spec.id}  ${spec.status}  ${spec.name}\njob ${spec.jobId}`
  }
  if (name === "spawn_list") return formatAgents(train)
  if (name === "spawn_log") return agentLog(train, jsonArg(args, "id"))
  if (name === "spawn_cancel") {
    const spec = await cancelAgent(train, jsonArg(args, "id"))
    return `canceled ${spec.id}  ${spec.status}`
  }
  if (name === "aq" || name.startsWith("aq_")) {
    const extra = typeof args.args === "string" ? args.args.trim().split(/\s+/).filter(Boolean) : []
    const parts = name === "aq" ? extra : [name.slice(3), ...extra]
    return runAq(train, parts)
  }
  throw new Error(`unknown tool ${name}`)
}

function sanitizeAqParts(parts: string[]): string[] {
  const out = [...parts]
  if (out[0] === "jobs" && (out[1] === "logs" || out[1] === "log")) {
    const hasOnce = out.includes("--once") || out.includes("--no-follow")
    const hasFollow = out.includes("-f") || out.includes("--follow")
    // Agent must never hang on tail -f unless explicitly asked to follow.
    if (!hasOnce && !hasFollow) out.push("--once")
  }
  return out
}

function runAq(train: string, parts: string[]): string {
  const rawHead = parts[0]
  const safe = sanitizeAqParts(parts)
  const head = safe[0]
  if (!head || !ALLOW.has(head)) throw new Error(`blocked aq ${rawHead ?? "(empty)"}`)
  const noTrainOk = new Set([
    "init",
    "help",
    "places",
    "add",
    "version",
    "launch",
    "sync",
    "go",
    "shutdown",
    "jobs",
    "queue",
    "port",
    "tag",
    "provider",
    "update",
  ])
  if (!noTrainOk.has(head) && !isTrain(train) && !trainInArgv(train, safe)) {
    const kids = childTrains(train)
    const hint = kids.length
      ? `pass a train folder in args (e.g. "${kids[0]}") or cd into it`
      : "use aq_init first, then pass that folder in args"
    throw new Error(`cwd is not a train; ${hint}`)
  }
  const timeout = head === "jobs" && safe[1] === "wait" ? 3_600_000 : LONG_AQ.has(head) ? 600_000 : 120_000
  // Live TTY for wait so status/log polls stream into the chat (no hang-follow).
  const liveWait = head === "jobs" && safe[1] === "wait" && process.stdout.isTTY === true
  const r = spawnSync(aqBin(), safe, {
    cwd: train,
    encoding: "utf8",
    timeout,
    stdio: liveWait ? "inherit" : undefined,
    env: { ...process.env, AQ_QUIET: "1", AQ_AGENT: "1" },
  })
  if (liveWait) {
    if (r.status !== 0) throw new Error(`aq jobs wait exit ${r.status}`)
    return `aq jobs wait finished (exit ${r.status ?? 0})`
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  if (r.status !== 0) throw new Error(out || `aq ${head} exit ${r.status}`)
  return out || "ok"
}

export function parseRunCommand(rawArgs: string): { command: string; detach: boolean } {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>
  } catch {
    throw new Error("bad tool args json")
  }
  const cmd = typeof args.command === "string" ? args.command : typeof args.args === "string" ? args.args : ""
  const out = cmd.trim()
  if (!out) throw new Error("need command")
  const detach = args.detach === true || args.background === true || args.keep === true
  return { command: out, detach }
}

export async function runDetached(train: string, command: string): Promise<string> {
  if (!isTrain(train)) throw new Error("cwd is not a train; cannot detach")
  const id = await enqueueJob(train, ["sh", "-c", command])
  const spec = await waitForPid(train, id)
  const lines = [
    `detached ${id}`,
    `status ${spec.status}`,
    spec.pid != null ? `pid ${spec.pid}` : "",
    `log jobs/${id}/log`,
  ]
  return lines.filter(Boolean).join("\n")
}

export function runShell(train: string, command: string): string {
  const r = spawnSync("sh", ["-c", command], {
    cwd: train,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, AQ_QUIET: "1" },
  })
  let out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  if (out.length > 16_000) out = out.slice(0, 16_000) + "\n…"
  if (r.status !== 0) throw new Error(out || `exit ${r.status}`)
  return out || "ok"
}
