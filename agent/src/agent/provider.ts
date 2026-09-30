/** Providers: openai, anthropic, grok, ollama. Keys live in ~/.aq/config.json. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { stdin, stderr } from "node:process"
import { dataUrl, type ChatImage } from "./image.js"

export type { ChatImage }

export type ProviderId = "openai" | "anthropic" | "grok" | "ollama"

type Kind = "openai" | "anthropic"

type Entry = {
  id: ProviderId
  aliases: string[]
  title: string
  kind: Kind
  base: string
  env: string[]
  model: string
  models: string[]
  needsKey: boolean
  window: number
}

type Saved = { key?: string; base?: string; model?: string }

type Config = {
  active?: ProviderId
  sound?: boolean
  /** Sampling temperature for agent turns. Omitted → provider default. */
  temperature?: number
  providers: Partial<Record<ProviderId, Saved>>
}

export const CATALOG: Entry[] = [
  {
    id: "openai",
    aliases: ["oai"],
    title: "OpenAI",
    kind: "openai",
    base: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    model: "gpt-5.6",
    models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    needsKey: true,
    window: 1_000_000,
  },
  {
    id: "anthropic",
    aliases: ["claude"],
    title: "Anthropic",
    kind: "anthropic",
    base: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-haiku-4-5"],
    needsKey: true,
    window: 1_000_000,
  },
  {
    id: "grok",
    aliases: ["xai", "x"],
    title: "Grok (xAI)",
    kind: "openai",
    base: "https://api.x.ai/v1",
    env: ["XAI_API_KEY", "GROK_API_KEY"],
    model: "grok-4.6",
    models: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"],
    needsKey: true,
    window: 500_000,
  },
  {
    id: "ollama",
    aliases: ["local"],
    title: "Ollama",
    kind: "openai",
    base: "http://127.0.0.1:11434/v1",
    env: [],
    model: "qwen3",
    models: ["qwen3", "qwen3.8", "llama4", "gemma4", "deepseek-r1", "gpt-oss"],
    needsKey: false,
    window: 32_768,
  },
]

export const SLASH = [
  { name: "/help", hint: "commands" },
  { name: "/new", hint: "start a new chat" },
  { name: "/rename", hint: "rename this chat" },
  { name: "/chats", hint: "list chats" },
  { name: "/open", hint: "open a chat by name or id" },
  { name: "/delete", hint: "delete this chat · /delete all" },
  { name: "/compact", hint: "summarize older messages" },
  { name: "/undo", hint: "undo last agent turn" },
  { name: "/image", hint: "attach an image by path" },
  { name: "/context", hint: "context window use" },
  { name: "/status", hint: "session snapshot" },
  { name: "/doctor", hint: "health check" },
  { name: "/spawn", hint: "worker agents" },
  { name: "/provider", hint: "openai · anthropic · grok · ollama" },
  { name: "/model", hint: "set model id" },
  { name: "/temp", hint: "sampling temperature 0–2 · /temp show|reset" },
  { name: "/key", hint: "paste an api key · /api" },
  { name: "/sound", hint: "on · off" },
  { name: "/exit", hint: "leave" },
] as const

const SLASH_ALIAS: Record<string, string> = {
  "/quit": "/exit",
  "/name": "/rename",
  "/chat": "/open",
  "/newchat": "/new",
  "/img": "/image",
  "/temperature": "/temp",
  "/api": "/key",
}

const SYSTEM =
  "You are aq, the Aquin agent. The current directory is the workspace. Be concise. Unix. No markdown tables."

function configDir(): string {
  return path.join(homedir(), ".aq")
}

function configPath(): string {
  return path.join(configDir(), "config.json")
}

export function parseProvider(raw: string): ProviderId | null {
  const s = raw.trim().toLowerCase()
  for (const e of CATALOG) {
    if (e.id === s || e.aliases.includes(s)) return e.id
  }
  return null
}

export function entry(id: ProviderId): Entry {
  return CATALOG.find((e) => e.id === id)!
}

function load(): Config {
  const p = configPath()
  if (!existsSync(p)) return { providers: {} }
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Config
    if (!j.providers || typeof j.providers !== "object") return { providers: {} }
    return j
  } catch {
    return { providers: {} }
  }
}

function save(cfg: Config): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = configPath()
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
  chmodSync(p, 0o600)
}

