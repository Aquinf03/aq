/** aq artifacts — catalog, aliases, promote (CI/CD handoff). */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { artifactsDir } from "../core/paths.js"
import { pythonBin } from "../core/python.js"
import { kernelRoot } from "../core/root.js"
import { assertTrain, isTrain } from "../core/schema.js"
import { printTable } from "../lib/term-table.js"

function short(id: string | null | undefined, n = 12): string {
  if (!id) return "—"
  if (id.startsWith("sha256:") && id.length > 7 + n) return id.slice(0, 7 + n) + "…"
  return id
}

function catalogDir(train: string): string {
  return path.join(artifactsDir(train), "catalog")
}

function runPy(train: string, code: string): string {
  const kernel = kernelRoot()
  const pkg = path.dirname(kernel) // aq/ — contains aquin/
  const r = spawnSync(
    pythonBin(),
    ["-c", code],
    {
      cwd: kernel,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: [pkg, kernel, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
        AQ_TRAIN: train,
      },
    },
  )
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || `exit ${r.status}`).trim()
    throw new Error(err || "catalog failed")
  }
  return (r.stdout || "").trim()
}

function pyCall(train: string, stmt: string): unknown {
  const code = `
import json, os
from pathlib import Path
from protocol import catalog as cat
train = Path(os.environ["AQ_TRAIN"])
out = None
${stmt}
print(json.dumps(out, default=str))
`
  const raw = runPy(train, code)
  return raw ? JSON.parse(raw) : null
}

function help(): void {
  console.log("aq artifacts")
  console.log("")
  console.log("  aq artifacts [dir]                 list catalog (models/data/code/run)")
  console.log("  aq artifacts [dir] list [--kind k] [--json]")
  console.log("  aq artifacts [dir] show <ref> [--json]")
  console.log("  aq artifacts [dir] aliases [--json]")
  console.log("  aq artifacts [dir] alias <name> [ref]   point name at artifact (default last)")
  console.log("  aq artifacts [dir] promote [name] [ref] CI/CD handoff (default prod last)")
  console.log("  aq artifacts [dir] rebuild            index existing runs into catalog")
  console.log("  aq artifacts [dir] verify [flow]      re-hash flow CAS blobs (integrity)")
  console.log("")
  console.log("  ref = last | @alias | alias | sha256:…")
  console.log("  webhooks: recipe artifacts.webhooks / artifacts/webhooks.json")
}

function parseTrainArgs(argv: string[]): { train: string; rest: string[]; json: boolean } {
  const json = argv.includes("--json")
  const args = argv.filter((a) => a !== "--json")
  let train = "."
  let rest = args
  if (args[0] && isTrain(args[0])) {
    train = args[0]
    rest = args.slice(1)
  }
  return { train: assertTrain(train), rest, json }
}

function printEntry(e: Record<string, unknown>): void {
  const meta = (e.meta || {}) as Record<string, unknown>
  const parents = Array.isArray(e.parents) ? (e.parents as string[]) : []
  printTable(
    ["key", "value"],
    [
      ["id", short(String(e.id || ""), 16)],
      ["kind", e.kind ?? "—"],
      ["path", e.path ?? "—"],
      ["at", e.at ?? "—"],
      ["parents", parents.length ? parents.map((p) => short(p)).join(" → ") : "—"],
      ["run", meta.run_id ?? "—"],
    ],
  )
}

