/** aq find — locate artifacts by name (flow self.x, catalog, checkpoints, runs). */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { artifactsDir } from "../core/paths.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { printTable } from "../lib/term-table.js"

type Hit = {
  kind: string
  name: string
  path: string
  flow?: string
  run?: string
  id?: string
}

function help(): void {
  console.log("aq find")
  console.log("")
  console.log("  aq find [dir] [query] [--kind flow|catalog|checkpoint|run|all] [--json]")
  console.log("  locate artifacts by name — flow self.x, catalog ids, checkpoints, runs")
  console.log("")
  console.log("  aq find rows")
  console.log("  aq find Prep --kind flow")
  console.log("  aq find sha256:a59f")
}

function match(q: string, ...parts: Array<string | undefined | null>): boolean {
  if (!q || q === "*" || q === ".") return true
  const needle = q.toLowerCase()
  return parts.some((p) => p != null && String(p).toLowerCase().includes(needle))
}

function short(id: string, n = 12): string {
  if (id.startsWith("sha256:") && id.length > 7 + n) return id.slice(0, 7 + n) + "…"
  return id
}

function walkFlow(train: string, q: string): Hit[] {
  const root = path.join(artifactsDir(train), "flow")
  if (!existsSync(root)) return []
  const hits: Hit[] = []
  for (const flowName of readdirSync(root)) {
    const flowDir = path.join(root, flowName)
    if (!statSync(flowDir).isDirectory()) continue
    for (const runId of readdirSync(flowDir)) {
      if (runId === "latest") continue
      const runDir = path.join(flowDir, runId)
      if (!statSync(runDir).isDirectory()) continue
      const artDir = path.join(runDir, "artifacts")
      if (!existsSync(artDir)) continue
      for (const f of readdirSync(artDir)) {
        if (!f.endsWith(".json") && !f.endsWith(".pkl")) continue
        const name = f.replace(/\.(json|pkl)$/, "")
        const rel = path.relative(train, path.join(artDir, f))
        if (match(q, name, flowName, runId, rel)) {
          hits.push({ kind: "flow", name, path: rel, flow: flowName, run: runId })
        }
      }
      // also match the flow/run itself
      if (match(q, flowName, runId) && !hits.some((h) => h.flow === flowName && h.run === runId && h.name === "*")) {
        // skip empty marker
      }
    }
  }
  return hits
}

function walkCatalog(train: string, q: string): Hit[] {
  const entries = path.join(artifactsDir(train), "catalog", "entries")
  if (!existsSync(entries)) return []
  const hits: Hit[] = []
  for (const f of readdirSync(entries)) {
    if (!f.endsWith(".json")) continue
    const p = path.join(entries, f)
    try {
      const body = JSON.parse(readFileSync(p, "utf8")) as {
        id?: string
        kind?: string
        path?: string
      }
      const rel = path.relative(train, p)
      if (match(q, body.id, body.kind, body.path, f)) {
        hits.push({
          kind: "catalog",
          name: body.kind || "artifact",
          path: body.path || rel,
          id: body.id,
        })
      }
    } catch {
      /* skip */
    }
  }
  return hits
}

function walkCheckpoints(train: string, q: string): Hit[] {
  const d = path.join(artifactsDir(train), "checkpoints")
  if (!existsSync(d)) return []
  const hits: Hit[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue
    const p = path.join(d, f)
    let mid = ""
    try {
      const body = JSON.parse(readFileSync(p, "utf8")) as { aq_model_id?: string; kind?: string }
      mid = body.aq_model_id || ""
      const rel = path.relative(train, p)
      if (match(q, f, mid, body.kind, rel)) {
        hits.push({
          kind: "checkpoint",
          name: f.replace(/\.json$/, ""),
          path: rel,
          id: mid || undefined,
        })
      }
    } catch {
      const rel = path.relative(train, p)
      if (match(q, f, rel)) hits.push({ kind: "checkpoint", name: f, path: rel })
    }
  }
  return hits
}

function walkRuns(train: string, q: string): Hit[] {
  const d = path.join(artifactsDir(train), "runs")
  if (!existsSync(d)) return []
  const hits: Hit[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json") || f === "last.json") continue
    const p = path.join(d, f)
    try {
      const body = JSON.parse(readFileSync(p, "utf8")) as {
        id?: string
        model?: { id?: string }
        artifacts?: { logged_model?: string }
      }
      const mid = body.model?.id || body.artifacts?.logged_model
      const rel = path.relative(train, p)
      if (match(q, body.id, f, mid, rel)) {
        hits.push({
          kind: "run",
          name: String(body.id || f.replace(/\.json$/, "")),
          path: rel,
          id: mid,
        })
      }
    } catch {
      /* skip */
    }
  }
  return hits
}

export function findArtifacts(
  train: string,
  query: string,
  kind: string,
): Hit[] {
  const k = kind || "all"
  const hits: Hit[] = []
  if (k === "all" || k === "flow") hits.push(...walkFlow(train, query))
  if (k === "all" || k === "catalog") hits.push(...walkCatalog(train, query))
  if (k === "all" || k === "checkpoint") hits.push(...walkCheckpoints(train, query))
  if (k === "all" || k === "run") hits.push(...walkRuns(train, query))
  return hits
}

export async function findCmd(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    help()
    return
  }
  const json = argv.includes("--json")
  let kind = "all"
  const args = argv.filter((a) => a !== "--json")
  const kindIdx = args.indexOf("--kind")
  if (kindIdx >= 0) {
    kind = args[kindIdx + 1] || "all"
    args.splice(kindIdx, 2)
  }

  let train = "."
  let query = ""
  if (args[0] && isTrain(args[0])) {
    train = args[0]
    query = args.slice(1).join(" ") || "*"
  } else {
    query = args.join(" ") || "*"
  }
  train = assertTrain(train)

  const hits = findArtifacts(train, query, kind)
  if (json) {
    console.log(JSON.stringify(hits, null, 2))
    return
  }
  console.log("find" + (query && query !== "*" ? `  ${query}` : ""))
  if (!hits.length) {
    console.log("  (none)")
    return
  }
  printTable(
    ["kind", "name", "path", "id"],
    hits.slice(0, 80).map((h) => [
      h.kind,
      h.flow ? `${h.flow}/${h.name}` : h.name,
      h.path,
      h.id ? short(h.id) : h.run || "—",
    ]),
  )
  if (hits.length > 80) console.log(`  … ${hits.length - 80} more`)
}
