/** One agent turn: model, tools, until the request is done or blocked. */

import {
  AGENT_TOOLS,
  contextBlock,
  parseRunCommand,
  runAgentTool,
  toolsForTrain,
  runDetached,
  runShell,
  type AgentToolDef,
} from "./agent-tools.js"
import { systemPrompt } from "./prompt.js"
import { streamTurn, type ChatMsg } from "./provider.js"

export { type ChatMsg }

const MAX_ROUNDS = 16

const ACT =
  /\b(train|eval|status|generate|init|write|change|run|serve|spawn)\b/i
const GO =
  /\b(yeah|yep|yes|ok|okay|sure|fine|go ahead|go on|do it|do that|try it|train it|build it|fix it|proceed|please do|let'?s go|ship it|run it|learn from)\b/i
const WISH =
  /\b(wanna|want to|want a|what'?s a|what is|how do i|could we|maybe|idk|i don'?t know|thinking|curious)\b/i

function isInjectedUser(c: string): boolean {
  return (
    c.startsWith("Earlier in this chat") ||
    c.startsWith("Answer the user now") ||
    c.startsWith("Recover:") ||
    c.startsWith("Stop calling tools.")
  )
}

function lastHumanText(history: ChatMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role !== "user") continue
    const c = m.content.trim()
    if (!c || isInjectedUser(c)) continue
    return c
  }
  return ""
}

function humanTurns(history: ChatMsg[]): number {
  return history.filter((m) => m.role === "user" && m.content.trim() && !isInjectedUser(m.content.trim())).length
}

/** Vague wishes stay in conversation until the human clearly says go. */
export function toolsAllowed(history: ChatMsg[]): boolean {
  const text = lastHumanText(history)
  if (!text) return false
  if (GO.test(text) || ACT.test(text)) return true
  if (humanTurns(history) <= 1 || WISH.test(text)) return false
  return true
}

function lastUserRequest(history: ChatMsg[]): string {
  const c = lastHumanText(history)
  return c.length > 2000 ? c.slice(0, 2000) + "…" : c
}

function aqVerb(name: string, args: string): string {
  if (name === "aq") {
    try {
      const j = JSON.parse(args || "{}") as { args?: string }
      return (j.args ?? "").trim().split(/\s+/)[0] ?? ""
    } catch {
      return ""
    }
  }
  if (name.startsWith("aq_")) return name.slice(3)
  return ""
}

function toolKind(name: string, args: string): "create" | "run" | "other" {
  const v = aqVerb(name, args)
  if (v === "init" || name === "write" || name === "edit" || name === "mkdir") return "create"
  if (v === "train" || v === "eval" || v === "serve") return "run"
  return "other"
}

function clip(s: string, n = 240): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

function isRecoverable(result: string): boolean {
  const m = result.toLowerCase()
  return m.includes("not a train") || m.includes("need experiment.md") || m.includes("outside train")
}

export async function runTurn(
  train: string,
  history: ChatMsg[],
  onDelta: (chunk: string) => void,
  onTool?: (name: string, args?: string) => void,
  onPermit?: (command: string) => Promise<boolean>,
): Promise<string> {
  const objective = lastUserRequest(history)
  const msgs: ChatMsg[] = history.map((m) => ({ ...m }))
  const progress: string[] = []
  const kinds: Array<"create" | "run" | "other"> = []
  let usedTools = false
  let lastFailed = false
  let recovered = false
  let paused = false

  const act = toolsAllowed(history)
  const system = () =>
    systemPrompt(train, {
      extra: contextBlock(train),
      objective,
      progress: progress.length ? progress.map((l, i) => `${i + 1}. ${l}`).join("\n") : "",
    })

  for (let i = 0; i < MAX_ROUNDS; i++) {
    const out = await streamTurn(msgs, onDelta, {
      system: system(),
      tools: act ? toolsForTrain(train) : [],
    })
    if (out.toolCalls.length) {
      usedTools = true
      msgs.push({
        role: "assistant",
        content: out.text,
        tool_calls: out.toolCalls,
      })
      lastFailed = false
      for (const call of out.toolCalls) {
        let result: string
        let failed = false
        const kind = toolKind(call.name, call.args)
        const created = kinds.includes("create")
        const ran = kinds.includes("run")
        if (kind === "run" && (created || ran)) {
          result =
            "paused for the human: finish this step in chat and wait. Do not train/eval in the same breath as creating files, and do not chain train then eval. Ask what they want next."
          failed = true
          paused = true
          progress.push(`${call.name} paused`)
          msgs.push({ role: "tool", content: result, tool_call_id: call.id })
          continue
        }
        try {
          if (call.name === "run") {
            const spec = parseRunCommand(call.args)
            const label = spec.detach ? `${spec.command}  [detach]` : spec.command
            const ok = onPermit ? await onPermit(label) : false
            if (!ok) {
              result = "denied by user"
              failed = true
            } else {
              onTool?.("run", spec.detach ? `${spec.command} detach=true` : spec.command)
              result = spec.detach
                ? await runDetached(train, spec.command)
                : runShell(train, spec.command)
            }
          } else {
            onTool?.(call.name, call.args)
            result = await runAgentTool(train, call.name, call.args)
          }
        } catch (err) {
          failed = true
          result = err instanceof Error ? err.message : String(err)
        }
        kinds.push(kind)
        lastFailed = lastFailed || (failed && isRecoverable(result))
        progress.push(
          failed
            ? `${call.name} failed: ${clip(result)}`
            : `${call.name} ${clip(call.args, 80)} → ${clip(result)}`,
        )
        msgs.push({ role: "tool", content: result, tool_call_id: call.id })
      }
      continue
    }
    if (paused) {
      msgs.push({
        role: "user",
        content:
          "You hit a human-in-the-loop pause. Stop tools. Tell them what is ready in a few sentences and ask whether to train, eval, or change something. Do not invent scores.",
      })
      paused = false
      continue
    }
    if (!out.text.trim() && usedTools) {
      msgs.push({
        role: "user",
        content:
          "Answer the user now in a few sentences. Cite files as markdown links like [recipe.yaml](recipe.yaml). Do not invent scores or pass/fail. Do not only list filenames. Do not claim a train is missing if this turn created one.",
      })
      continue
    }
    if (out.text.trim() && lastFailed && !recovered) {
      recovered = true
      msgs.push({
        role: "assistant",
        content: out.text,
      })
      msgs.push({
        role: "user",
        content:
          "Recover: that last tool failed. Retry once with the train folder in args if cwd is not a train, or tell the user the exact command using the folder already in this turn's progress. Do not say nothing was built if progress shows init or writes.",
      })
      continue
    }
    return out.text
  }
  const wrap = await streamTurn(
    [
      ...msgs,
      {
        role: "user",
        content:
          "Stop calling tools. Tell the user what you already did this turn, the train folder if any, and the exact next command. Do not claim nothing was created if progress shows otherwise.",
      },
    ],
    onDelta,
    { system: system(), tools: [] },
  )
  return wrap.text.trim() || "too many tool rounds — say the train folder and `aq train <folder>` if you created one."
}

export function defs(): AgentToolDef[] {
  return AGENT_TOOLS
}