function keyFor(e: Entry, saved?: Saved): string | undefined {
  if (saved?.key) return saved.key
  for (const name of e.env) {
    const v = process.env[name]
    if (v) return v
  }
  if (!e.needsKey) return "ollama"
  return undefined
}

export function hasCreds(id: ProviderId): boolean {
  const e = entry(id)
  return Boolean(keyFor(e, load().providers[id]))
}

export function activeId(): ProviderId | undefined {
  const cfg = load()
  if (cfg.active && hasCreds(cfg.active)) return cfg.active
  for (const e of CATALOG) if (hasCreds(e.id)) return e.id
  return undefined
}

export function activeLabel(): string {
  const id = activeId()
  if (!id) return "no provider"
  const e = entry(id)
  const model = load().providers[id]?.model ?? e.model
  return `${id}/${model}`
}

export function contextWindow(): number {
  const id = activeId()
  if (!id) return 128_000
  return entry(id).window
}

export function soundEnabled(): boolean {
  if (process.env.AQ_QUIET === "1") return false
  return load().sound !== false
}

export function toggleSound(): boolean {
  const cfg = load()
  cfg.sound = cfg.sound === false
  save(cfg)
  return cfg.sound !== false
}

export function setSound(on: boolean): string {
  const cfg = load()
  cfg.sound = on
  save(cfg)
  return on ? "sound on" : "sound off"
}

const TEMP_MIN = 0
const TEMP_MAX = 2

/** Current temperature, or undefined = provider default (not sent). */
export function temperature(): number | undefined {
  const t = load().temperature
  if (t == null || Number.isNaN(t)) return undefined
  return t
}

export function temperatureLabel(): string {
  const t = temperature()
  return t == null ? "default" : String(t)
}

/** Body field for API calls — empty object if unset. */
export function temperatureBody(): { temperature?: number } {
  const t = temperature()
  return t == null ? {} : { temperature: t }
}

export function setTemperature(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s || s === "show" || s === "get" || s === "?") {
    return `temperature  ${temperatureLabel()}`
  }
  if (s === "reset" || s === "clear" || s === "default" || s === "off") {
    const cfg = load()
    delete cfg.temperature
    save(cfg)
    return "temperature  default (provider)"
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return "usage: /temp <0–2> | /temp | /temp reset"
  if (n < TEMP_MIN || n > TEMP_MAX) return `temperature must be ${TEMP_MIN}–${TEMP_MAX}`
  const cfg = load()
  cfg.temperature = Math.round(n * 1000) / 1000
  save(cfg)
  return `temperature  ${cfg.temperature}`
}

export function setActive(id: ProviderId): string {
  if (!hasCreds(id)) return `no key for ${id}. aq provider ${id}`
  const cfg = load()
  cfg.active = id
  save(cfg)
  return "active  " + activeLabel()
}

export function setModel(model: string): string {
  const id = activeId()
  if (!id) return "no provider. aq provider openai"
  const cfg = load()
  cfg.providers[id] = { ...cfg.providers[id], model }
  save(cfg)
  return "active  " + activeLabel()
}

export function setKey(id: ProviderId, key: string): string {
  const k = key.trim()
  if (!k) return "empty key"
  const cfg = load()
  cfg.providers[id] = { ...cfg.providers[id], key: k }
  cfg.active = id
  save(cfg)
  return "saved  " + activeLabel()
}

export type MenuId = "root" | "provider" | "model" | "key" | "context" | "chats" | "chat" | "chat-delete" | "spawn" | "spawn-agent"

export type Choice = {
  id: string
  label: string
  hint: string
  kind:
    | "open"
    | "set-provider"
    | "set-model"
    | "ask-key"
    | "toggle-sound"
    | "help"
    | "quit"
    | "back"
    | "info"
    | "open-chat"
    | "new-chat"
    | "focus-chat"
    | "rename-chat"
    | "delete-chat"
    | "confirm-delete"
    | "compact"
    | "spawn-new"
    | "focus-spawn"
    | "spawn-log"
    | "spawn-cancel"
    | "spawn-watch"
  open?: MenuId
}

