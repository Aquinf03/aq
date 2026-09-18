/** Tiny unified text diff (no deps). Good enough for recipe/YAML-sized files. */

const MAX_DIFF_LINES = 80
const MAX_LINE = 200

function clipLine(s: string): string {
  const t = s.replace(/\t/g, "  ")
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + "…" : t
}

function splitLines(s: string): string[] {
  const lines = s.replace(/\r\n/g, "\n").split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Longest common subsequence match pairs. */
function lcs(a: string[], b: string[]): { ai: number; bi: number }[] {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  if (n * m > 400_000) return []
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!
    const row = dp[i]!
    const prev = dp[i - 1]!
    for (let j = 1; j <= m; j++) {
      row[j] = ai === b[j - 1] ? ((prev[j - 1]! + 1) as number) : Math.max(row[j - 1]!, prev[j]!)
    }
  }
  const pairs: { ai: number; bi: number }[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push({ ai: i - 1, bi: j - 1 })
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--
    else j--
  }
  pairs.reverse()
  return pairs
}

export type DiffLine = { kind: "ctx" | "add" | "del" | "hdr"; text: string }

/** Unified-ish line list: header + −/+ / context. */
export function diffLines(before: string, after: string, path = "file"): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const out: DiffLine[] = [
    { kind: "hdr", text: `--- a/${path}` },
    { kind: "hdr", text: `+++ b/${path}` },
  ]
  if (!a.length && !b.length) {
    out.push({ kind: "hdr", text: "@@ empty @@" })
    return out
  }
  if (a.length * b.length > 400_000) {
    out.push({ kind: "hdr", text: `@@ too large to diff (${a.length} → ${b.length} lines) @@` })
    return out
  }

  const pairs = lcs(a, b)
  type Op = { t: "eq" | "del" | "add"; line: string }
  const ops: Op[] = []
  let ai = 0
  let bi = 0
  let pi = 0
  while (ai < a.length || bi < b.length) {
    if (pi < pairs.length && pairs[pi]!.ai === ai && pairs[pi]!.bi === bi) {
      ops.push({ t: "eq", line: a[ai]! })
      pi++
      ai++
      bi++
      continue
    }
    const nextAi = pi < pairs.length ? pairs[pi]!.ai : a.length
    const nextBi = pi < pairs.length ? pairs[pi]!.bi : b.length
    if (ai < nextAi) {
      ops.push({ t: "del", line: a[ai++]! })
      continue
    }
    if (bi < nextBi) {
      ops.push({ t: "add", line: b[bi++]! })
      continue
    }
    break
  }

  const interesting = new Set<number>()
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.t !== "eq") {
      for (let k = Math.max(0, i - 1); k <= Math.min(ops.length - 1, i + 1); k++) interesting.add(k)
    }
  }
  if (!interesting.size) {
    out.push({ kind: "hdr", text: "@@ no changes @@" })
    return out
  }

  let shown = 0
  let gap = false
  for (let i = 0; i < ops.length; i++) {
    if (!interesting.has(i)) {
      gap = true
      continue
    }
    if (gap && out.length > 2) {
      out.push({ kind: "hdr", text: "@@ … @@" })
      gap = false
    }
    const op = ops[i]!
    if (op.t === "eq") out.push({ kind: "ctx", text: ` ${clipLine(op.line)}` })
    else if (op.t === "del") out.push({ kind: "del", text: `-${clipLine(op.line)}` })
    else out.push({ kind: "add", text: `+${clipLine(op.line)}` })
    shown++
    if (shown >= MAX_DIFF_LINES) {
      out.push({ kind: "hdr", text: `@@ … truncated (${ops.length - i - 1} more) @@` })
      break
    }
  }
  return out
}

/** Plain unified text (no color). */
export function formatUnifiedDiff(before: string, after: string, path = "file"): string {
  return diffLines(before, after, path)
    .map((l) => l.text)
    .join("\n")
}

const RESET = "\x1b[0m"
const DIM = "\x1b[38;5;245m"
const RED = "\x1b[38;5;203m"
const GREEN = "\x1b[38;5;114m"

/** ANSI-colored diff for TTY. */
export function colorizeDiff(before: string, after: string, path = "file"): string {
  return diffLines(before, after, path)
    .map((l) => {
      if (l.kind === "add") return `${GREEN}${l.text}${RESET}`
      if (l.kind === "del") return `${RED}${l.text}${RESET}`
      return `${DIM}${l.text}${RESET}`
    })
    .join("\n")
}

/** Clip tool stdout for the chat log. */
export function clipToolLog(text: string, maxLines = 40, maxChars = 6000): string {
  let t = text.replace(/\r\n/g, "\n").trimEnd()
  if (!t) return "(no output)"
  if (t.length > maxChars) t = t.slice(0, maxChars) + "\n… (truncated)"
  const lines = t.split("\n")
  if (lines.length <= maxLines) return t
  const head = Math.ceil(maxLines * 0.7)
  const tail = maxLines - head
  return [...lines.slice(0, head), `… (${lines.length - maxLines} lines) …`, ...lines.slice(-tail)].join("\n")
}
