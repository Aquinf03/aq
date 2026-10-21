/** aq logs — print captured step stdout/stderr (pathspec). */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { pythonBin } from "../core/python.js"
import { kernelRoot } from "../core/root.js"
import { assertTrain, isTrain } from "../core/schema.js"

function help(): void {
  console.log("aq logs")
  console.log("")
  console.log("  aq logs [dir] <pathspec> [--stderr|--stdout|--json]")
  console.log("  show timestamped step console capture (no SSH)")
  console.log("")
  console.log("  aq logs Prep/latest_ok/heavy")
  console.log("  aq logs 'Prep/2026…/heavy/try_0' --stderr")
  console.log("  aq logs Prep/latest_ok/heavy --json")
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
    throw new Error(err || "logs failed")
  }
  return (r.stdout || "").trim()
}

export async function logsCmd(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    help()
    return
  }
  const json = argv.includes("--json")
  const stdoutOnly = argv.includes("--stdout")
  const stderrOnly = argv.includes("--stderr")
  const args = argv.filter((a) => a !== "--json" && a !== "--stdout" && a !== "--stderr")
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
from aquin.runs import at, StepView, TryView, RunView
train = Path(os.environ["AQ_TRAIN"]).resolve()
spec = ${JSON.stringify(spec)}
obj = at(spec, train=train)
if isinstance(obj, RunView):
    # dump all steps
    out = {"kind": "run", "pathspec": obj.pathspec, "steps": {}}
    for st in obj:
        out["steps"][st.name] = {
            "loglines": st.loglines,
            "stdout": st.stdout,
            "stderr": st.stderr,
        }
    print(json.dumps(out, default=str))
elif isinstance(obj, (StepView, TryView)):
    print(json.dumps({
        "kind": "step" if isinstance(obj, StepView) else "try",
        "pathspec": obj.pathspec,
        "loglines": obj.loglines,
        "stdout": obj.stdout,
        "stderr": obj.stderr,
    }, default=str))
else:
    raise SystemExit(f"logs: pathspec must be a run/step/try, got {type(obj).__name__}")
`
  const raw = runPy(path.resolve(train), code)
  const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  if (!data) {
    console.error("logs: empty")
    process.exitCode = 1
    return
  }
  if (json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (data.kind === "run" && data.steps && typeof data.steps === "object") {
    const steps = data.steps as Record<string, { loglines?: unknown[]; stdout?: string; stderr?: string }>
    for (const [name, st] of Object.entries(steps)) {
      console.log(`# ${data.pathspec}/${name}`)
      printLines(st, stdoutOnly, stderrOnly)
    }
    return
  }
  console.log(`# ${data.pathspec}`)
  printLines(data as { loglines?: unknown[]; stdout?: string; stderr?: string }, stdoutOnly, stderrOnly)
}

function printLines(
  data: { loglines?: unknown[]; stdout?: string; stderr?: string },
  stdoutOnly: boolean,
  stderrOnly: boolean,
): void {
  if (stdoutOnly) {
    process.stdout.write(String(data.stdout || ""))
    return
  }
  if (stderrOnly) {
    process.stdout.write(String(data.stderr || ""))
    return
  }
  const lines = Array.isArray(data.loglines) ? data.loglines : []
  if (!lines.length) {
    console.log("(no loglines)")
    return
  }
  for (const rec of lines) {
    if (!rec || typeof rec !== "object") continue
    const r = rec as { at?: string; stream?: string; line?: string }
    const ts = (r.at || "").slice(11, 19) || "??:??:??"
    const stream = r.stream === "stderr" ? "err" : "out"
    console.log(`${ts}  ${stream}  ${r.line ?? ""}`)
  }
}