export function menuChoices(
  screen: MenuId,
  ctx?: {
    pct: string
    line: string
    parts: { label: string; hint: string }[]
    path?: string
    chats?: { id: string; name: string }[]
    chatFocus?: { id: string; name: string }
    currentChatId?: string
    chatQuery?: string
    full?: boolean
    agents?: { id: string; name: string; status: string }[]
    spawnFocus?: { id: string; name: string; status: string }
  },
): Choice[] {
  const cfg = load()
  const active = activeId()
  if (screen === "spawn") {
    const q = ctx?.chatQuery?.trim() ?? ""
    const rows: Choice[] = (ctx?.agents ?? [])
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q) || a.status.includes(q))
      .map((a) => ({
        id: a.id,
        label: a.name,
        hint: `${a.status}  ${a.id}`,
        kind: "focus-spawn" as const,
      }))
    if (!q) {
      rows.unshift({ id: "new", label: "new agent", hint: "type a task", kind: "spawn-new" })
      rows.unshift({ id: "watch", label: "watch all", hint: "status + last log line", kind: "spawn-watch" })
    }
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  if (screen === "spawn-agent") {
    const focus = ctx?.spawnFocus
    return [
      { id: "log", label: "log", hint: focus?.status ?? "", kind: "spawn-log" },
      { id: "cancel", label: "cancel", hint: focus?.id ?? "", kind: "spawn-cancel" },
      { id: "back", label: "back", hint: "", kind: "open", open: "spawn" },
    ]
  }
  if (screen === "chats") {
    const q = ctx?.chatQuery?.trim() ?? ""
    const rows: Choice[] = (ctx?.chats ?? []).map((c) => ({
      id: c.id,
      label: c.name,
      hint: c.id === ctx?.currentChatId ? `${c.id}  ←` : c.id,
      kind: "focus-chat" as const,
    }))
    if (!q) rows.unshift({ id: "new", label: "new chat", hint: "", kind: "new-chat" })
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  if (screen === "chat") {
    const focus = ctx?.chatFocus
    return [
      { id: "open", label: "open", hint: focus?.name ?? "", kind: "open-chat" },
      { id: "rename", label: "rename", hint: "type a new name", kind: "rename-chat" },
      { id: "delete", label: "delete", hint: focus?.id ?? "", kind: "delete-chat" },
      { id: "back", label: "back", hint: "", kind: "open", open: "chats" },
    ]
  }
  if (screen === "chat-delete") {
    const focus = ctx?.chatFocus
    return [
      { id: "yes", label: "delete", hint: focus?.name ?? "", kind: "confirm-delete" },
      { id: "no", label: "cancel", hint: "", kind: "open", open: "chat" },
    ]
  }
  if (screen === "context") {
    const rows: Choice[] = (ctx?.parts ?? []).map((p) => ({
      id: p.label,
      label: p.label,
      hint: p.hint,
      kind: "info" as const,
    }))
    if (ctx?.line) {
      rows.unshift({ id: "used", label: "used", hint: ctx.line, kind: "info" })
    }
    rows.unshift({
      id: "compact",
      label: "compact",
      hint: ctx?.full ? "context full" : "summarize older chat",
      kind: "compact",
    })
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  if (screen === "key") {
    const rows: Choice[] = CATALOG.filter((e) => e.needsKey).map((e) => ({
      id: e.id,
      label: e.id,
      hint: hasCreds(e.id) ? "replace" : "paste key",
      kind: "ask-key" as const,
    }))
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  if (screen === "provider") {
    const rows: Choice[] = CATALOG.map((e) => {
      const on = e.id === active
      const ok = hasCreds(e.id)
      return {
        id: e.id,
        label: e.id,
        hint: `${ok ? "set" : "paste key"}${on ? "  ←" : ""}`,
        kind: ok || !e.needsKey ? ("set-provider" as const) : ("ask-key" as const),
      }
    })
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  if (screen === "model") {
    const id = active
    if (!id) {
      return [{ id: "back", label: "back", hint: "no provider", kind: "back" }]
    }
    const e = entry(id)
    const cur = cfg.providers[id]?.model ?? e.model
    const ids = [...new Set([cur, ...e.models])]
    const rows: Choice[] = ids.map((m) => ({
      id: m,
      label: m,
      hint: m === cur ? "←" : "",
      kind: "set-model" as const,
    }))
    rows.push({ id: "back", label: "back", hint: "", kind: "back" })
    return rows
  }
  return [
    {
      id: "path",
      label: "path",
      hint: ctx?.path ?? "—",
      kind: "info",
    },
    {
      id: "chats",
      label: "chats",
      hint: "open · rename · delete",
      kind: "open",
      open: "chats",
    },
    {
      id: "spawn",
      label: "spawn",
      hint: "worker agents",
      kind: "open",
      open: "spawn",
    },
    {
      id: "context",
      label: "context",
      hint: ctx?.pct ?? "—",
      kind: "open",
      open: "context",
    },
    {
      id: "compact",
      label: "compact",
      hint: ctx?.full ? "context full" : "summarize older chat",
      kind: "compact",
    },
    {
      id: "provider",
      label: "provider",
      hint: active ?? "none",
      kind: "open",
      open: "provider",
    },
    {
      id: "model",
      label: "model",
      hint: active ? (cfg.providers[active]?.model ?? entry(active).model) : "—",
      kind: "open",
      open: "model",
    },
    {
      id: "key",
      label: "api key",
      hint: "paste openai / anthropic / grok",
      kind: "open",
      open: "key",
    },
    {
      id: "sound",
      label: "sound",
      hint: soundEnabled() ? "on" : "off",
      kind: "toggle-sound",
    },
    { id: "help", label: "help", hint: "what this agent can do", kind: "help" },
    { id: "exit", label: "exit", hint: "leave", kind: "quit" },
  ]
}

export function applyChoice(c: Choice): {
  text?: string
  quit?: boolean
  open?: MenuId
  promptKey?: ProviderId
  newChat?: boolean
  focusChat?: string
  renameChat?: boolean
  resumeChat?: boolean
  confirmDelete?: boolean
  compact?: boolean
  spawnNew?: boolean
  focusSpawn?: string
  spawnLog?: boolean
  spawnCancel?: boolean
  spawnWatch?: boolean
} {
  if (c.kind === "open") return { open: c.open ?? "root" }
  if (c.kind === "compact") return { compact: true }
  if (c.kind === "spawn-new") return { spawnNew: true }
  if (c.kind === "focus-spawn") return { open: "spawn-agent", focusSpawn: c.id }
  if (c.kind === "spawn-log") return { spawnLog: true }
  if (c.kind === "spawn-cancel") return { spawnCancel: true }
  if (c.kind === "spawn-watch") return { spawnWatch: true }
  if (c.kind === "focus-chat") return { open: "chat", focusChat: c.id }
  if (c.kind === "open-chat") return { resumeChat: true }
  if (c.kind === "new-chat") return { newChat: true }
  if (c.kind === "rename-chat") return { renameChat: true }
  if (c.kind === "delete-chat") return { open: "chat-delete" }
  if (c.kind === "confirm-delete") return { confirmDelete: true }
  if (c.kind === "info") return {}
  if (c.kind === "back") return { open: "root" }
  if (c.kind === "quit") return { quit: true }
  if (c.kind === "toggle-sound") {
    const on = toggleSound()
    return { text: on ? "sound on" : "sound off", open: "root" }
  }
  if (c.kind === "ask-key") {
    const id = parseProvider(c.id)
    if (!id) return { text: "unknown provider", open: "key" }
    return { promptKey: id }
  }
  if (c.kind === "set-provider") {
    const id = parseProvider(c.id)
    if (!id) return { text: "unknown provider", open: "provider" }
    if (!hasCreds(id) && entry(id).needsKey) return { promptKey: id }
    const text = setActive(id)
    return { text, open: "root" }
  }
  if (c.kind === "set-model") {
    return { text: setModel(c.id), open: "root" }
  }
  if (c.kind === "help") {
    return {
      text: [
        "settings  (type /  then arrows, enter)",
        "  provider   pick openai / anthropic / grok / ollama",
        "  api key    paste a key in the composer (hidden)",
        "  model      pick a model for the active provider",
        "  path       this train directory",
        "  chats      new, open, rename, delete",
        "  spawn      worker agents",
        "  context    how full the context window is",
        "  compact    summarize older chat",
        "  sound      click + message cues",
        "",
        "slash: /new /rename /open /delete [/delete all] /compact /undo /image /status /doctor /spawn /provider /model /temp /key /sound",
        "",
        "keys: aq provider openai",
        "now: " + activeLabel(),
      ].join("\n"),
      open: "root",
    }
  }
  return { open: "root" }
}

export function listText(): string {
  const cfg = load()
  const active = activeId()
  const lines = ["providers", ""]
  for (const e of CATALOG) {
    const mark = e.id === active ? "*" : " "
    const ok = hasCreds(e.id) ? "set" : "—"
    const model = cfg.providers[e.id]?.model ?? e.model
    lines.push(` ${mark} ${e.id.padEnd(10)} ${ok.padEnd(3)}  ${model}`)
  }
  lines.push("")
  lines.push("aq provider openai")
  lines.push("then paste the api key. ollama needs no key.")
  return lines.join("\n")
}

export function slashMatches(draft: string): { name: string; hint: string }[] {
  const d = draft.trim()
  if (!d.startsWith("/")) return []
  const cmd = d.split(/\s/)[0] ?? d
  return SLASH.filter((s) => s.name.startsWith(cmd)).map((s) => ({
    name: s.name,
    hint: s.hint,
  }))
}

export type SlashResult = {
  quit?: boolean
  text?: string
  compact?: boolean
  undo?: boolean
  newChat?: boolean
  rename?: true | string
  chats?: boolean
  open?: string
  delete?: true | string
  deleteAll?: boolean
  context?: boolean
  status?: boolean
  doctor?: boolean
  spawn?: boolean
  spawnRun?: string
  spawnList?: boolean
  spawnLog?: string
  spawnCancel?: string
  promptKey?: ProviderId
  openKey?: boolean
  image?: { path: string; caption: string }
}

function resolveSlash(cmd: string): string {
  const aliased = SLASH_ALIAS[cmd] ?? cmd
  const hits = SLASH.map((s) => s.name).filter((n) => n === aliased || n.startsWith(aliased))
  if (hits.length === 1) return hits[0]!
  return aliased
}

async function readLine(label: string, secret: boolean): Promise<string> {
  if (stdin.isTTY !== true) throw new Error("need a TTY to enter a key")
  stderr.write(label)
  if (!secret) {
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: stdin, output: stderr })
    try {
      return (await rl.question("")).trim()
    } finally {
      rl.close()
    }
  }
  return new Promise((resolve, reject) => {
    const prev = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    let buf = ""
    const onData = (c: Buffer) => {
      const s = c.toString("utf8")
      if (s === "\r" || s === "\n") {
        cleanup()
        stderr.write("\n")
        resolve(buf.trim())
        return
      }
      if (s === "\u0003") {
        cleanup()
        reject(new Error("cancelled"))
        return
      }
      if (s === "\u007f" || s === "\b") {
        buf = buf.slice(0, -1)
        return
      }
      if (s.charCodeAt(0) >= 32) buf += s
    }
    const cleanup = () => {
      stdin.off("data", onData)
      if (stdin.isTTY) stdin.setRawMode(Boolean(prev))
    }
    stdin.on("data", onData)
  })
}

export async function providerCmd(argv: string[]): Promise<void> {
  const a = argv[0]
  if (!a || a === "list" || a === "ls") {
    console.log(listText())
    return
  }
  if (a === "use" && argv[1]) {
    const id = parseProvider(argv[1])
    if (!id) throw new Error(`unknown provider: ${argv[1]}`)
    if (!hasCreds(id)) throw new Error(`no key for ${id}. aq provider ${id}`)
    const cfg = load()
    cfg.active = id
    save(cfg)
    console.log("active  " + activeLabel())
    return
  }
  const id = parseProvider(a)
  if (!id) throw new Error(`unknown provider: ${a}\n` + listText())
  const e = entry(id)
  const cfg = load()
  const cur = cfg.providers[id] ?? {}
  if (e.needsKey) {
    const key = await readLine(`${e.id} api key: `, true)
    if (!key) throw new Error("empty key")
    cur.key = key
  }
  if (id === "ollama") {
    const base = await readLine(`ollama base [${e.base}]: `, false)
    if (base) cur.base = base.replace(/\/$/, "")
    const model = await readLine(`ollama model [${cur.model ?? e.model}]: `, false)
    if (model) cur.model = model
  }
  cfg.providers[id] = cur
  cfg.active = id
  save(cfg)
  console.log("set")
  console.log("  " + activeLabel())
}

export function runSlash(line: string): SlashResult {
  const t = line.trim()
  const [raw, ...rest] = t.split(/\s+/)
  const arg = rest.join(" ").trim()
  const cmd = resolveSlash(raw ?? "")
  if (cmd === "/exit") return { quit: true }
  if (cmd === "/compact") return { compact: true }
  if (cmd === "/undo") return { undo: true }
  if (cmd === "/image") {
    if (!arg) return { text: "usage: /image <path> [text]" }
    const sp = arg.trim().startsWith('"') || arg.trim().startsWith("'")
    let file = arg.trim()
    let caption = ""
    if (sp) {
      const q = file[0]!
      const end = file.indexOf(q, 1)
      if (end < 0) return { text: "unclosed quote" }
      caption = file.slice(end + 1).trim()
      file = file.slice(1, end)
    } else {
      const i = file.search(/\s/)
      if (i >= 0) {
        caption = file.slice(i).trim()
        file = file.slice(0, i)
      }
    }
    return { image: { path: file, caption } }
  }
  if (cmd === "/new") return { newChat: true }
  if (cmd === "/rename") return { rename: arg || true }
  if (cmd === "/chats") return { chats: true }
  if (cmd === "/open") return arg ? { open: arg } : { chats: true }
  if (cmd === "/delete") {
    if (arg && /^(all|\*)$/i.test(arg.trim())) return { deleteAll: true }
    return { delete: arg || true }
  }
  if (cmd === "/context") return { context: true }
  if (cmd === "/status") return { status: true }
  if (cmd === "/doctor") return { doctor: true }
  if (cmd === "/spawn") {
    if (!arg) return { spawn: true }
    const [head, ...rest] = arg.split(/\s+/)
    if (head === "list") return { spawnList: true }
    if (head === "log") return { spawnLog: rest.join(" ").trim() }
    if (head === "cancel") return { spawnCancel: rest.join(" ").trim() }
    if (head === "agent" || head === "run") return { spawnRun: rest.join(" ").trim() }
    return { spawnRun: arg }
  }
  if (cmd === "/key") {
    if (!arg) return { openKey: true }
    const id = parseProvider(arg)
    if (!id) return { text: `unknown provider: ${arg}` }
    return { promptKey: id }
  }
  if (cmd === "/sound") {
    if (!arg || arg === "toggle") {
      const on = toggleSound()
      return { text: on ? "sound on" : "sound off" }
    }
    if (arg === "on") return { text: setSound(true) }
    if (arg === "off") return { text: setSound(false) }
    return { text: "usage: /sound on|off" }
  }
  if (cmd === "/help") {
    return {
      text: [
        "slash",
        "",
        ...SLASH.map((s) => `  ${s.name.padEnd(10)} ${s.hint}`),
        "",
        "aliases: /name /chat /quit",
        "set a key: /key openai",
        "now: " + activeLabel(),
      ].join("\n"),
    }
  }
  if (cmd === "/provider") {
    if (!arg) return { text: listText() }
    const id = parseProvider(arg)
    if (!id) return { text: `unknown provider: ${arg}\n` + listText() }
    if (!hasCreds(id)) return { text: `no key for ${id}. /key ${id}` }
    const cfg = load()
    cfg.active = id
    save(cfg)
    return { text: "active  " + activeLabel() }
  }
  if (cmd === "/model") {
    const id = activeId()
    if (!id) return { text: "no provider. /provider openai" }
    if (!arg) return { text: "usage: /model <id>" }
    const cfg = load()
    cfg.providers[id] = { ...cfg.providers[id], model: arg }
    save(cfg)
    return { text: "active  " + activeLabel() }
  }
  if (cmd === "/temp") {
    return { text: setTemperature(arg) }
  }
  const hits = slashMatches(raw ?? "")
  if (hits.length > 1) {
    return { text: `ambiguous slash: ${raw}\n` + hits.map((h) => `  ${h.name.padEnd(10)} ${h.hint}`).join("\n") }
  }
  return { text: `unknown slash: ${raw}. /help` }
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("empty stream")
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (;;) {
      const n = buf.indexOf("\n")
      if (n < 0) break
      const line = buf.slice(0, n).replace(/\r$/, "")
      buf = buf.slice(n + 1)
      yield line
    }
  }
  if (buf.trim()) yield buf.replace(/\r$/, "")
}

