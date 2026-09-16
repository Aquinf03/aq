/** Minimal ANSI for fleet output (NO_COLOR / non-TTY → plain). */

import { stdin, stdout } from "node:process"

const on =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && !!stdout.isTTY

const wrap =
  (code: string) =>
  (s: string): string =>
    on ? `\x1b[${code}m${s}\x1b[0m` : s

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  cyan: wrap("36"),
  blue: wrap("34"),
  magenta: wrap("35"),
  green: wrap("32"),
  red: wrap("31"),
  yellow: wrap("33"),
  white: wrap("37"),
}

/** Colored step label + optional dim detail (e.g. sync / setup / shell). */
export function step(name: string, detail?: string): void {
  console.log(c.blue(name) + (detail ? c.dim("  " + detail) : ""))
}

export function stepOk(name: string, detail?: string): void {
  console.log(c.green(name) + (detail ? c.dim("  " + detail) : ""))
}

export function stepFail(name: string, detail?: string): void {
  console.log(c.red(name) + (detail ? "  " + detail : ""))
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m${rem}s`
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "GB"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "MB"
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "KB"
  return n + "B"
}

/** y/N confirm. Default no unless defaultYes. Non-TTY → true (scripts). */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!stdout.isTTY || !stdin.isTTY) return true
  const { createInterface } = await import("node:readline")
  const rl = createInterface({ input: stdin, output: stdout })
  const hint = defaultYes ? "Y/n" : "y/N"
  return new Promise((resolve) => {
    rl.question(c.magenta(question) + c.dim(` [${hint}]`) + c.cyan(": "), (ans) => {
      rl.close()
      const v = ans.trim().toLowerCase()
      if (!v) {
        resolve(defaultYes)
        return
      }
      resolve(v === "y" || v === "yes")
    })
  })
}