export async function artifactsCmd(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    // bare `aq artifacts` with optional dir → list
    if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
      help()
      return
    }
  }

  const { train, rest, json } = parseTrainArgs(argv)
  const sub = rest[0] || "list"

  if (sub === "help" || sub === "-h") {
    help()
    return
  }

  if (sub === "rebuild") {
    const out = pyCall(train, "out = cat.rebuild(train)") as { runs?: number; artifacts?: number }
    console.log("catalog")
    printTable(
      ["key", "value"],
      [
        ["runs", out?.runs ?? 0],
        ["artifacts", out?.artifacts ?? 0],
        ["path", path.relative(process.cwd(), catalogDir(train)) || catalogDir(train)],
      ],
    )
    return
  }

  if (sub === "verify") {
    const flowFilter = rest[1] || ""
    const code = `
from pathlib import Path
from aquin.flow_store import ArtifactStore
root = train / "artifacts" / "flow"
reports = []
if root.is_dir():
    for flow_dir in sorted(root.iterdir()):
        if not flow_dir.is_dir():
            continue
        if ${JSON.stringify(flowFilter)} and flow_dir.name != ${JSON.stringify(flowFilter)}:
            continue
        for run_dir in sorted(flow_dir.iterdir()):
            if not run_dir.is_dir() or run_dir.name == "latest":
                continue
            if not (run_dir / "cas").is_dir() and not (run_dir / "cas_index.json").is_file():
                continue
            rep = ArtifactStore(run_dir).verify()
            reports.append({"flow": flow_dir.name, "run": run_dir.name, **rep})
out = {"reports": reports, "pass": all(r.get("pass") for r in reports) if reports else True}
`
    const out = pyCall(train, code) as {
      reports?: Array<{
        flow: string
        run: string
        ok?: number
        pass?: boolean
        bad?: unknown[]
        missing?: string[]
        ids?: Record<string, string>
      }>
      pass?: boolean
    }
    if (json) {
      console.log(JSON.stringify(out, null, 2))
      return
    }
    console.log("verify")
    const reps = out?.reports || []
    if (!reps.length) {
      console.log("  (no flow CAS stores — run a Flow with self.x = …)")
      return
    }
    printTable(
      ["flow", "run", "blobs", "result"],
      reps.map((r) => [
        r.flow,
        r.run,
        r.ok ?? 0,
        r.pass ? "ok" : `bad ${((r.bad as unknown[]) || []).length + ((r.missing as string[]) || []).length}`,
      ]),
    )
    if (!out?.pass) {
      throw new Error("flow CAS verify failed (tampered or missing blobs)")
    }
    return
  }

  if (sub === "aliases") {
    const aliases = pyCall(train, "out = cat.load_aliases(train)") as Record<
      string,
      { id?: string; at?: string; kind?: string; by?: string }
    >
    if (json) {
      console.log(JSON.stringify(aliases, null, 2))
      return
    }
    const rows = Object.entries(aliases || {}).map(([name, ptr]) => [
      name,
      ptr.kind ?? "—",
      short(ptr.id, 16),
      ptr.by ?? "—",
    ])
    console.log("aliases")
    if (!rows.length) console.log("  (none — train or aq artifacts rebuild)")
    else printTable(["name", "kind", "id", "by"], rows)
    return
  }

  if (sub === "alias") {
    const name = rest[1]
    const ref = rest[2] || "last"
    if (!name) throw new Error("usage: aq artifacts alias <name> [ref]")
    const out = pyCall(
      train,
      `e = cat.resolve_ref(train, ${JSON.stringify(ref)})
assert e, "no artifact"
out = cat.set_alias(train, ${JSON.stringify(name)}, str(e["id"]), kind=e.get("kind"))`,
    ) as Record<string, unknown>
    console.log("alias")
    printTable(
      ["key", "value"],
      [
        ["name", out.name],
        ["id", short(String(out.id || ""), 16)],
        ["kind", out.kind ?? "—"],
        ["by", out.by ?? "alias"],
      ],
    )
    return
  }

  if (sub === "promote") {
    let promoName = "prod"
    let promoRef = "last"
    if (rest[1]) {
      if (rest[2]) {
        promoName = rest[1]
        promoRef = rest[2]
      } else if (
        ["last", "latest", "best"].includes(rest[1]) ||
        rest[1].startsWith("sha256:") ||
        rest[1].startsWith("@")
      ) {
        promoRef = rest[1]
      } else {
        promoName = rest[1]
      }
    }
    const out = pyCall(
      train,
      `out = cat.promote(train, ${JSON.stringify(promoName)}, ${JSON.stringify(promoRef)})`,
    ) as Record<string, unknown>
    console.log("promote")
    printTable(
      ["key", "value"],
      [
        ["alias", out.name],
        ["id", short(String(out.id || ""), 16)],
        ["kind", out.kind ?? "—"],
        ["at", out.at ?? "—"],
      ],
    )
    console.log("  webhooks → artifacts/catalog/events.jsonl")
    return
  }

  if (sub === "show") {
    const ref = rest[1] || "last"
    const entry = pyCall(
      train,
      `out = cat.resolve_ref(train, ${JSON.stringify(ref)})`,
    ) as Record<string, unknown> | null
    if (!entry) throw new Error(`no artifact for ${JSON.stringify(ref)}`)
    if (json) {
      console.log(JSON.stringify(entry, null, 2))
      return
    }
    console.log("artifact")
    printEntry(entry)
    return
  }

  // list (default)
  let kind: string | null = null
  const kindIdx = rest.indexOf("--kind")
  if (kindIdx >= 0 && rest[kindIdx + 1]) kind = rest[kindIdx + 1]
  // ensure catalog exists — soft rebuild if empty
  const entriesDir = path.join(catalogDir(train), "entries")
  if (!existsSync(entriesDir) || readdirSync(entriesDir).length === 0) {
    pyCall(train, "out = cat.rebuild(train)")
  }
  const kindExpr = kind ? JSON.stringify(kind) : "None"
  const rows = pyCall(
    train,
    `out = cat.list_entries(train, kind=${kindExpr}, limit=50)`,
  ) as Record<string, unknown>[]
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  console.log("catalog")
  if (!rows?.length) {
    console.log("  (empty — aq train or aq artifacts rebuild)")
    return
  }
  printTable(
    ["kind", "id", "path", "parents"],
    rows.map((e) => [
      e.kind ?? "—",
      short(String(e.id || ""), 12),
      e.path ?? "—",
      Array.isArray(e.parents) ? String((e.parents as string[]).length) : "0",
    ]),
  )
  // aliases strip
  const aliases = pyCall(train, "out = cat.load_aliases(train)") as Record<string, { id?: string }>
  const names = Object.keys(aliases || {})
  if (names.length) {
    console.log("aliases")
    printTable(
      ["name", "id"],
      names.map((n) => [n, short(aliases[n]?.id, 12)]),
    )
  }
}