function openaiDelta(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const raw = line.slice(5).trim()
  if (!raw || raw === "[DONE]") return null
  let j: {
    choices?: { delta?: { content?: string } }[]
    error?: { message?: string }
  }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    return null
  }
  if (j.error?.message) throw new Error(j.error.message)
  return j.choices?.[0]?.delta?.content ?? ""
}

function anthropicDelta(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const raw = line.slice(5).trim()
  if (!raw) return null
  let j: {
    type?: string
    delta?: { type?: string; text?: string }
    error?: { message?: string }
  }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    return null
  }
  if (j.error?.message) throw new Error(j.error.message)
  if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
    return j.delta.text ?? ""
  }
  return ""
}

export type ChatMsg = {
  role: "user" | "assistant" | "tool"
  content: string
  images?: ChatImage[]
  tool_calls?: { id: string; name: string; args: string }[]
  tool_call_id?: string
}

export type AgentToolJson = {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

export type StreamOut = {
  text: string
  toolCalls: { id: string; name: string; args: string }[]
}

function openaiMessages(system: string, history: ChatMsg[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }]
  for (const m of history) {
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.tool_call_id })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      })
      continue
    }
    if (m.role === "user" && m.images?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const img of m.images) {
        content.push({ type: "image_url", image_url: { url: dataUrl(img) } })
      }
      out.push({ role: "user", content })
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

