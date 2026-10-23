/** aq lineage — dataset ↔ task ↔ model (who trained these weights). */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { artifactsDir } from "../core/paths.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { printTable } from "../lib/term-table.js"

type Run = {
  id?: string
  at?: string
  recipe_hash?: string
  data_hash?: string | null
  pass?: boolean | null
  metrics?: { metric?: string; score?: number } | null
  artifacts?: Record<string, string>
  model?: { id?: string; checkpoint?: string; data_hash?: string }
  task?: {
    family?: string
    method?: string
    recipe_hash?: string
    name?: string
    op?: string
  }
  recipe?: { family?: string; method?: string; data?: { name?: string } }
  data?: {
    name?: string
    path?: string
    hash?: string
    n?: number
    columns?: string[]
    target?: string
    kind?: string
    revision?: string
    at?: string
  }
}

type Lineage = {
  train: string
  ref: string
  checkpoint: string | null
  model: {
    id: string | null
    checkpoint: string | null
    data_hash: string | null
    kind: string | null
  }
  task: {
    family?: string | null
    method?: string | null
    recipe_hash?: string | null
    name?: string | null
    op?: string | null
  } | null
  run: {
    id?: string
    at?: string
    recipe_hash?: string
    data_hash?: string | null
    pass?: boolean | null
    metrics?: Run["metrics"]
  } | null
  data: {
    name?: string
    path?: string
    hash?: string | null
    n?: number
    columns?: string[]
    target?: string
    kind?: string
    revision?: string
    at?: string
  } | null
}

function runsDir(train: string): string {
  return path.join(artifactsDir(train), "runs")
}

function ckptDir(train: string): string {
  return path.join(artifactsDir(train), "checkpoints")
}

function loadJson<T>(p: string): T | null {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T
  } catch {
    return null
  }
}

function listRuns(train: string): Run[] {
  const d = runsDir(train)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && f !== "last.json")
    .sort()
    .map((f) => loadJson<Run>(path.join(d, f)))
    .filter((r): r is Run => r != null)
}

function runModelId(run: Run): string | null {
  return run.model?.id || run.artifacts?.logged_model || null
}

function runCheckpoint(run: Run): string | null {
  return run.model?.checkpoint || run.artifacts?.checkpoint || run.artifacts?.checkpoint_last || null
}

function short(id: string | null | undefined, n = 12): string {
  if (!id) return "—"
  if (id.startsWith("sha256:") && id.length > 7 + n) return id.slice(0, 7 + n) + "…"
  return id
}

function idMatch(full: string | null | undefined, ref: string): boolean {
  if (!full) return false
  if (full === ref || full.endsWith(ref)) return true
  const bare = full.startsWith("sha256:") ? full.slice(7) : full
  const want = ref.startsWith("sha256:") ? ref.slice(7) : ref
  return bare === want || bare.startsWith(want) || bare.includes(want)
}

function resolveCheckpoint(train: string, ref: string): string | null {
  const ckpts = ckptDir(train)
  if (!ref || ref === "last" || ref === "latest") {
    const last = path.join(ckpts, "last.json")
    return existsSync(last) ? last : null
  }
  const abs = path.isAbsolute(ref) ? ref : path.resolve(train, ref)
  if (existsSync(abs) && abs.endsWith(".json")) return abs
  if (existsSync(abs + ".json")) return abs + ".json"
  if (/^\d+$/.test(ref)) {
    const step = path.join(ckpts, `${ref}.json`)
    if (existsSync(step)) return step
  }
  return null
}

function idFromCheckpoint(ckpt: string): string | null {
  const body = loadJson<{ aq_model_id?: string }>(ckpt)
  const mid = body?.aq_model_id
  return typeof mid === "string" ? mid : null
}

function kindFromCheckpoint(ckpt: string): string | null {
  const body = loadJson<{ kind?: string }>(ckpt)
  return body?.kind ?? null
}

