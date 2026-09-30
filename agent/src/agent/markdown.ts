/** Markdown → ANSI for chat. Code fences, inline code, OSC-8 file links, a bit of LaTeX. */

import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[38;5;245m"
const ITAL = "\x1b[3m"
const CODE = "\x1b[38;5;187m"
const LINK = "\x1b[38;5;117m"
const MATH = "\x1b[38;5;159m"
const GUTTER = `${DIM}│${RESET} `
const OSC8_END = "\x1b]8;;\x07"

export type MdState = { fence: boolean; math: boolean }

export type MdOpts = {
  /** Train / workspace root — relative cite targets resolve here for clickable file:// links. */
  baseDir?: string
}

const SUPER: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  n: "ⁿ",
  i: "ⁱ",
}

const SUB: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  n: "ₙ",
  i: "ᵢ",
  a: "ₐ",
  e: "ₑ",
  x: "ₓ",
}

function mapChars(s: string, table: Record<string, string>): string {
  return [...s].map((c) => table[c] ?? c).join("")
}

function latex(src: string): string {
  let t = src.trim()
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
  t = t.replace(/\\sum/g, "∑")
  t = t.replace(/\\prod/g, "∏")
  t = t.replace(/\\int/g, "∫")
  t = t.replace(/\\infty/g, "∞")
  t = t.replace(/\\partial/g, "∂")
  t = t.replace(/\\nabla/g, "∇")
  t = t.replace(/\\cdot/g, "·")
  t = t.replace(/\\times/g, "×")
  t = t.replace(/\\pm/g, "±")
  t = t.replace(/\\leq/g, "≤")
  t = t.replace(/\\geq/g, "≥")
  t = t.replace(/\\neq/g, "≠")
  t = t.replace(/\\approx/g, "≈")
  t = t.replace(/\\to\b/g, "→")
  t = t.replace(/\\rightarrow/g, "→")
  t = t.replace(/\\leftarrow/g, "←")
  t = t.replace(/\\in\b/g, "∈")
  t = t.replace(/\\alpha/g, "α")
  t = t.replace(/\\beta/g, "β")
  t = t.replace(/\\gamma/g, "γ")
  t = t.replace(/\\delta/g, "δ")
  t = t.replace(/\\epsilon/g, "ε")
  t = t.replace(/\\theta/g, "θ")
  t = t.replace(/\\lambda/g, "λ")
  t = t.replace(/\\mu/g, "μ")
  t = t.replace(/\\pi/g, "π")
  t = t.replace(/\\sigma/g, "σ")
  t = t.replace(/\\phi/g, "φ")
  t = t.replace(/\\omega/g, "ω")
  t = t.replace(/\\Delta/g, "Δ")
  t = t.replace(/\\Sigma/g, "Σ")
  t = t.replace(/\\Omega/g, "Ω")
  t = t.replace(/\\left\s*/g, "")
  t = t.replace(/\\right\s*/g, "")
  t = t.replace(/\\,/g, " ")
  t = t.replace(/\\; /g, " ")
  t = t.replace(/\\text\{([^{}]+)\}/g, "$1")
  t = t.replace(/\\mathrm\{([^{}]+)\}/g, "$1")
  t = t.replace(/\^\{([^{}]+)\}/g, (_, x: string) => mapChars(x, SUPER))
  t = t.replace(/_\{([^{}]+)\}/g, (_, x: string) => mapChars(x, SUB))
  t = t.replace(/\^([A-Za-z0-9+\-])/g, (_, x: string) => SUPER[x] ?? `^${x}`)
  t = t.replace(/_([A-Za-z0-9+\-])/g, (_, x: string) => SUB[x] ?? `_${x}`)
  t = t.replace(/[{}]/g, "")
  t = t.replace(/\\\\/g, " ")
  t = t.replace(/\s+/g, " ").trim()
  return `${MATH}${t}${RESET}`
}

/** Strip :L12 / :12 suffix used in cites. */
function splitCiteTarget(raw: string): { rel: string; line?: string } {
  const m = raw.trim().match(/^(.*?)(?::[Ll]?(\d+))?$/)
  if (!m) return { rel: raw.trim() }
  return { rel: (m[1] ?? raw).trim(), line: m[2] }
}

function looksLikeRelPath(s: string): boolean {
  if (!s || s.length > 240) return false
  if (/\s/.test(s)) return false
  if (/^(https?:|mailto:|file:)/i.test(s)) return false
  // code-ish, not a path
  if (/^[a-z]+$/.test(s) && !s.includes(".") && !s.includes("/")) return false
  return /^(?:\.\.?\/|[A-Za-z0-9_.@+-]+\/|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_+-]+)/.test(s)
}

