/** aq track — TUI-first experiment view over train folder + runs/ + metrics.jsonl. */

import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs"
import path from "node:path"
import { artifactsDir, pathRel } from "../core/paths.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { fmtCell, printTable } from "../lib/term-table.js"

type RunRecord = {
  id?: string
  at?: string
  recipe_hash?: string
  data_hash?: string | null
  code_hash?: string
  pass?: boolean | null
  metrics?: { metric?: string; score?: number; n?: number } | null
  recipe?: { family?: string; method?: string }
  artifacts?: Record<string, string>
}

type MetricEvent = {
  ts?: string
  event?: string
  run_id?: string
  op?: string
  step?: number
  steps?: number
  epoch?: number
  loss?: number
  lr?: number
  acc?: number
  val_loss?: number
  val_acc?: number
  elapsed_ms?: number
  [k: string]: unknown
}

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const GREEN = "\x1b[32m"
const HIDE = "\x1b[?25l"
const SHOW = "\x1b[?25h"

function runsDir(train: string): string {
  return path.join(artifactsDir(train), "runs")
}

function metricsPath(train: string): string {
  return path.join(artifactsDir(train), "metrics.jsonl")
}

function listRunIds(train: string): string[] {
  const d = runsDir(train)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && f !== "last.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
}

function loadRun(train: string, id: string): RunRecord {
  const file = id.endsWith(".json") ? id : id + ".json"
  const p = path.join(runsDir(train), file)
  if (!existsSync(p)) throw new Error(`no run ${id}`)
  return JSON.parse(readFileSync(p, "utf8")) as RunRecord
}

function loadLastRun(train: string): RunRecord | null {
  const p = path.join(runsDir(train), "last.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunRecord
  } catch {
    return null
  }
}

function readMetrics(train: string): MetricEvent[] {
  const p = metricsPath(train)
  if (!existsSync(p)) return []
  const out: MetricEvent[] = []
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as MetricEvent)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

function verdict(p: boolean | null | undefined): string {
  if (p === true) return "pass"
  if (p === false) return "fail"
  return "—"
}

function sparkline(values: number[], width = 40): string {
  if (!values.length) return DIM + "(no steps)" + RESET
  const chars = "▁▂▃▄▅▆▇█"
  const slice = values.length > width ? values.slice(-width) : values
  let min = Infinity
  let max = -Infinity
  for (const v of slice) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return slice.map(() => "▄").join("")
  }
  return slice
    .map((v) => {
      if (!Number.isFinite(v)) return " "
      const t = (v - min) / (max - min)
      return chars[Math.max(0, Math.min(chars.length - 1, Math.round(t * (chars.length - 1))))]!
    })
    .join("")
}

function termWidth(): number {
  return Math.max(60, process.stdout.columns || 100)
}

function trackHelp(): void {
  console.log(`aq track — experiment view (folder + runs/ + metrics.jsonl)

  aq track [dir]                 browse runs (also printed after aq train / aq eval)
  aq track [dir] <run_id>        show one run record + metric summary
  aq track [dir] --follow        live TUI: tail metrics.jsonl (curves + steps)
  aq track [dir] <run_id> -f     follow, filter to that metrics run_id
  aq track [dir] compare <a> <b> diff two run records (same as aq diff)

Live train/eval draws a TUI while running, then always prints run id + sparkline.
  aq train --tracker           # also keep live metrics TUI after the step
  aq eval --tracker
Experiment identity = train directory + runs/<id>.json.
`)
}

function listRuns(train: string): void {
  printTrackSummary(train, { browse: true })
}