function matchRun(
  train: string,
  opts: { modelId?: string | null; checkpoint?: string | null; runId?: string | null },
): Run | null {
  if (opts.runId) {
    const direct = loadJson<Run>(path.join(runsDir(train), `${opts.runId}.json`))
    if (direct) return direct
    for (const run of listRuns(train)) {
      const id = String(run.id ?? "")
      if (id === opts.runId || id.endsWith(opts.runId) || id.includes(opts.runId)) return run
    }
    return null
  }

  const matches: Run[] = []
  for (const run of listRuns(train)) {
    if (opts.modelId && idMatch(runModelId(run), opts.modelId)) {
      matches.push(run)
      continue
    }
    if (opts.checkpoint) {
      const ck = runCheckpoint(run)
      if (!ck) continue
      if (
        ck === opts.checkpoint ||
        ck.endsWith(opts.checkpoint) ||
        opts.checkpoint.endsWith(ck) ||
        path.basename(ck) === path.basename(opts.checkpoint)
      ) {
        matches.push(run)
      }
    }
  }
  if (!matches.length) {
    const last = loadJson<Run>(path.join(runsDir(train), "last.json"))
    if (last) {
      if (opts.modelId && idMatch(runModelId(last), opts.modelId)) return last
      if (opts.checkpoint) {
        const ck = runCheckpoint(last)
        if (ck && (ck === opts.checkpoint || ck.endsWith(path.basename(opts.checkpoint)))) return last
      }
    }
    return null
  }
  matches.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
  return matches[matches.length - 1] ?? null
}

export function resolveLineage(train: string, ref = "last"): Lineage {
  const raw = !ref || ref === "latest" ? "last" : ref
  let run: Run | null = null
  let ckptPath: string | null = null
  let mid: string | null = null

  if (raw !== "last") {
    run = matchRun(train, { runId: raw })
  }

  if (!run) {
    ckptPath = resolveCheckpoint(train, raw)
    if (ckptPath) {
      mid = idFromCheckpoint(ckptPath)
      let ckptRel: string
      try {
        ckptRel = path.relative(train, ckptPath)
      } catch {
        ckptRel = ckptPath
      }
      run = matchRun(train, { modelId: mid, checkpoint: ckptRel })
    } else {
      run = matchRun(train, { modelId: raw })
      if (run) {
        mid = runModelId(run)
        const ck = runCheckpoint(run)
        if (ck) {
          const cand = path.resolve(train, ck)
          if (existsSync(cand)) ckptPath = cand
        }
      }
    }
  }

  if (!run && raw === "last") {
    run = loadJson<Run>(path.join(runsDir(train), "last.json"))
    if (run) {
      mid = mid || runModelId(run)
      const ck = runCheckpoint(run)
      if (ck && !ckptPath) {
        const cand = path.resolve(train, ck)
        if (existsSync(cand)) ckptPath = cand
      }
    }
  }

  if (!run && !ckptPath && !mid) {
    throw new Error(`no lineage for ${JSON.stringify(raw)} under ${train}`)
  }

  if (!ckptPath && run) {
    const ck = runCheckpoint(run)
    if (ck) {
      const cand = path.resolve(train, ck)
      if (existsSync(cand)) {
        ckptPath = cand
        mid = mid || idFromCheckpoint(cand)
      }
    }
  }

  if (!mid && ckptPath) mid = idFromCheckpoint(ckptPath)

  let ckptRel: string | null = null
  if (ckptPath) {
    try {
      ckptRel = path.relative(train, ckptPath)
    } catch {
      ckptRel = ckptPath
    }
  } else if (run) {
    ckptRel = runCheckpoint(run)
  }

  let dh: string | null = run?.model?.data_hash || run?.data_hash || null
  if (!mid && run) mid = runModelId(run)

  const model = {
    id: mid,
    checkpoint: ckptRel,
    data_hash: dh,
    kind: ckptPath ? kindFromCheckpoint(ckptPath) : null,
  }

  let data: Lineage["data"] = null
  if (run?.data) {
    data = {
      name: run.data.name,
      path: run.data.path,
      hash: run.data.hash || dh,
      n: run.data.n,
      columns: run.data.columns,
      target: run.data.target,
      kind: run.data.kind,
      revision: run.data.revision,
      at: run.data.at,
    }
  } else {
    const rev = loadJson<NonNullable<Lineage["data"]>>(path.join(train, "data", "revision.json"))
    if (rev) {
      data = {
        name: rev.name,
        path: rev.path,
        hash: rev.hash || dh,
        n: rev.n,
        columns: rev.columns,
        target: rev.target,
        kind: rev.kind,
        revision: rev.revision,
        at: rev.at,
      }
    } else if (dh) {
      data = { hash: dh }
    }
  }

  let task: Lineage["task"] = null
  if (run) {
    const t = run.task
    const recipe = run.recipe
    const dataName =
      t?.name ||
      (recipe?.data && typeof recipe.data === "object" ? recipe.data.name : undefined)
    if (t || recipe?.family || recipe?.method || run.recipe_hash) {
      task = {
        family: t?.family ?? recipe?.family ?? null,
        method: t?.method ?? recipe?.method ?? null,
        recipe_hash: t?.recipe_hash ?? run.recipe_hash ?? null,
        name: dataName ?? null,
        op: t?.op ?? null,
      }
    }
  }

  if (data && !data.revision) {
    const hid = data.hash || dh
    if (hid && hid.startsWith("sha256:")) {
      const digest = hid.slice(7)
      const man = path.join(train, "data", "revisions", `${digest}.json`)
      if (existsSync(man)) data.revision = `data/revisions/${digest}.json`
      else {
        const tip = loadJson<NonNullable<Lineage["data"]>>(path.join(train, "data", "revision.json"))
        if (tip?.hash === hid) {
          if (tip.revision) data.revision = tip.revision
          if (!data.name && tip.name) data.name = tip.name
        }
      }
    }
  }

  return {
    train,
    ref: raw,
    checkpoint: ckptRel,
    model,
    task,
    run: run
      ? {
          id: run.id,
          at: run.at,
          recipe_hash: run.recipe_hash,
          data_hash: run.data_hash || dh,
          pass: run.pass,
          metrics: run.metrics,
        }
      : null,
    data,
  }
}

