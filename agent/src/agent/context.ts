/** Context-window occupancy. Char/4 estimate, no tokenizer. */

import { AGENT_TOOLS, contextBlock } from "./agent-tools.js"
import { systemPrompt } from "./prompt.js"
import type { ChatMsg } from "./provider.js"

export type ContextPart = { id: string; label: string; tokens: number }

export type ContextSnap = {
  window: number
  used: number
  pct: string
  line: string
  parts: ContextPart[]
}

function tokens(s: string): number {
  if (!s) return 0
  return Math.ceil(s.length / 4)
}

function pct(n: number, d: number): string {
  if (d <= 0) return "—"
  const p = (100 * n) / d
  if (p > 0 && p < 1) return "<1%"
  return `${Math.min(999, Math.round(p))}%`
}

function pretty(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function measureContext(train: string, history: ChatMsg[], window: number): ContextSnap {
  const prompt = systemPrompt(train)
  const memory = contextBlock(train)
  const tools = JSON.stringify(AGENT_TOOLS)
  const chat = history
    .map((m) => {
      const extra = m.tool_calls?.map((c) => c.name + c.args).join("") ?? m.tool_call_id ?? ""
      const imgs = m.images?.map((i) => i.data).join("") ?? ""
      return m.content + extra + imgs
    })
    .join("\n")
  const parts: ContextPart[] = [
    { id: "prompt", label: "prompt", tokens: tokens(prompt) },
    { id: "memory", label: "memory", tokens: tokens(memory) },
    { id: "tools", label: "tools", tokens: tokens(tools) },
    { id: "chat", label: "chat", tokens: tokens(chat) },
  ]
  const used = parts.reduce((n, p) => n + p.tokens, 0)
  const p = pct(used, window)
  parts.push({ id: "free", label: "free", tokens: Math.max(0, window - used) })
  return {
    window,
    used,
    pct: p,
    line: `${p}  ${pretty(used)}/${pretty(window)}`,
    parts,
  }
}

export function contextFull(snap: ContextSnap): boolean {
  if (snap.window <= 0) return false
  return Math.round((100 * snap.used) / snap.window) >= 100
}

export { pct, pretty }