function anthropicMessages(history: ChatMsg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of history) {
    if (m.role === "tool") {
      const prev = out[out.length - 1]
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        ;(prev.content as unknown[]).push(block)
      } else {
        out.push({ role: "user", content: [block] })
      }
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const c of m.tool_calls) {
        let input: unknown = {}
        try {
          input = JSON.parse(c.args || "{}")
        } catch {
          input = {}
        }
        content.push({ type: "tool_use", id: c.id, name: c.name, input })
      }
      out.push({ role: "assistant", content })
      continue
    }
    if (m.role === "user" && m.images?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const img of m.images) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mime, data: img.data },
        })
      }
      out.push({ role: "user", content })
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

function openaiTools(tools: AgentToolJson[]) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function responsesFunctionTools(tools: AgentToolJson[]) {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

function anthropicTools(tools: AgentToolJson[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

function nativeWebSearch(id: ProviderId): boolean {
  return id === "openai" || id === "anthropic" || id === "grok"
}

function clientTools(id: ProviderId, tools: AgentToolJson[]): AgentToolJson[] {
  if (!nativeWebSearch(id)) return tools
  return tools.filter((t) => t.name !== "web_search")
}

function wantsWebSearch(tools: AgentToolJson[]): boolean {
  return tools.some((t) => t.name === "web_search")
}

function responsesInput(history: ChatMsg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of history) {
    if (m.role === "tool") {
      out.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) out.push({ role: "assistant", content: m.content })
      for (const c of m.tool_calls) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.args })
      }
      continue
    }
    if (m.role === "user" && m.images?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: "input_text", text: m.content })
      for (const img of m.images) {
        content.push({ type: "input_image", image_url: dataUrl(img) })
      }
      out.push({ role: "user", content })
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

