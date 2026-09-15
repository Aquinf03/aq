/** fx-form shell chat: inline ❯ composer in the transcript, no bottom dock, no alt-screen. */

import { stdin, stdout } from "node:process"
import { runTurn, type ChatMsg } from "./agent-loop.js"
import { renderMarkdown } from "./markdown.js"
import { compactHistory } from "./compact.js"
import { beginUndo, clearUndo, commitUndo, undoLast } from "./undo.js"
import { measureContext, contextFull } from "./context.js"
import {
  activeId,
  activeLabel,
  applyChoice,
  contextWindow,
  hasCreds,
  soundEnabled,
  menuChoices,
  temperatureLabel,
  type MenuId,
  type ProviderId,
  runSlash,
  setKey,
  slashMatches,
} from "./provider.js"
import { shortPath } from "../core/paths.js"
import { playCue } from "./sound.js"
import { loadImage, type ChatImage } from "./image.js"
import { extraTools, shutdownSkills } from "../lib/skill-runtime.js"
import { agentLog, cancelAgent, formatAgents, listAgents, startAgent } from "./spawn.js"
import { listSkills } from "../lib/skill.js"
import { formatDoctor, runDoctor } from "./doctor.js"
import { isTrain } from "../core/schema.js"
import {
  createChat,
  deleteAllChats,
  deleteChat,
  listChats,
  loadMessages,
  loadSpec,
  nameChat,
  renameChat,
  saveChat,
  setTabTitle,
  type ChatSpec,
} from "./chat-store.js"
import { frameworkVersion } from "../core/version.js"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1;38;5;255m"
const DIM = "\x1b[38;5;245m"
const PREFIX = "❯ "
const RAIL = "┃"

const VERSION = frameworkVersion().version

const ENABLE = "\x1b[?2004h"
const DISABLE = "\x1b[?2004l\x1b[?25h"

type Key =
  | { kind: "char" | "paste"; text: string }
  | {
      kind:
        | "enter"
        | "backspace"
        | "left"
        | "right"
        | "home"
        | "end"
        | "clear"
        | "clear-line"
        | "ctrl-c"
        | "ctrl-d"
        | "escape"
        | "up"
        | "down"
    }

function size(): { cols: number } {
  return { cols: Math.max(20, stdout.columns ?? 80) }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("")
      continue
    }
    const chars = Array.from(para)
    for (let i = 0; i < chars.length; i += width) {
      out.push(chars.slice(i, i + width).join(""))
    }
  }
  return out.length ? out : [""]
}

