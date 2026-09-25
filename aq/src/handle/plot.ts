import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { assertTrain } from "../core/schema.js"
import { runKernel, type KernelReq } from "../core/python.js"

const KINDS = new Set(["metrics", "jobs", "runs", "samples", "vision", "table", "all"])

const USAGE = [
  "usage: aq plot [dir] [metrics|jobs|runs|samples|table|all]",
  "  aq plot table [name]         interactive CLI table (from aquin.table rows)",
  "  --run <id>                   filter table rows by run_id",
  "  --charts metrics,samples   which charts (overrides all)",
  "  --fields loss,lr           metrics y-fields",
  "  --x step                   metrics x-field",
  "  --style line|scatter|bar",
  "  --title TEXT",
  "  --figsize W,H",
  "  --metric-charts loss,eval,duration",
  "  --no-lr / --lr             twin lr axis on metrics",
  "  --max N --thumb N --nrow N --from dir --backend auto|torchvision|pillow|matplotlib",
  "  --out path --format png|svg|pdf --dpi N --open",
].join("\n")

function popFlag(rest: string[], flag: string): { value?: string; rest: string[] } {
  const idx = rest.indexOf(flag)
  if (idx < 0) return { rest }
  const value = rest[idx + 1]
  if (value === undefined) throw new Error(`usage: missing value after ${flag}`)
  return { rest: rest.filter((_, i) => i !== idx && i !== idx + 1), value }
}

function popBool(rest: string[], flag: string): { on: boolean; rest: string[] } {
  if (!rest.includes(flag)) return { on: false, rest }
  return { on: true, rest: rest.filter((a) => a !== flag) }
}

function parsePlotArgs(argv: string[]): { train: string; req: KernelReq; open: boolean } {
  let rest = [...argv]
  const flags: Record<string, string | undefined> = {}
  for (const f of [
    "--out",
    "--format",
    "--dpi",
    "--charts",
    "--fields",
    "--field",
    "--x",
    "--style",
    "--title",
    "--figsize",
    "--metric-charts",
    "--max",
    "--thumb",
    "--nrow",
    "--from",
    "--backend",
  ]) {
    // --field can repeat; collect below
    if (f === "--field") continue
    const r = popFlag(rest, f)
    rest = r.rest
    if (r.value !== undefined) flags[f.slice(2)] = r.value
  }

  const fields: string[] = []
  while (rest.includes("--field")) {
    const r = popFlag(rest, "--field")
    rest = r.rest
    if (r.value) fields.push(r.value)
  }
  if (flags.fields) fields.push(...flags.fields.split(",").map((s) => s.trim()).filter(Boolean))

  const noLr = popBool(rest, "--no-lr")
  rest = noLr.rest
  const yesLr = popBool(rest, "--lr")
  rest = yesLr.rest
  const noSamples = popBool(rest, "--no-samples")
  rest = noSamples.rest
  const openF = popBool(rest, "--open")
  rest = openF.rest
  const runF = popFlag(rest, "--run")
  rest = runF.rest

  let kind = "all"
  let trainArg: string | undefined
  let tableName: string | undefined
  for (const token of rest) {
    if (token.startsWith("-")) throw new Error(`${USAGE}\nunknown: ${token}`)
    if (KINDS.has(token)) {
      // `aq plot table all` — "all" is a table name, not chart kind=all
      if (kind === "table" && !tableName) {
        tableName = token
        continue
      }
      kind = token
      continue
    }
    if (kind === "table" && !tableName && trainArg) {
      tableName = token
      continue
    }
    if (kind === "table" && !tableName && !trainArg) {
      // `aq plot table preds` — preds is table name, train is cwd
      // vs `aq plot myrun table` — myrun is train
      try {
        assertTrain(token)
        trainArg = token
      } catch {
        tableName = token
      }
      continue
    }
    if (!trainArg) trainArg = token
    else if (kind === "table" && !tableName) tableName = token
    else throw new Error(USAGE)
  }

  const train = assertTrain(trainArg ?? ".")
  const req: KernelReq = { op: "plot", kind }

  if (flags.format) req.format = flags.format
  if (flags.dpi) req.dpi = Number(flags.dpi)
  if (flags.out) {
    const abs = path.isAbsolute(flags.out) ? flags.out : path.join(train, flags.out)
    req.out_file = abs
  }
  if (flags.charts) {
    req.charts = flags.charts.split(",").map((s) => s.trim()).filter(Boolean)
    if (kind === "all") req.kind = "all"
  }
  if (flags.title) req.title = flags.title
  if (flags.x) req.x = flags.x
  if (flags.style) req.style = flags.style
  if (flags.figsize) req.figsize = flags.figsize
  if (fields.length) req.fields = fields
  if (flags["metric-charts"]) {
    req.metric_charts = flags["metric-charts"].split(",").map((s) => s.trim()).filter(Boolean)
  }
  if (noLr.on) req.show_lr = false
  if (yesLr.on) req.show_lr = true
  if (flags.max) req.max = Number(flags.max)
  if (flags.thumb) req.thumb = Number(flags.thumb)
  if (flags.nrow) req.nrow = Number(flags.nrow)
  if (flags.from) req.from = flags.from.split(",").map((s) => s.trim()).filter(Boolean)
  if (flags.backend) req.backend = flags.backend
  if (noSamples.on) req.no_samples = true
  if (tableName) req.table = tableName
  if (runF.value) req.run = runF.value

  return { train, req, open: openF.on }
}

function openFile(filePath: string): void {
  if (process.platform === "darwin") {
    spawnSync("open", [filePath], { stdio: "ignore" })
  } else if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", filePath], { stdio: "ignore" })
  } else {
    spawnSync("xdg-open", [filePath], { stdio: "ignore" })
  }
}

export async function plot(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(plotHelp())
    return
  }
  const { train, req, open } = parsePlotArgs(argv)
  await runKernel(train, req, { interactive: req.kind === "table" })
  if (open && req.out_file && existsSync(req.out_file)) {
    openFile(req.out_file)
  }
}

export function plotHelp(): string {
  return [
    "  aq plot [dir] [metrics|jobs|runs|samples|table|all]",
    "  aq plot metrics --fields loss,lr --style line --title 'loss'",
    "  aq plot samples --max 32 --nrow 4 --from artifacts/samples",
    "  aq plot table [name] [--run id]   interactive rows (name=all → every table)",
    "  aq plot --charts metrics,samples --dpi 200",
    "",
    "  Charts: metrics/jobs/runs = matplotlib · samples = torchvision/Pillow grid",
    "          table = interactive CLI (↑↓ / find · s sort · q quit)",
    "  Flags:  --fields --x --style --title --figsize --metric-charts --lr/--no-lr",
    "          --max --thumb --nrow --from --backend --charts --out --format --dpi --open",
    "",
    "  Defaults from recipe.yaml plot: block and ~/.aq/config.json (plot).",
    "  plot.auto: true → charts after aq train",
  ].join("\n")
}
