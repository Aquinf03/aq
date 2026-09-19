import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertTrain, isTrain } from "../core/schema.js"
import { artifactsDir } from "../core/paths.js"

type Run = {
  id?: string
  recipe_hash?: string
  data_hash?: string | null
  code_hash?: string
  metrics?: { metric?: string; score?: number; n?: number } | null
  pass?: boolean | null
  artifacts?: Record<string, string>
}

function runsDir(train: string): string {
  return path.join(artifactsDir(train), "runs")
}

function listRunIds(train: string): string[] {
  const d = runsDir(train)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && f !== "last.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
}

function loadRun(train: string, id: string): Run {
  const p = path.join(runsDir(train), id.endsWith(".json") ? id : id + ".json")
  if (!existsSync(p)) throw new Error(`no run ${id}`)
  return JSON.parse(readFileSync(p, "utf8")) as Run
}

function fmt(v: unknown): string {
  if (v == null) return "-"
  if (typeof v === "object") {
    const m = v as { metric?: string; score?: number }
    if (m.metric != null) return m.metric + " " + String(m.score ?? "")
    return JSON.stringify(v)
  }
  return String(v)
}

function printDiff(a: Run, b: Run): void {
  const keys = ["recipe_hash", "data_hash", "code_hash", "pass"] as const
  let n = 0
  for (const k of keys) {
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    n++
    console.log(k)
    console.log("  a  " + fmt(va))
    console.log("  b  " + fmt(vb))
  }
  const ma = fmt(a.metrics)
  const mb = fmt(b.metrics)
  if (ma !== mb) {
    n++
    console.log("metrics")
    console.log("  a  " + ma)
    console.log("  b  " + mb)
  }
  const aa = JSON.stringify(a.artifacts ?? {})
  const ab = JSON.stringify(b.artifacts ?? {})
  if (aa !== ab) {
    n++
    console.log("artifacts")
    console.log("  a  " + fmt(a.artifacts))
    console.log("  b  " + fmt(b.artifacts))
  }
  if (!n) console.log("same")
}

export async function diffRuns(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h") {
    console.log("aq diff\n")
    console.log("  aq diff [dir]              list run ids")
    console.log("  aq diff [dir] <a> <b>    diff two runs (files, not screenshots)")
    return
  }
  let train: string
  let ids: string[]
  if (argv.length === 0) {
    train = assertTrain(".")
    ids = []
  } else if (argv.length === 1) {
    train = assertTrain(argv[0])
    ids = []
  } else if (argv.length === 2) {
    train = assertTrain(".")
    ids = argv
  } else if (argv.length === 3 && isTrain(path.resolve(argv[0]))) {
    train = assertTrain(argv[0])
    ids = argv.slice(1)
  } else {
    throw new Error("usage: aq diff [dir] [<a> <b>]")
  }
  if (ids.length === 0) {
    const list = listRunIds(train)
    if (!list.length) {
      console.log("no runs")
      return
    }
    for (const id of list) console.log(id)
    return
  }
  if (ids.length !== 2) throw new Error("usage: aq diff [dir] <a> <b>")
  printDiff(loadRun(train, ids[0]), loadRun(train, ids[1]))
}