function parseKeys(chunk: Buffer, carry: Buffer): { keys: Key[]; carry: Buffer } {
  const buf = Buffer.concat([carry, chunk])
  const keys: Key[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]!
    if (b === 0x1b) {
      const rest = buf.subarray(i).toString("utf8")
      const paste = rest.match(/^\x1b\[200~([\s\S]*?)\x1b\[201~/)
      if (paste) {
        keys.push({ kind: "paste", text: paste[1] ?? "" })
        i += Buffer.byteLength(paste[0], "utf8")
        continue
      }
      if (rest.startsWith("\x1b[200~") || rest === "\x1b" || rest === "\x1b[") break
      const csi = rest.match(/^\x1b(?:\[|O)(?:\d+;)*\d*[A-Za-z~]/)
      if (rest.startsWith("\x1b[") && !csi) break
      if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
        keys.push({ kind: "up" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
        keys.push({ kind: "down" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[C") || rest.startsWith("\x1bOC")) {
        keys.push({ kind: "right" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[D") || rest.startsWith("\x1bOD")) {
        keys.push({ kind: "left" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[H") || rest.startsWith("\x1bOH")) {
        keys.push({ kind: "home" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[1~")) {
        keys.push({ kind: "home" })
        i += 4
        continue
      }
      if (rest.startsWith("\x1b[F") || rest.startsWith("\x1bOF")) {
        keys.push({ kind: "end" })
        i += 3
        continue
      }
      if (rest.startsWith("\x1b[4~")) {
        keys.push({ kind: "end" })
        i += 4
        continue
      }
      if (rest.startsWith("\x1b[3~")) {
        keys.push({ kind: "backspace" })
        i += 4
        continue
      }
      keys.push({ kind: "escape" })
      i += csi ? Buffer.byteLength(csi[0], "utf8") : 1
      continue
    }
    if (b === 0x03) {
      keys.push({ kind: "ctrl-c" })
      i += 1
      continue
    }
    if (b === 0x04) {
      keys.push({ kind: "ctrl-d" })
      i += 1
      continue
    }
    if (b === 0x0c) {
      keys.push({ kind: "clear" })
      i += 1
      continue
    }
    if (b === 0x15) {
      keys.push({ kind: "clear-line" })
      i += 1
      continue
    }
    if (b === 0x01) {
      keys.push({ kind: "home" })
      i += 1
      continue
    }
    if (b === 0x05) {
      keys.push({ kind: "end" })
      i += 1
      continue
    }
    if (b === 0x7f || b === 0x08) {
      keys.push({ kind: "backspace" })
      i += 1
      continue
    }
    if (b === 0x0d || b === 0x0a) {
      keys.push({ kind: "enter" })
      i += 1
      continue
    }
    if (b < 32) {
      i += 1
      continue
    }
    let n = 1
    if ((b & 0xe0) === 0xc0) n = 2
    else if ((b & 0xf0) === 0xe0) n = 3
    else if ((b & 0xf8) === 0xf0) n = 4
    if (i + n > buf.length) break
    keys.push({ kind: "char", text: buf.subarray(i, i + n).toString("utf8") })
    i += n
  }
  return { keys, carry: buf.subarray(i) }
}

export async function startChatUi(train: string, resumeId?: string): Promise<void> {
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("aq requires an interactive terminal (TTY)")
  }

  let restored = false
  const chars: string[] = []
  let cursor = 0
  let armed = false
  let pick = 0
  let screen: MenuId | null = null
  let keyFor: ProviderId | null = null
  let busy = false
  let spec: ChatSpec = resumeId ? loadSpec(train, resumeId) : createChat(train)
  const history: ChatMsg[] = resumeId ? loadMessages(train, spec.id) : []
  let named = spec.name !== "new chat"
  let chatFocus = spec.id
  let renameFor = false
  let spawnFor = false
  let spawnFocus = ""
  let menuRows = 0
  const pendingImages: ChatImage[] = []
  setTabTitle(spec.name)

  const nested = () => screen !== null && screen !== "root"

  const screenTitle = (s: MenuId): string => {
    if (s === "key") return "api key"
    if (s === "chat-delete") return "delete"
    if (s === "spawn") return "spawn"
    if (s === "spawn-agent") {
      const a = listAgents(train).find((x) => x.id === spawnFocus)
      return a?.name ?? "agent"
    }
    if (s === "chat") {
      if (spec.id === chatFocus) return spec.name
      try {
        return loadSpec(train, chatFocus).name
      } catch {
        return "chat"
      }
    }
    return s
  }

  const wipeMenu = () => {
    write("\r\x1b[J")
    menuRows = 0
  }

  const note = (msg: string) => {
    write(`\r\x1b[J${DIM}${msg}${RESET}\n`)
    menuRows = 0
  }

  const enterScreen = (next: MenuId) => {
    screen = next
    pick = 0
    chars.length = 0
    if (next === "root") {
      chars.push("/")
      cursor = 1
    } else {
      cursor = 0
    }
  }

  const write = (s: string) => {
    stdout.write(s)
  }

  const restore = () => {
    if (restored) return
    restored = true
    playCue("click")
    write(DISABLE)
    write("\n")
    stdin.setRawMode(false)
  }

  const menuCtx = () => {
    const snap = measureContext(train, history, contextWindow())
    const q = screen === "chats" || screen === "spawn" ? chars.join("").replace(/^\//, "").trim().toLowerCase() : ""
    let focusName = spec.name
    if (chatFocus !== spec.id) {
      try {
        focusName = loadSpec(train, chatFocus).name
      } catch {
        chatFocus = spec.id
        focusName = spec.name
      }
    }
    return {
      pct: snap.pct,
      line: snap.line,
      full: contextFull(snap),
      path: shortPath(train),
      currentChatId: spec.id,
      chatQuery: q,
      chatFocus: { id: chatFocus, name: focusName },
      chats: listChats(train)
        .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
        .map((c) => ({ id: c.id, name: c.name })),
      agents: listAgents(train).map((a) => ({ id: a.id, name: a.name, status: a.status })),
      spawnFocus: (() => {
        const a = listAgents(train).find((x) => x.id === spawnFocus)
        return a ? { id: a.id, name: a.name, status: a.status } : undefined
      })(),
      parts: snap.parts.map((p) => ({
        label: p.label,
        hint: `${Math.round((100 * p.tokens) / Math.max(1, snap.window))}%  ${p.tokens}`,
      })),
    }
  }

  const paintComposer = () => {
    const { cols } = size()
    const inside = nested()
    const title = inside && screen ? screenTitle(screen) : ""
    const promptPlain = renameFor
      ? "name: "
      : spawnFor
        ? "task: "
        : keyFor
          ? `${keyFor} api key: `
          : inside
            ? `${title} `
            : PREFIX
    const prompt = renameFor
      ? "name: "
      : spawnFor
        ? "task: "
        : keyFor
          ? `${keyFor} api key: `
          : inside
            ? `${DIM}${title}${RESET} `
            : PREFIX
    const max = Math.max(1, cols - promptPlain.length)
    let shown = chars.slice()
    let cur = cursor
    if (shown.length > max) {
      const start = Math.max(0, cur - max)
      shown = shown.slice(start, start + max)
      cur -= start
    }
    let extra = ""
    if (armed) extra = `${DIM}  press ctrl+c again to exit${RESET}`
    else if (!inside && !keyFor && !renameFor && pendingImages.length) {
      extra = `${DIM}  +${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"}${RESET}`
    } else if (!inside && !keyFor && !renameFor && contextFull(measureContext(train, history, contextWindow()))) {
      extra = `${DIM}  context full · /compact${RESET}`
    }
    const body = keyFor ? "•".repeat(shown.length) : shown.join("")
    write(`\r\x1b[K${prompt}${body}${extra}`)
    let painted = 0
    const draft = chars.join("")
    const slashHint =
      !keyFor && !renameFor && !inside && draft.startsWith("/") && draft !== "/"
    if (slashHint) {
      const hits = slashMatches(draft)
      const rows = hits.length ? hits : [{ name: draft.split(/\s/)[0] ?? draft, hint: "unknown" }]
      for (let i = 0; i < rows.length; i++) {
        const o = rows[i]!
        write(`\n${DIM}  ${o.name.padEnd(10)}  ${o.hint}${RESET}\x1b[K`)
      }
      painted = rows.length
    } else if (screen && !keyFor && !renameFor) {
      const opts = menuChoices(screen, menuCtx())
      if (pick >= opts.length) pick = 0
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i]!
        const on = i === pick
        const mark = on ? "▸" : " "
        const sty = on ? BOLD : DIM
        const hint = o.hint ? `  ${DIM}${o.hint}${RESET}` : ""
        write(`\n${sty}${mark} ${o.label.padEnd(12)}${RESET}${hint}\x1b[K`)
      }
      painted = opts.length
    }
    write("\x1b[J")
    if (painted) write(`\x1b[${painted}A`)
    menuRows = painted
    if (inside && screen !== "chats") write("\x1b[?25l")
    else write("\x1b[?25h")
    write(`\x1b[${promptPlain.length + cur + 1}G`)
  }

  const headerLine = () => {
    const snap = measureContext(train, history, contextWindow())
    return `${BOLD}aq${RESET}${DIM} ${VERSION} · ${spec.name} · ${shortPath(train)} · ${activeLabel()} · ${snap.pct} · /  settings${RESET}`
  }

  const paintHeader = () => {
    write(`\x1b7\x1b[1;1H${headerLine()}\x1b[K\x1b8`)
  }

  const sessionStatus = () => {
    const id = activeId()
    const snap = measureContext(train, history, contextWindow())
    const users = history.filter((m) => m.role === "user").length
    const asst = history.filter((m) => m.role === "assistant").length
    const imgs = history.reduce((n, m) => n + (m.images?.length ?? 0), 0)
    const mcp = extraTools(train)
    const chats = listChats(train)
    const skills = listSkills(train)
    const row = (k: string, v: string) => `  ${k.padEnd(12)}  ${v}`
    const lines = [
      "status",
      row("aq", VERSION),
      row("path", shortPath(train)),
      row("cwd", train),
      row("train", isTrain(train) ? "yes" : "no"),
      row("provider", id ?? "none"),
      row("model", id ? activeLabel() : "—"),
      row("temp", temperatureLabel()),
      row("key", id ? (hasCreds(id) ? "set" : "missing") : "—"),
      row("window", String(snap.window)),
      row("context", snap.line),
      ...snap.parts.map((p) => `  ${("ctx." + p.label).padEnd(12)}  ${p.tokens}`),
      row("sound", soundEnabled() ? "on" : "off"),
      row("chat", `${spec.name}  ${spec.id}`),
      row("created", spec.created),
      row("updated", spec.updated),
      row("messages", `${history.length}  (user ${users}  assistant ${asst})`),
      row("images", String(imgs + pendingImages.length) + (pendingImages.length ? `  (${pendingImages.length} pending)` : "")),
      row("chats", String(chats.length)),
      row("skills", skills.length ? skills.join(" ") : "none"),
      row("mcp", mcp.length ? mcp.map((t) => t.name).join(" ") : "none"),
    ]
    return lines.join("\n")
  }

  const welcome = () => {
    menuRows = 0
    write("\x1b[2J\x1b[H")
    write(`${headerLine()}\n\n`)
    if (resumeId) write(`${DIM}resumed  ${spec.name}  ${spec.id}${RESET}\n\n`)
    paintComposer()
  }

  stdin.setRawMode(true)
  stdin.resume()
  write(ENABLE)
  welcome()
  playCue("click")

  return new Promise<void>((resolve) => {
    let done = false
    let carry = Buffer.alloc(0)
    let permit: { cmd: string; pick: number; resolve: (ok: boolean) => void } | null = null

    const drawPermitChoices = () => {
      if (!permit) return
      const y = permit.pick === 0
      write(
        `\r\x1b[K  ${y ? `${BOLD}▸ yes${RESET}` : `${DIM}  yes${RESET}`}    ${!y ? `${BOLD}▸ no${RESET}` : `${DIM}  no${RESET}`}`,
      )
    }

    let compactAsk: { pick: number; yes: string; no: string; resolve: (ok: boolean) => void } | null =
      null

    const drawCompactChoices = () => {
      if (!compactAsk) return
      const y = compactAsk.pick === 0
      const yes = compactAsk.yes
      const no = compactAsk.no
      write(
        `\r\x1b[K  ${y ? `${BOLD}▸ ${yes}${RESET}` : `${DIM}  ${yes}${RESET}`}    ${!y ? `${BOLD}▸ ${no}${RESET}` : `${DIM}  ${no}${RESET}`}`,
      )
    }

    const askCompact = (): Promise<boolean> =>
      new Promise((resolve) => {
        write(`\r\x1b[K${DIM}context full  compact to keep chatting${RESET}\n`)
        compactAsk = {
          pick: 0,
          yes: "compact",
          no: "skip",
          resolve: (ok) => {
            compactAsk = null
            write("\r\x1b[K")
            write("\x1b[1A\r\x1b[K")
            resolve(ok)
          },
        }
        drawCompactChoices()
      })

    const runCompact = async () => {
      if (busy) return
      busy = true
      write("\x1b[?25l")
      write(`\r\x1b[K${DIM}compacting${RESET}\x1b[J`)
      try {
        const r = await compactHistory(train, history, contextWindow())
        if (!r.ok) note(r.skip)
        else {
          history.length = 0
          history.push(...r.history)
          saveChat(train, spec, history)
          note(`compacted  ${r.pct}`)
          paintHeader()
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        note(msg)
      }
      write("\x1b[?25h")
      busy = false
      paintComposer()
    }

    const blockIfFull = async (): Promise<boolean> => {
      if (!contextFull(measureContext(train, history, contextWindow()))) return false
      const ok = await askCompact()
      if (ok) await runCompact()
      else note("context full. /compact or start a new chat")
      paintComposer()
      return true
    }

    const quit = () => {
      if (done) return
      done = true
      saveChat(train, spec, history)
      shutdownSkills(train)
      stdin.off("data", onData)
      restore()
      resolve()
    }

    const pickItem = () => {
      if (!screen) return false
      const opts = menuChoices(screen, menuCtx())
      const c = opts[pick]
      if (!c) return true
      const r = applyChoice(c)
      if (r.quit) {
        quit()
        return true
      }
      if (r.compact) {
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        void runCompact()
        return true
      }
      if (r.spawnNew) {
        spawnFor = true
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        paintComposer()
        return true
      }
      if (r.focusSpawn) spawnFocus = r.focusSpawn
      if (r.spawnLog) {
        try {
          note(agentLog(train, spawnFocus))
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        paintComposer()
        return true
      }
      if (r.spawnCancel) {
        void cancelAgent(train, spawnFocus)
          .then((a) => {
            note(`canceled  ${a.id}  ${a.status}`)
            enterScreen("spawn")
            paintComposer()
          })
          .catch((err) => {
            note(err instanceof Error ? err.message : String(err))
            paintComposer()
          })
        return true
      }
      if (r.spawnWatch) {
        const rows = listAgents(train)
        if (!rows.length) note("no agents")
        else {
          const lines = rows.map((a) => {
            let last = ""
            try {
              last = agentLog(train, a.id, 1).split("\n").pop() ?? ""
            } catch {
              last = ""
            }
            return `${a.id}  ${a.status}  ${a.name}${last ? `\n  ${last}` : ""}`
          })
          note(lines.join("\n"))
        }
        paintComposer()
        return true
      }
      if (r.focusChat) chatFocus = r.focusChat
      if (r.resumeChat) {
        saveChat(train, spec, history)
        spec = loadSpec(train, chatFocus)
        history.length = 0
        history.push(...loadMessages(train, spec.id))
        named = spec.name !== "new chat"
        setTabTitle(spec.name)
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        note(`resumed  ${spec.name}  ${spec.id}`)
        paintHeader()
        paintComposer()
        return true
      }
      if (r.newChat) {
        saveChat(train, spec, history)
        spec = createChat(train)
        history.length = 0
        named = false
        chatFocus = spec.id
        setTabTitle(spec.name)
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        note(`new chat  ${spec.id}`)
        paintHeader()
        paintComposer()
        return true
      }
      if (r.renameChat) {
        renameFor = true
        screen = null
        let current = spec.name
        if (spec.id !== chatFocus) {
          try {
            current = loadSpec(train, chatFocus).name
          } catch {
            current = ""
          }
        }
        chars.length = 0
        if (current && current !== "new chat") chars.push(...Array.from(current))
        cursor = chars.length
        pick = 0
        paintComposer()
        return true
      }
      if (r.confirmDelete) {
        const id = chatFocus
        let goneName = id
        try {
          goneName = loadSpec(train, id).name
        } catch {
          goneName = id
        }
        saveChat(train, spec, history)
        deleteChat(train, id)
        if (spec.id === id) {
          const next = listChats(train)[0]
          if (next) {
            spec = next
            history.length = 0
            history.push(...loadMessages(train, spec.id))
            named = spec.name !== "new chat"
          } else {
            spec = createChat(train)
            history.length = 0
            named = false
          }
          setTabTitle(spec.name)
        }
        chatFocus = spec.id
        playCue("click")
        note(`deleted  ${goneName}  ${id}`)
        paintHeader()
        enterScreen("chats")
        paintComposer()
        return true
      }
      if (r.promptKey) {
        keyFor = r.promptKey
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        wipeMenu()
        paintComposer()
        return true
      }
      if (r.text) {
        playCue("click")
        write(`\r\x1b[J${DIM}${r.text}${RESET}\n`)
        write(`${DIM}${activeLabel()}${RESET}\n`)
        menuRows = 0
      }
      if (r.open) enterScreen(r.open)
      paintComposer()
      return true
    }

    const matchChats = (q: string) => {
      const all = listChats(train)
      const ql = q.toLowerCase()
      const exact = all.filter((c) => c.id === q)
      if (exact.length) return exact
      const ids = all.filter((c) => c.id.startsWith(q))
      if (ids.length === 1) return ids
      const names = all.filter((c) => c.name.toLowerCase() === ql)
      if (names.length) return names
      return all.filter((c) => c.name.toLowerCase().includes(ql) || c.id.includes(q))
    }

    const switchChat = (id: string) => {
      saveChat(train, spec, history)
      pendingImages.length = 0
      clearUndo()
      spec = loadSpec(train, id)
      history.length = 0
      history.push(...loadMessages(train, spec.id))
      named = spec.name !== "new chat"
      chatFocus = spec.id
      setTabTitle(spec.name)
      note(`opened  ${spec.name}  ${spec.id}`)
      paintHeader()
      paintComposer()
    }

    const startNew = () => {
      saveChat(train, spec, history)
      pendingImages.length = 0
      clearUndo()
      spec = createChat(train)
      history.length = 0
      named = false
      chatFocus = spec.id
      setTabTitle(spec.name)
      note(`new chat  ${spec.id}`)
      paintHeader()
      paintComposer()
    }

    const beginRename = (name?: string) => {
      if (name) {
        renameChat(train, spec, name, history)
        named = true
        setTabTitle(spec.name)
        note(`renamed  ${spec.name}  ${spec.id}`)
        paintHeader()
        paintComposer()
        return
      }
      renameFor = true
      screen = null
      chars.length = 0
      if (spec.name && spec.name !== "new chat") chars.push(...Array.from(spec.name))
      cursor = chars.length
      pick = 0
      paintComposer()
    }

    const dropChat = (id: string) => {
      let goneName = id
      try {
        goneName = loadSpec(train, id).name
      } catch {
        goneName = id
      }
      saveChat(train, spec, history)
      deleteChat(train, id)
      if (spec.id === id) {
        const next = listChats(train)[0]
        if (next) {
          spec = next
          history.length = 0
          history.push(...loadMessages(train, spec.id))
          named = spec.name !== "new chat"
        } else {
          spec = createChat(train)
          history.length = 0
          named = false
        }
        setTabTitle(spec.name)
      }
      chatFocus = spec.id
      note(`deleted  ${goneName}  ${id}`)
      paintHeader()
      paintComposer()
    }

    const askDelete = (label = "delete this chat?"): Promise<boolean> =>
      new Promise((resolve) => {
        write(`\r\x1b[K${DIM}${label}${RESET}\n`)
        compactAsk = {
          pick: 0,
          yes: "delete",
          no: "keep",
          resolve: (ok) => {
            compactAsk = null
            write("\r\x1b[K")
            write("\x1b[1A\r\x1b[K")
            resolve(ok)
          },
        }
        drawCompactChoices()
      })

    const applySlash = async (line: string) => {
      const r = runSlash(line)
      if (r.quit) {
        quit()
        return
      }
      if (r.compact) {
        await runCompact()
        return
      }
      if (r.image) {
        try {
          const img = loadImage(train, r.image.path)
          pendingImages.push(img)
          if (r.image.caption) {
            await submit(r.image.caption)
            return
          }
          note(`attached  ${img.path}`)
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        paintComposer()
        return
      }
      if (r.undo) {
        const out = undoLast(train)
        if (out.historyLen >= 0) {
          history.length = out.historyLen
          saveChat(train, spec, history)
          paintHeader()
        }
        note(out.text)
        paintComposer()
        return
      }
      if (r.newChat) {
        startNew()
        return
      }
      if (r.rename) {
        beginRename(r.rename === true ? undefined : r.rename)
        return
      }
      if (r.chats) {
        const all = listChats(train)
        const text = all.length
          ? all.map((c) => `${c.id === spec.id ? "*" : " "} ${c.id}  ${c.name}`).join("\n")
          : "no chats"
        note(text)
        paintComposer()
        return
      }
      if (r.open) {
        const hits = matchChats(r.open)
        if (!hits.length) {
          note(`no chat  ${r.open}`)
          paintComposer()
          return
        }
        if (hits.length > 1) {
          note(hits.map((c) => `  ${c.id}  ${c.name}`).join("\n"))
          paintComposer()
          return
        }
        switchChat(hits[0]!.id)
        return
      }
      if (r.deleteAll) {
        const n = listChats(train).length
        if (!n) {
          note("no chats")
          paintComposer()
          return
        }
        const ok = await askDelete(`delete all ${n} chat${n === 1 ? "" : "s"} for this train?`)
        if (!ok) {
          note("kept")
          paintComposer()
          return
        }
        saveChat(train, spec, history)
        const gone = deleteAllChats(train)
        spec = createChat(train)
        history.length = 0
        named = false
        chatFocus = spec.id
        setTabTitle(spec.name)
        playCue("click")
        note(`deleted  ${gone} chat${gone === 1 ? "" : "s"}`)
        paintHeader()
        paintComposer()
        return
      }
      if (r.delete) {
        const id = r.delete === true ? spec.id : matchChats(r.delete)[0]?.id
        if (!id) {
          note("no chat to delete")
          paintComposer()
          return
        }
        const ok = await askDelete()
        if (!ok) {
          note("kept")
          paintComposer()
          return
        }
        dropChat(id)
        return
      }
      if (r.context) {
        const snap = measureContext(train, history, contextWindow())
        const parts = snap.parts.map((p) => `  ${p.label.padEnd(8)}  ${p.tokens}`).join("\n")
        note(`${snap.line}\n${parts}`)
        paintComposer()
        return
      }
      if (r.status) {
        note(sessionStatus())
        paintComposer()
        return
      }
      if (r.doctor) {
        const { checks } = await runDoctor(train)
        note(formatDoctor(checks))
        paintComposer()
        return
      }
      if (r.spawn) {
        enterScreen("spawn")
        paintComposer()
        return
      }
      if (r.spawnList) {
        note(formatAgents(train))
        paintComposer()
        return
      }
      if (r.spawnRun) {
        try {
          const a = await startAgent(train, r.spawnRun)
          note(`spawned  ${a.id}  ${a.status}  ${a.name}`)
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        paintComposer()
        return
      }
      if (r.spawnLog) {
        try {
          note(agentLog(train, r.spawnLog))
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        paintComposer()
        return
      }
      if (r.spawnCancel) {
        try {
          const a = await cancelAgent(train, r.spawnCancel)
          note(`canceled  ${a.id}  ${a.status}`)
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        paintComposer()
        return
      }
      if (r.openKey) {
        enterScreen("key")
        paintComposer()
        return
      }
      if (r.promptKey) {
        keyFor = r.promptKey
        screen = null
        chars.length = 0
        cursor = 0
        pick = 0
        paintComposer()
        return
      }
      if (r.text) note(r.text)
      paintComposer()
    }

    const submit = async (text: string) => {
      if (busy) return
      if (renameFor) {
        const name = text.trim()
        if (!name) return
        const target = spec.id === chatFocus ? spec : loadSpec(train, chatFocus)
        const msgs = spec.id === chatFocus ? history : loadMessages(train, chatFocus)
        renameChat(train, target, name, msgs)
        if (spec.id === chatFocus) {
          spec = target
          named = true
          setTabTitle(spec.name)
        }
        renameFor = false
        playCue("click")
        note(`renamed  ${target.name}  ${target.id}`)
        paintHeader()
        enterScreen("chat")
        paintComposer()
        return
      }
      if (keyFor) {
        const key = text.trim()
        if (!key) return
        const id = keyFor
        keyFor = null
        const msg = setKey(id, key)
        playCue("click")
        note(msg)
        enterScreen("root")
        paintComposer()
        return
      }
      if (spawnFor) {
        const task = text.trim()
        if (!task) return
        spawnFor = false
        chars.length = 0
        cursor = 0
        try {
          const a = await startAgent(train, task)
          playCue("click")
          note(`spawned  ${a.id}  ${a.status}  ${a.name}`)
        } catch (err) {
          note(err instanceof Error ? err.message : String(err))
        }
        enterScreen("spawn")
        paintComposer()
        return
      }
      const t = text.trim()
      if (screen && (t === "/" || !t.startsWith("/")) && pickItem()) return
      if (!t) return
      if (t === "exit" || t === "quit") {
        quit()
        return
      }
      if (t.startsWith("/") && t !== "/") {
        chars.length = 0
        cursor = 0
        screen = null
        pick = 0
        playCue("click")
        await applySlash(t)
        return
      }
      if (!t.startsWith("/") && (await blockIfFull())) return
      chars.length = 0
      cursor = 0
      armed = false
      pick = 0
      screen = null
      const painted = renderMarkdown(t, undefined, { baseDir: train })
        .split("\n")
        .map((ln) => `${BOLD}${RAIL} ${ln}${RESET}`)
        .join("\n")
      playCue("click")
      write(`\r\x1b[J${painted}\n\n`)
      menuRows = 0
      const images = pendingImages.splice(0)
      history.push({ role: "user", content: t, images: images.length ? images : undefined })
      if (images.length) {
        write(`${DIM}  ${images.map((i) => i.path).join("  ")}${RESET}\n`)
      }
      beginUndo(history.length - 1)
      busy = true
      write("\x1b[?25l")
      const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
      let frame = 0
      let started = false
      let lastTool = ""
      let toolCount = 0
      const toolLabel = () =>
        !lastTool ? "" : toolCount > 1 ? `· ${lastTool} ×${toolCount}` : `· ${lastTool}`
      const tick = () => {
        const prefix = lastTool ? `${toolLabel()}  ` : ""
        write(`\r${DIM}${prefix}${spin[frame % spin.length]} thinking${RESET}\x1b[K`)
        frame += 1
      }
      tick()
      let timer: ReturnType<typeof setInterval> | null = setInterval(tick, 80)
      let pending = ""
      let toolFrozen = false
      const md = { fence: false, math: false }
      const stopSpin = () => {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
      }
      const flushPending = () => {
        if (!pending) return
        write(renderMarkdown(pending, md, { baseDir: train }) + "\n")
        pending = ""
      }
      try {
        const reply = await runTurn(
          train,
          history,
          (chunk) => {
            if (!started) {
              started = true
              stopSpin()
              if (lastTool && !toolFrozen) {
                write(`\r${DIM}${toolLabel()}${RESET}\x1b[K\n`)
                toolFrozen = true
              } else write(`\r\x1b[K`)
            }
            pending += chunk
            const parts = pending.split("\n")
            pending = parts.pop() ?? ""
            for (const line of parts) write(renderMarkdown(line, md, { baseDir: train }) + "\n")
          },
          (name) => {
            stopSpin()
            if (started) flushPending()
            started = false
            md.fence = false
            md.math = false
            write(`\r\x1b[K`)
            if (name === lastTool) toolCount += 1
            else {
              if (lastTool && !toolFrozen) write(`${DIM}${toolLabel()}${RESET}\n`)
              lastTool = name
              toolCount = 1
              toolFrozen = false
            }
            if (!done) {
              timer = setInterval(tick, 80)
              tick()
            }
          },
          async (command) => {
            if (timer) {
              clearInterval(timer)
              timer = null
            }
            const cmd = command.replace(/\s+/g, " ")
            const shown = cmd.length > 72 ? cmd.slice(0, 69) + "…" : cmd
            write(`\r\x1b[K${DIM}run${RESET}  ${shown}\n`)
            const ok = await new Promise<boolean>((resolvePermit) => {
              permit = {
                cmd,
                pick: 0,
                resolve: (v) => {
                  permit = null
                  write("\x1b[1A\r\x1b[K")
                  write(`${DIM}· run ${v ? "yes" : "no"}${RESET}\x1b[K\n\x1b[K`)
                  resolvePermit(v)
                },
              }
              drawPermitChoices()
            })
            if (!started && !done) {
              timer = setInterval(tick, 80)
              tick()
            }
            return ok
          },
        )
        stopSpin()
        if (!started) write(`\r\x1b[K`)
        flushPending()
        playCue("message")
        history.push({ role: "assistant", content: reply })
        commitUndo()
        saveChat(train, spec, history)
        if (!named) {
          named = true
          const lastUser = [...history].reverse().find((m) => m.role === "user")
          void nameChat(train, spec, lastUser?.content ?? "", reply, history).then((s) => {
            spec = s
            paintHeader()
          })
        }
        write("\n\n")
        paintHeader()
        if (contextFull(measureContext(train, history, contextWindow()))) {
          write("\x1b[?25h")
          busy = false
          await blockIfFull()
          return
        }
      } catch (err) {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        history.pop()
        commitUndo()
        const msg = err instanceof Error ? err.message : String(err)
        write(`\r\x1b[K${DIM}${msg}${RESET}\n\n`)
      }
      write("\x1b[?25h")
      busy = false
      paintComposer()
    }

    const onData = (chunk: Buffer | string) => {
      const parsed = parseKeys(typeof chunk === "string" ? Buffer.from(chunk) : chunk, carry)
      carry = Buffer.from(parsed.carry)
      for (const k of parsed.keys) {
        if (compactAsk) {
          if (k.kind === "left" || k.kind === "up") {
            compactAsk.pick = 0
            drawCompactChoices()
            continue
          }
          if (k.kind === "right" || k.kind === "down") {
            compactAsk.pick = 1
            drawCompactChoices()
            continue
          }
          if (k.kind === "enter") {
            compactAsk.resolve(compactAsk.pick === 0)
            continue
          }
          if (k.kind === "escape" || k.kind === "ctrl-c") {
            compactAsk.resolve(false)
            continue
          }
          if (k.kind === "char" && (k.text === "y" || k.text === "Y" || k.text === "c")) {
            compactAsk.resolve(true)
            continue
          }
          if (k.kind === "char" && (k.text === "n" || k.text === "N" || k.text === "s")) {
            compactAsk.resolve(false)
            continue
          }
          continue
        }
        if (permit) {
          if (k.kind === "left" || k.kind === "up") {
            permit.pick = 0
            drawPermitChoices()
            continue
          }
          if (k.kind === "right" || k.kind === "down") {
            permit.pick = 1
            drawPermitChoices()
            continue
          }
          if (k.kind === "enter") {
            permit.resolve(permit.pick === 0)
            continue
          }
          if (k.kind === "escape" || k.kind === "ctrl-c") {
            permit.resolve(false)
            continue
          }
          if (k.kind === "char" && (k.text === "y" || k.text === "Y")) {
            permit.resolve(true)
            continue
          }
          if (k.kind === "char" && (k.text === "n" || k.text === "N")) {
            permit.resolve(false)
            continue
          }
          continue
        }
        if (busy && k.kind !== "ctrl-c") continue
        if (k.kind !== "ctrl-c" && armed) armed = false
        if (k.kind === "ctrl-c") {
          if (armed) {
            quit()
            return
          }
          armed = true
          paintComposer()
          continue
        }
        if (k.kind === "ctrl-d") {
          if (chars.length === 0) quit()
          return
        }
        if (k.kind === "clear") {
          welcome()
          continue
        }
        if (k.kind === "escape") {
          if (renameFor) {
            renameFor = false
            enterScreen("chat")
          } else if (spawnFor) {
            spawnFor = false
            enterScreen("spawn")
          } else if (keyFor) {
            keyFor = null
            enterScreen("key")
          } else if (screen === "spawn-agent") {
            enterScreen("spawn")
          } else if (screen === "chat-delete") {
            enterScreen("chat")
          } else if (screen === "chat") {
            enterScreen("chats")
          } else if (nested()) {
            enterScreen("root")
          } else {
            screen = null
            chars.length = 0
            cursor = 0
          }
          paintComposer()
          continue
        }
        if (k.kind === "clear-line") {
          if (nested() && screen !== "chats") continue
          chars.length = 0
          cursor = 0
          if (!nested()) {
            screen = null
            pick = 0
          }
          paintComposer()
          continue
        }
        if (k.kind === "up") {
          if (screen && !renameFor) {
            const n = menuChoices(screen, menuCtx()).length
            if (n) pick = (pick + n - 1) % n
            paintComposer()
          }
          continue
        }
        if (k.kind === "down") {
          if (screen && !renameFor) {
            const n = menuChoices(screen, menuCtx()).length
            if (n) pick = (pick + 1) % n
            paintComposer()
          }
          continue
        }
        if (k.kind === "enter") {
          void submit(chars.join(""))
          continue
        }
        if (k.kind === "backspace") {
          if (nested() && screen !== "chats") continue
          if (cursor > 0) {
            chars.splice(cursor - 1, 1)
            cursor -= 1
          }
          if (!keyFor && !renameFor && !nested() && chars.join("") === "") screen = null
          paintComposer()
          continue
        }
        if (k.kind === "left") {
          if (cursor > 0) cursor -= 1
          paintComposer()
          continue
        }
        if (k.kind === "right") {
          if (cursor < chars.length) cursor += 1
          paintComposer()
          continue
        }
        if (k.kind === "home") {
          cursor = 0
          paintComposer()
          continue
        }
        if (k.kind === "end") {
          cursor = chars.length
          paintComposer()
          continue
        }
        if (k.kind === "paste" || k.kind === "char") {
          if (nested() && screen !== "chats" && !keyFor && !renameFor) continue
          const add = Array.from(k.text)
          chars.splice(cursor, 0, ...add)
          cursor += add.length
          if (!keyFor && !renameFor && !nested()) {
            const d = chars.join("")
            if (d === "/") {
              screen = "root"
              pick = 0
            } else {
              screen = null
            }
          }
          paintComposer()
        }
      }
    }

    stdin.on("data", onData)
    process.once("SIGINT", quit)
    process.once("SIGTERM", quit)
  })
}
