import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { artifactsDir, pathRel } from "../core/paths.js"
import { assertTrain } from "../core/schema.js"
import { printTable } from "../lib/term-table.js"

export async function status(argv: string[]): Promise<void> {
  const train = assertTrain(argv[0] ?? ".")
  const art = artifactsDir(train)
  const artLabel = pathRel(train, "artifacts")

  const last = path.join(art, "runs", "last.json")
  console.log("run")
  if (existsSync(last)) {
    const run = JSON.parse(readFileSync(last, "utf8")) as {
      id?: string
      pass?: boolean | null
      metrics?: { metric?: string; score?: number }
    }
    const p = run.pass === true ? "pass" : run.pass === false ? "fail" : "skip"
    const rows: unknown[][] = [["id", run.id ?? "last"], ["result", p]]
    if (run.metrics?.metric != null) {
      rows.push([String(run.metrics.metric), run.metrics.score ?? "—"])
    }
    printTable(["key", "value"], rows)
  } else console.log("  (none)")

  const inspect = path.join(art, "inspect.md")
  console.log("inspect")
  console.log(existsSync(inspect) ? `  ${artLabel}/inspect.md` : "  (none)")

  const ev = path.join(art, "eval.json")
  console.log("eval")
  if (existsSync(ev)) {
    const e = JSON.parse(readFileSync(ev, "utf8")) as {
      metric?: string
      score?: number
      pass?: boolean | null
    }
    const p = e.pass === true ? "pass" : e.pass === false ? "fail" : "skip"
    printTable(
      ["metric", "score", "result"],
      [[e.metric ?? "—", e.score ?? "—", p]],
    )
  } else console.log("  (none)")

  const sv = path.join(art, "serve.json")
  console.log("serve")
  if (existsSync(sv)) {
    const s = JSON.parse(readFileSync(sv, "utf8")) as {
      text?: string
      tokens?: number
      checkpoint?: string
    }
    const rows: unknown[][] = []
    if (s.tokens != null) rows.push(["tokens", s.tokens])
    if (s.checkpoint) rows.push(["checkpoint", s.checkpoint])
    if (s.text) rows.push(["text", String(s.text).slice(0, 80)])
    if (rows.length) printTable(["key", "value"], rows)
    else console.log("  (none)")
  } else console.log("  (none)")

  const metrics = path.join(art, "metrics.jsonl")
  console.log("metrics")
  if (existsSync(metrics)) {
    const lines = readFileSync(metrics, "utf8").trim().split("\n").filter(Boolean)
    console.log(`  ${artLabel}/metrics.jsonl  (` + lines.length + " events)")
    const recent = lines.slice(-8)
    const rows: unknown[][] = []
    for (const line of recent) {
      try {
        const row = JSON.parse(line) as {
          event?: string
          step?: number
          epoch?: number
          loss?: number
          acc?: number
          score?: number
          metric?: string
          elapsed_ms?: number
        }
        rows.push([
          row.event ?? "?",
          row.step ?? row.epoch ?? "—",
          row.loss ?? row.score ?? "—",
          row.acc ?? (row.metric ? row.metric : "—"),
          row.elapsed_ms != null ? row.elapsed_ms + "ms" : "—",
        ])
      } catch {
        rows.push([line.slice(0, 40), "—", "—", "—", "—"])
      }
    }
    printTable(["event", "step", "loss", "acc", "time"], rows)
  } else console.log("  (none)")
}