/** Compact experiment summary (after train/eval, or `aq track`). */
export function printTrackSummary(
  train: string,
  opts: { browse?: boolean; after?: "train" | "eval" } = {},
): void {
  const art = pathRel(train, "artifacts")
  const ids = listRunIds(train)
  const last = loadLastRun(train)
  if (opts.after) {
    console.log("track")
  } else {
    console.log("train")
    console.log("  " + train)
    console.log("runtime")
    console.log(`  ${art}/  (metrics.jsonl · runs/)`)
  }
  if (last?.id) {
    console.log("run")
    console.log("  " + last.id)
    const fam = last.recipe?.family
    const meth = last.recipe?.method
    if (fam || meth) console.log(`  ${(fam ?? "—")}/${(meth ?? "—")}`)
    if (last.metrics?.metric != null) {
      console.log(`  ${last.metrics.metric}=${fmtCell(last.metrics.score)}  gate=${verdict(last.pass)}`)
    } else if (last.pass != null) {
      console.log(`  gate=${verdict(last.pass)}`)
    }
  } else if (!ids.length) {
    console.log("run")
    console.log("  (none yet)")
  }
  const events = readMetrics(train)
  const steps = events.filter((e) => e.event === "step" && typeof e.loss === "number")
  if (steps.length) {
    const losses = steps.map((e) => Number(e.loss))
    console.log("metrics")
    console.log(`  ${art}/metrics.jsonl  (${events.length} events, ${steps.length} steps)`)
    console.log(`  loss  ${sparkline(losses)}`)
    const lastStep = steps[steps.length - 1]!
    console.log(
      `  last  step=${fmtCell(lastStep.step)}  loss=${fmtCell(lastStep.loss)}  lr=${fmtCell(lastStep.lr)}`,
    )
  }
  if (opts.browse && ids.length) {
    console.log("runs")
    const rows: unknown[][] = []
    for (const id of ids.slice(-30)) {
      let rec: RunRecord = { id }
      try {
        rec = loadRun(train, id)
      } catch {
        /* list id only */
      }
      const fam = rec.recipe?.family ?? "—"
      const meth = rec.recipe?.method ?? "—"
      const m = rec.metrics
      const score = m?.metric != null ? `${m.metric}=${fmtCell(m.score)}` : "—"
      rows.push([id, `${fam}/${meth}`, score, verdict(rec.pass), rec.at ?? "—"])
    }
    printTable(["id", "recipe", "score", "gate", "at"], rows)
    if (ids.length > 30) console.log(DIM + `  … ${ids.length - 30} older` + RESET)
  }
  if (opts.browse) {
    console.log("next")
    console.log("  aq track --follow")
    if (ids.length) console.log("  aq track " + ids[ids.length - 1])
  }
}

function showRun(train: string, id: string): void {
  const rec = loadRun(train, id)
  const art = pathRel(train, "artifacts")
  console.log("run")
  console.log("  " + (rec.id ?? id))
  console.log("train")
  console.log("  " + train)
  printTable(
    ["key", "value"],
    [
      ["at", rec.at ?? "—"],
      ["family", rec.recipe?.family ?? "—"],
      ["method", rec.recipe?.method ?? "—"],
      ["recipe", rec.recipe_hash ?? "—"],
      ["data", rec.data_hash ?? "—"],
      ["code", rec.code_hash ?? "—"],
      ["gate", verdict(rec.pass)],
      [
        "score",
        rec.metrics?.metric != null
          ? `${rec.metrics.metric}=${fmtCell(rec.metrics.score)}`
          : "—",
      ],
    ],
  )
  if (rec.artifacts && Object.keys(rec.artifacts).length) {
    console.log("artifacts")
    for (const [k, v] of Object.entries(rec.artifacts)) {
      console.log(`  ${k}  ${v}`)
    }
  }
  const events = readMetrics(train).filter((e) => !e.run_id || e.run_id === id || id.startsWith(String(e.run_id)))
  const steps = events.filter((e) => e.event === "step" && typeof e.loss === "number")
  if (steps.length) {
    console.log("metrics")
    console.log(`  matched ${steps.length} steps in ${art}/metrics.jsonl`)
    console.log(`  loss  ${sparkline(steps.map((e) => Number(e.loss)))}`)
  }
  console.log("files")
  console.log(`  ${art}/runs/${rec.id ?? id}.json`)
  console.log(`  ${art}/runs/${rec.id ?? id}.md`)
}

function tuiEnabled(): boolean {
  const v = (process.env.AQ_TUI || "1").trim().toLowerCase()
  if (v === "0" || v === "false" || v === "no" || v === "off") return false
  return Boolean(process.stdout.isTTY)
}