function printLineage(lin: Lineage): void {
  console.log("model")
  printTable(
    ["key", "value"],
    [
      ["id", short(lin.model.id, 16)],
      ["kind", lin.model.kind ?? "—"],
      ["checkpoint", lin.checkpoint ?? lin.model.checkpoint ?? "—"],
    ],
  )

  console.log("task")
  if (lin.task) {
    const rows: unknown[][] = [
      ["family", lin.task.family ?? "—"],
      ["method", lin.task.method ?? "—"],
    ]
    if (lin.task.name) rows.push(["dataset", lin.task.name])
    if (lin.task.op) rows.push(["op", lin.task.op])
    if (lin.task.recipe_hash) rows.push(["recipe", short(lin.task.recipe_hash)])
    printTable(["key", "value"], rows)
  } else console.log("  (none)")

  console.log("run")
  if (lin.run) {
    const rows: unknown[][] = [
      ["id", lin.run.id ?? "—"],
      ["at", lin.run.at ?? "—"],
    ]
    if (lin.run.pass === true || lin.run.pass === false) {
      rows.push(["result", lin.run.pass ? "pass" : "fail"])
    }
    if (lin.run.metrics?.metric != null) {
      rows.push([String(lin.run.metrics.metric), lin.run.metrics.score ?? "—"])
    }
    if (lin.run.recipe_hash) rows.push(["recipe", short(lin.run.recipe_hash)])
    printTable(["key", "value"], rows)
  } else console.log("  (none)")

  console.log("data")
  if (lin.data) {
    const rows: unknown[][] = []
    if (lin.data.name) rows.push(["name", lin.data.name])
    if (lin.data.path) rows.push(["path", lin.data.path])
    if (lin.data.hash) rows.push(["hash", short(lin.data.hash, 16)])
    if (lin.data.revision) rows.push(["revision", lin.data.revision])
    if (lin.data.n != null) rows.push(["n", lin.data.n])
    if (lin.data.target) rows.push(["target", lin.data.target])
    if (lin.data.columns?.length) rows.push(["columns", lin.data.columns.join(", ")])
    if (!rows.length && lin.data.hash) rows.push(["hash", short(lin.data.hash, 16)])
    if (rows.length) printTable(["key", "value"], rows)
    else console.log("  (none)")
  } else console.log("  (none)")
}

export async function lineageCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log("aq lineage")
    console.log("")
    console.log("  aq lineage [dir] [ref] [--json]")
    console.log("  ref = last | checkpoint path/step | sha256:… | run id")
    console.log("  shows model → task → run → data (dataset ↔ task ↔ model)")
    return
  }

  const json = argv.includes("--json")
  const args = argv.filter((a) => a !== "--json")
  let train = "."
  let ref = "last"
  if (args[0] && isTrain(args[0])) {
    train = args[0]
    if (args[1]) ref = args[1]
  } else if (args[0]) {
    ref = args[0]
  }
  train = assertTrain(train)
  const lin = resolveLineage(train, ref)
  if (json) {
    console.log(JSON.stringify(lin, null, 2))
    return
  }
  if (path.resolve(train) !== path.resolve(process.cwd())) {
    console.log("train")
    console.log("  " + (path.relative(process.cwd(), train) || train))
  }
  printLineage(lin)
}