async function streamResponses(
  base: string,
  key: string,
  model: string,
  system: string,
  history: ChatMsg[],
  fns: AgentToolJson[],
  search: boolean,
  onDelta: (chunk: string) => void,
  id: ProviderId,
): Promise<StreamOut> {
  const tools: Record<string, unknown>[] = []
  if (search) tools.push({ type: "web_search" })
  tools.push(...responsesFunctionTools(fns))
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      instructions: system,
      input: responsesInput(history),
      ...temperatureBody(),
      ...(tools.length ? { tools } : {}),
      ...(id === "openai" && fns.length && /^gpt-5/i.test(model) ? { reasoning: { effort: "none" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(body.error?.message ?? `${id} ${res.status}`)
  }
  let text = ""
  const calls: { id: string; name: string; args: string }[] = []
  const byIndex = new Map<number, number>()
  for await (const line of sseLines(res)) {
    if (!line.startsWith("data:")) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let j: {
      type?: string
      delta?: string
      output_index?: number
      item?: { type?: string; call_id?: string; name?: string; arguments?: string }
      error?: { message?: string }
    }
    try {
      j = JSON.parse(raw) as typeof j
    } catch {
      continue
    }
    if (j.error?.message) throw new Error(j.error.message)
    const typ = j.type ?? ""
    if (
      (typ === "response.output_text.delta" || typ === "response.text.delta") &&
      typeof j.delta === "string" &&
      j.delta
    ) {
      text += j.delta
      onDelta(j.delta)
    }
    if (typ === "response.output_item.added" && j.item?.type === "function_call") {
      const idx = j.output_index ?? calls.length
      byIndex.set(idx, calls.length)
      calls.push({
        id: j.item.call_id ?? `call_${calls.length}`,
        name: j.item.name ?? "",
        args: j.item.arguments ?? "",
      })
    }
    if (typ === "response.function_call_arguments.delta" && typeof j.delta === "string") {
      const i = byIndex.get(j.output_index ?? 0)
      if (i != null && calls[i]) calls[i]!.args += j.delta
    }
  }
  const toolCalls = calls.filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` }))
  if (!text && !toolCalls.length) throw new Error("empty reply")
  return { text, toolCalls }
}

export async function streamTurn(
  history: ChatMsg[],
  onDelta: (chunk: string) => void,
  opts: { system: string; tools: AgentToolJson[] },
): Promise<StreamOut> {
  const id = activeId()
  if (!id) throw new Error("no provider. aq provider openai")
  const e = entry(id)
  const cfg = load()
  const saved = cfg.providers[id]
  const key = keyFor(e, saved)
  if (!key) throw new Error(`no key for ${id}. aq provider ${id}`)
  const model = saved?.model ?? e.model
  const base = (saved?.base ?? e.base).replace(/\/$/, "")
  const system = opts.system
  const tools = opts.tools
  const fns = clientTools(id, tools)

  if (e.kind === "anthropic") {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        stream: true,
        system,
        messages: anthropicMessages(history),
        ...temperatureBody(),
        ...(fns.length || wantsWebSearch(tools)
          ? {
              tools: [
                ...(wantsWebSearch(tools)
                  ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
                  : []),
                ...anthropicTools(fns),
              ],
            }
          : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      throw new Error(body.error?.message ?? `anthropic ${res.status}`)
    }
    let text = ""
    const blocks: { id: string; name: string; args: string }[] = []
    const byIndex = new Map<number, number>()
    for await (const line of sseLines(res)) {
      if (!line.startsWith("data:")) continue
      const raw = line.slice(5).trim()
      if (!raw) continue
      let j: {
        type?: string
        index?: number
        content_block?: { type?: string; id?: string; name?: string }
        delta?: { type?: string; text?: string; partial_json?: string }
        error?: { message?: string }
      }
      try {
        j = JSON.parse(raw) as typeof j
      } catch {
        continue
      }
      if (j.error?.message) throw new Error(j.error.message)
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) {
        text += j.delta.text
        onDelta(j.delta.text)
      }
      if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
        byIndex.set(j.index ?? 0, blocks.length)
        blocks.push({
          id: j.content_block.id ?? `tool_${blocks.length}`,
          name: j.content_block.name ?? "",
          args: "",
        })
      }
      if (j.type === "content_block_delta" && j.delta?.type === "input_json_delta") {
        const i = byIndex.get(j.index ?? 0)
        if (i != null && blocks[i]) blocks[i]!.args += j.delta.partial_json ?? ""
      }
    }
    if (!text && !blocks.length) throw new Error("empty reply")
    return { text, toolCalls: blocks.filter((b) => b.name) }
  }

  if (id === "openai" || id === "grok") {
    return streamResponses(base, key, model, system, history, fns, wantsWebSearch(tools), onDelta, id)
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: openaiMessages(system, history),
      ...temperatureBody(),
      ...(fns.length ? { tools: openaiTools(fns) } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(body.error?.message ?? `${id} ${res.status}`)
  }
  let text = ""
  const calls: { id: string; name: string; args: string }[] = []
  for await (const line of sseLines(res)) {
    if (!line.startsWith("data:")) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let j: {
      choices?: {
        delta?: {
          content?: string
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        }
      }[]
      error?: { message?: string }
    }
    try {
      j = JSON.parse(raw) as typeof j
    } catch {
      continue
    }
    if (j.error?.message) throw new Error(j.error.message)
    const delta = j.choices?.[0]?.delta
    if (delta?.content) {
      text += delta.content
      onDelta(delta.content)
    }
    for (const tc of delta?.tool_calls ?? []) {
      const i = tc.index ?? 0
      while (calls.length <= i) calls.push({ id: "", name: "", args: "" })
      const row = calls[i]!
      if (tc.id) row.id = tc.id
      if (tc.function?.name) row.name = tc.function.name
      if (tc.function?.arguments) row.args += tc.function.arguments
    }
  }
  const toolCalls = calls
    .filter((c) => c.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${i}` }))
  if (!text && !toolCalls.length) throw new Error("empty reply")
  return { text, toolCalls }
}

export async function streamChat(
  history: { role: "user" | "assistant"; content: string }[],
  onDelta: (chunk: string) => void,
): Promise<string> {
  const out = await streamTurn(
    history.map((m) => ({ role: m.role, content: m.content })),
    onDelta,
    { system: SYSTEM, tools: [] },
  )
  return out.text
}