function resolveFileUrl(target: string, baseDir?: string): string | null {
  const t = target.trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t)) return t
  if (/^file:\/\//i.test(t)) return t

  const { rel } = splitCiteTarget(t.replace(/^\.\//, ""))
  if (!looksLikeRelPath(rel) && !path.isAbsolute(rel)) return null

  let abs: string
  if (path.isAbsolute(rel)) {
    abs = path.resolve(rel)
  } else if (baseDir) {
    const root = path.resolve(baseDir)
    abs = path.resolve(root, rel)
    const to = path.relative(root, abs)
    if (to.startsWith("..") || path.isAbsolute(to)) return null
  } else {
    abs = path.resolve(rel)
  }
  return pathToFileURL(abs).href
}

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${LINK}${label}${RESET}${OSC8_END}`
}

function linkify(label: string, href: string, baseDir?: string): string {
  const url = resolveFileUrl(href, baseDir) ?? (/^https?:\/\//i.test(href) ? href : null)
  if (!url) return `${label}${DIM} (${href})${RESET}`
  return osc8(url, label)
}

function autoLinkBacktick(body: string, baseDir?: string): string {
  const { rel, line } = splitCiteTarget(body)
  if (!looksLikeRelPath(rel)) return `${CODE}${body}${RESET}`
  if (!baseDir) return `${CODE}${body}${RESET}`
  const root = path.resolve(baseDir)
  const abs = path.resolve(root, rel.replace(/^\.\//, ""))
  const to = path.relative(root, abs)
  if (to.startsWith("..") || path.isAbsolute(to)) return `${CODE}${body}${RESET}`
  if (!existsSync(abs)) return `${CODE}${body}${RESET}`
  const label = line ? `${rel}:L${line}` : rel
  return osc8(pathToFileURL(abs).href, label)
}

function inline(s: string, baseDir?: string): string {
  let t = s
  t = t.replace(/\$\$([^$]+)\$\$/g, (_, x: string) => latex(x))
  t = t.replace(/\\\((.+?)\\\)/g, (_, x: string) => latex(x))
  t = t.replace(/\\\[(.+?)\\\]/g, (_, x: string) => `  ${latex(x)}`)
  t = t.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_, x: string) => latex(x))
  // markdown links first — preferred cite form: [recipe.yaml](recipe.yaml) or [recipe.yaml:L12](recipe.yaml)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    linkify(label, url, baseDir),
  )
  t = t.replace(/`([^`]+)`/g, (_, x: string) => autoLinkBacktick(x, baseDir))
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, x: string) => `${BOLD}${x}${RESET}`)
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, x: string) => `${ITAL}${x}${RESET}`)
  return t
}

function mathFence(line: string, math: boolean): "open" | "close" | null {
  const t = line.trim()
  if (t === "\\[") return "open"
  if (t === "\\]") return "close"
  if (t === "$$") return math ? "close" : "open"
  return null
}

export function renderMarkdown(src: string, state?: MdState, opts?: MdOpts): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const st = state ?? { fence: false, math: false }
  const baseDir = opts?.baseDir
  const out: string[] = []
  for (const line of lines) {
    const open = line.match(/^```(\w*)\s*$/)
    if (open) {
      if (!st.fence) {
        st.fence = true
        const lang = open[1]
        if (lang) out.push(`${DIM}  ${lang}${RESET}`)
      } else {
        st.fence = false
      }
      continue
    }
    if (st.fence) {
      out.push(`${GUTTER}${CODE}${line}${RESET}`)
      continue
    }
    const one = line.match(/^\\\[(.+)\\\]$/)
    if (one) {
      out.push(`  ${latex(one[1] ?? "")}`)
      continue
    }
    const fence = mathFence(line, st.math)
    if (fence === "open") {
      st.math = true
      continue
    }
    if (fence === "close") {
      st.math = false
      continue
    }
    if (st.math) {
      out.push(`  ${latex(line)}`)
      continue
    }
    const display = line.match(/^\$\$(.+)\$\$$/)
    if (display) {
      out.push(`  ${latex(display[1] ?? "")}`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(`${BOLD}${inline(h[2] ?? "", baseDir)}${RESET}`)
      continue
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (li) {
      out.push(`  • ${inline(li[1] ?? "", baseDir)}`)
      continue
    }
    const num = line.match(/^\s*\d+\.\s+(.*)$/)
    if (num) {
      out.push(`  ${inline(num[1] ?? "", baseDir)}`)
      continue
    }
    if (line.startsWith("> ")) {
      out.push(`${DIM}${inline(line.slice(2), baseDir)}${RESET}`)
      continue
    }
    out.push(inline(line, baseDir))
  }
  return out.join("\n")
}
