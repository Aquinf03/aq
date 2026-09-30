/** Fold older chat turns into a recap so the same session can continue. */

import { measureContext, contextFull } from "./context.js"
import { streamTurn, type ChatMsg } from "./provider.js"

export type CompactResult =
  | { ok: true; history: ChatMsg[]; pct: string }
  | { ok: false; skip: string }

function lastUserIndex(history: ChatMsg[], n: number): number {
  let seen = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      seen += 1
      if (seen === n) return i
    }
  }
  return 0
}

function serialize(m: ChatMsg): string {
  let body = m.content
  if (m.tool_calls?.length) {
    body +=
      "\n" +
      m.tool_calls.map((c) => `[${c.name} ${c.args.slice(0, 240)}]`).join("\n")
  }
  if (m.images?.length) body += "\n" + m.images.map((i) => `[image ${i.path}]`).join("\n")
  if (m.tool_call_id) body = `[tool ${m.tool_call_id}] ${body}`
  if (body.length > 4000) body = body.slice(0, 4000) + "…"
  return `${m.role}: ${body}`
}

function split(history: ChatMsg[], keepUsers: number): { old: ChatMsg[]; tail: ChatMsg[] } {
  const start = lastUserIndex(history, keepUsers)
  if (start <= 0) return { old: [], tail: history.slice() }
  return { old: history.slice(0, start), tail: history.slice(start) }
}

export async function compactHistory(
  train: string,
  history: ChatMsg[],
  window: number,
): Promise<CompactResult> {
  const snap = measureContext(train, history, window)
  const chat = snap.parts.find((p) => p.id === "chat")?.tokens ?? 0
  if (snap.used - chat >= window) {
    return { ok: false, skip: "prompt, memory, and tools already fill the window" }
  }
  if (history.length < 4) return { ok: false, skip: "nothing to compact" }

  let keepUsers = 2
  let { old, tail } = split(history, keepUsers)
  if (!old.length) return { ok: false, skip: "nothing to compact" }

  const budget = Math.max(4000, window * 3)
  let blob = old.map(serialize).join("\n\n")
  if (blob.length > budget) blob = blob.slice(blob.length - budget)

  const out = await streamTurn(
    [
      {
        role: "user",
        content: `Write a compact recap so the same lab session can continue. Keep the user's open objective, train folder paths, files created, commands run, errors, and what is still unfinished. Do not drop a train that was already inited. No preamble.\n\n${blob}`,
      },
    ],
    () => {},
    { system: "Reply with only the recap.", tools: [] },
  )
  const recap = out.text.trim()
  if (!recap) return { ok: false, skip: "compact produced no recap" }

  const build = (rest: ChatMsg[]): ChatMsg[] => [
    { role: "user", content: `Earlier in this chat (compacted):\n${recap}` },
    { role: "assistant", content: "Continuing. The recap is true; I will not re-discover or deny work already done." },
    ...rest,
  ]

  let next = build(tail)
  while (contextFull(measureContext(train, next, window)) && keepUsers > 1) {
    keepUsers -= 1
    tail = split(history, keepUsers).tail
    next = build(tail)
  }
  if (contextFull(measureContext(train, next, window))) {
    next = build([])
  }
  const after = measureContext(train, next, window)
  return { ok: true, history: next, pct: after.pct }
}
