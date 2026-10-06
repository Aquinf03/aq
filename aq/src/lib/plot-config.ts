import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type PlotConfig = {
  auto?: boolean
  format?: string
  dpi?: number
  out?: string
  charts?: string[]
}

export function loadGlobalPlotConfig(): PlotConfig {
  const home = homedir()
  const candidates = [path.join(home, ".axi", "config.json"), path.join(home, ".aq", "config.json")]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as { plot?: PlotConfig }
      return cfg.plot && typeof cfg.plot === "object" ? cfg.plot : {}
    } catch {
      continue
    }
  }
  return {}
}

/** Minimal recipe.yaml plot: block reader (no full YAML parser). */
export function loadRecipePlotConfig(train: string): PlotConfig {
  const p = path.join(train, "recipe.yaml")
  if (!existsSync(p)) return {}
  const lines = readFileSync(p, "utf8").split("\n")
  let inPlot = false
  const out: PlotConfig = {}
  for (const raw of lines) {
    const line = raw.split("#")[0] ?? ""
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      if (trimmed === "plot:") {
        inPlot = true
        continue
      }
      if (inPlot && trimmed.endsWith(":")) break
      if (!inPlot) continue
    }
    if (!inPlot) continue
    const m = trimmed.match(/^(\w+):\s*(.+)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key === "auto") out.auto = val === "true" || val === "yes"
    else if (key === "format") out.format = val
    else if (key === "dpi") out.dpi = Number(val)
    else if (key === "out") out.out = val
    else if (key === "charts") {
      out.charts = val
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  return out
}

export function shouldAutoPlot(train: string): boolean {
  const global = loadGlobalPlotConfig()
  const recipe = loadRecipePlotConfig(train)
  if (recipe.auto != null) return recipe.auto
  return global.auto === true
}
