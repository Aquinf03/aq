/** aq at — resolve a flow pathspec (Prep/<run>/step#art). */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { pythonBin } from "../core/python.js"
import { kernelRoot } from "../core/root.js"
import { assertTrain, isTrain } from "../core/schema.js"

function help(): void {
  console.log("aq at")
  console.log("")
  console.log("  aq at [dir] <pathspec> [--json]")
  console.log("  resolve Prep/<run>/step/try_N#art → run / step / try / artifact")
  console.log("")
  console.log("  aq at Prep")
  console.log("  aq at Prep/latest_ok")
  console.log("  aq at Prep/2026…/heavy")
  console.log("  aq at 'Prep/2026…#rows'")
  console.log("  aq at 'Prep/2026…/heavy/try_0#partial' --json")
}

function runPy(train: string, code: string): string {
  const kernel = kernelRoot()
  const pkg = path.dirname(kernel)
  const r = spawnSync(pythonBin(), ["-c", code], {
    cwd: kernel,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [pkg, kernel, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
      AQ_TRAIN: train,
    },
  })
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || `exit ${r.status}`).trim()
    throw new Error(err || "at failed")
  }
  return (r.stdout || "").trim()
}

export async function atCmd(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    help()
    return
  }
  const json = argv.includes("--json")
  const args = argv.filter((a) => a !== "--json")
  let train = "."
  let rest = args
  if (args[0] && isTrain(args[0]) && args.length >= 2) {
    train = args[0]
    rest = args.slice(1)
  }
  assertTrain(train)
  const spec = rest[0]
  if (!spec) {
    help()
    process.exitCode = 1
    return
  }

  const code = `
import json, os
from pathlib import Path
from aquin.runs import describe_at
train = Path(os.environ["AQ_TRAIN"]).resolve()
spec = ${JSON.stringify(spec)}
print(json.dumps(describe_at(spec, train=train), default=str))
`
  const raw = runPy(path.resolve(train), code)
  const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  if (!data) {
    console.error("at: empty result")
    process.exitCode = 1
    return
  }
  if (json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  const kind = String(data.kind || "")
  console.log(`at  ${data.pathspec || spec}`)
  console.log(`  kind     ${kind}`)
  if (data.flow) console.log(`  flow     ${data.flow}`)
  if (data.run) console.log(`  run      ${data.run}`)
  if (data.step) console.log(`  step     ${data.step}`)
  if (data.try !== undefined && data.try !== null) console.log(`  try      ${data.try}`)
  if (data.status != null) console.log(`  status   ${data.status}`)
  if (data.done != null) console.log(`  done     ${data.done}`)
  if (data.visible != null) console.log(`  visible  ${data.visible}`)
  if (data.id) console.log(`  id       ${data.id}`)
  if (Array.isArray(data.arts)) console.log(`  arts     ${(data.arts as string[]).join(", ") || "—"}`)
  if (Array.isArray(data.steps)) console.log(`  steps    ${(data.steps as string[]).join(" → ") || "—"}`)
  if (Array.isArray(data.ids)) console.log(`  runs     ${(data.ids as string[]).length}`)
  if (kind === "art" && "value" in data) {
    const v = data.value
    const shown = typeof v === "string" ? v : JSON.stringify(v)
    const line = shown.length > 200 ? shown.slice(0, 197) + "…" : shown
    console.log(`  value    ${line}`)
  }
}
