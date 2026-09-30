/** One agent turn: model, tools, until the request is done or blocked. */

import {
  contextBlock,
  parseRunCommand,
  permitLabel,
  runAgentTool,
  toolsForTrain,
  runDetached,
  runShell,
  toolNeedsPermit,
} from "./agent-tools.js"
import { systemPrompt } from "./prompt.js"
import { streamTurn, type ChatMsg } from "./provider.js"

export { type ChatMsg }

const MAX_ROUNDS = 24

const ACT =
  /\b(train|eval|status|generate|init|write|change|run|serve|spawn|launch|jobs?|pull|place|ssh|housing|california)\b/i
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

function clip(s: string, n = 240): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

function isRecoverable(result: string): boolean {
  const m = result.toLowerCase()
  return m.includes("not a train") || m.includes("need experiment.md") || m.includes("outside train")
}

export type ToolStartFn = (name: string, args?: string) => void
export type ToolDoneFn = (info: {
  name: string
  label: string
  result: string
  failed: boolean
}) => void

export async function runTurn(
  train: string,
  history: ChatMsg[],
  onDelta: (chunk: string) => void,
  onTool?: ToolStartFn,
  onPermit?: (command: string) => Promise<boolean>,
  onToolDone?: ToolDoneFn,
): Promise<string> {
  const objective = lastUserRequest(history)
  const msgs: ChatMsg[] = history.map((m) => ({ ...m }))
  const progress: string[] = []
  let usedTools = false
  let lastFailed = false
  let recovered = false
  let denied = false

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
        const label = permitLabel(train, call.name, call.args)
        try {
          if (toolNeedsPermit(call.name, call.args)) {
            const ok = onPermit ? await onPermit(label) : false
            if (!ok) {
              result = "denied by user"
              failed = true
              denied = true
              progress.push(`${call.name} denied`)
              onToolDone?.({ name: call.name, label, result, failed: true })
              msgs.push({ role: "tool", content: result, tool_call_id: call.id })
              continue
            }
          }
          if (call.name === "run") {
            const spec = parseRunCommand(call.args)
            onTool?.("run", spec.detach ? `${spec.command} detach=true` : spec.command)
            result = spec.detach
              ? await runDetached(train, spec.command)
              : runShell(train, spec.command)
          } else {
            onTool?.(call.name, call.args)
            result = await runAgentTool(train, call.name, call.args)
          }
        } catch (err) {
          failed = true
          result = err instanceof Error ? err.message : String(err)
        }
        onToolDone?.({ name: call.name, label, result, failed })
        lastFailed = lastFailed || (failed && isRecoverable(result))
        progress.push(
          failed
            ? `${call.name} failed: ${clip(result)}`
            : `${call.name} ${clip(call.args, 80)} → ${clip(result)}`,
        )
        msgs.push({ role: "tool", content: result, tool_call_id: call.id })
      }
      if (denied) {
        msgs.push({
          role: "user",
          content:
            "The human denied a step. Stop tools. Briefly say what is done so far and ask what they want instead. Do not retry the denied action unless they ask.",
        })
        denied = false
        continue
      }
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
  return wrap.text
}