function drawFollow(train: string, filterRunId: string | null, events: MetricEvent[]): string {
  const art = pathRel(train, "artifacts")
  const filtered = filterRunId
    ? events.filter((e) => !e.run_id || String(e.run_id) === filterRunId || filterRunId.startsWith(String(e.run_id)))
    : events
  const steps = filtered.filter((e) => e.event === "step")
  const losses = steps.map((e) => Number(e.loss)).filter((n) => Number.isFinite(n))
  const last = filtered[filtered.length - 1]
  const lastStep = [...steps].reverse().find((e) => e.event === "step")
  const w = termWidth()
  const lines: string[] = []
  lines.push(`${DIM}aq track · ${train}${RESET}`)
  lines.push(
    `${DIM}${art}/metrics.jsonl${RESET}  events=${filtered.length}  steps=${steps.length}` +
      (filterRunId ? `  run=${filterRunId}` : ""),
  )
  if (lastStep || last) {
    const body = lastStep || last!
    lines.push(
      [
        `op=${fmtCell(body.op)}`,
        `step=${fmtCell(body.step)}${body.steps != null ? "/" + fmtCell(body.steps) : ""}`,
        `loss=${fmtCell(body.loss)}`,
        `lr=${fmtCell(body.lr)}`,
        `acc=${fmtCell(body.acc)}`,
        body.elapsed_ms != null ? `t=${fmtCell(body.elapsed_ms)}ms` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
  } else {
    lines.push(`${DIM}waiting for metrics… (aq train)${RESET}`)
  }
  const sparkW = Math.min(56, w - 10)
  lines.push(`loss  ${GREEN}${sparkline(losses, sparkW)}${RESET}`)
  const headers = ["step", "loss", "lr", "acc", "epoch", "time"]
  const rows = steps.slice(-12).map((s) => [
    s.steps != null && s.step != null ? `${s.step}/${s.steps}` : fmtCell(s.step),
    fmtCell(s.loss),
    fmtCell(s.lr),
    fmtCell(s.acc),
    fmtCell(s.epoch),
    s.elapsed_ms != null ? `${Math.round(Number(s.elapsed_ms))}ms` : "—",
  ])
  if (rows.length) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
    const fmtRow = (cells: string[]) =>
      cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")
    lines.push(DIM + fmtRow(headers) + RESET)
    for (const r of rows) lines.push(fmtRow(r.map(String)))
  }
  lines.push(`${DIM}ctrl-c stop · aq track <run_id> · aq status${RESET}`)
  return lines.join("\n")
}

async function followMetrics(train: string, filterRunId: string | null): Promise<void> {
  const file = metricsPath(train)
  let lastSize = 0
  let events = readMetrics(train)
  let drawn = 0

  const redraw = () => {
    const frame = drawFollow(train, filterRunId, events)
    if (tuiEnabled()) {
      if (drawn > 0) {
        process.stdout.write(`\x1b[${drawn}A\x1b[0J`)
      } else {
        process.stdout.write(HIDE)
      }
      const lines = frame.split("\n")
      process.stdout.write(frame + "\n")
      drawn = lines.length
    } else {
      console.log(frame)
      console.log("---")
    }
  }

  const refresh = () => {
    try {
      if (!existsSync(file)) {
        events = []
        redraw()
        return
      }
      const st = statSync(file)
      if (st.size !== lastSize) {
        lastSize = st.size
        events = readMetrics(train)
      }
      redraw()
    } catch {
      redraw()
    }
  }

  refresh()
  const interval = setInterval(refresh, 400)
  let watcher: ReturnType<typeof watch> | null = null
  try {
    if (existsSync(path.dirname(file))) {
      watcher = watch(path.dirname(file), { persistent: true }, (_e, name) => {
        if (!name || name === "metrics.jsonl" || String(name).endsWith("metrics.jsonl")) refresh()
      })
      watcher.on("error", () => {
        try {
          watcher?.close()
        } catch {
          /* ignore */
        }
        watcher = null
      })
    }
  } catch {
    /* interval is enough */
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(interval)
      watcher?.close()
      if (tuiEnabled()) process.stdout.write(SHOW)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

/** Live metrics TUI (used by `aq track --follow` and `aq train --tracker=follow`). */
export async function followTrack(train: string, filterRunId: string | null = null): Promise<void> {
  await followMetrics(train, filterRunId)
}

function resolveTrainAndRest(argv: string[]): { train: string; rest: string[] } {
  const args = [...argv]
  let train = "."
  if (args[0] && !args[0].startsWith("-") && existsSync(args[0])) {
    try {
      const st = statSync(args[0])
      if (st.isDirectory() && isTrain(args[0])) {
        train = args.shift()!
      }
    } catch {
      /* treat as run id */
    }
  }
  train = assertTrain(train)
  return { train, rest: args }
}

export async function track(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    trackHelp()
    return
  }

  const follow =
    argv.includes("--follow") || argv.includes("-f") || argv.includes("follow")
  const cleaned = argv.filter((a) => a !== "--follow" && a !== "-f" && a !== "follow")

  const { train, rest } = resolveTrainAndRest(cleaned)

  if (rest[0] === "compare" || rest[0] === "diff") {
    const { diffRuns } = await import("./diff.js")
    await diffRuns([train, ...rest.slice(1)])
    return
  }

  if (follow) {
    const runFilter = rest[0] && !rest[0].startsWith("-") ? rest[0] : null
    await followMetrics(train, runFilter)
    return
  }

  if (rest[0]) {
    showRun(train, rest[0])
    return
  }

  listRuns(train)
}
