import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { assertTrain } from "../core/schema.js"
import { runKernel, type KernelReq } from "../core/python.js"

const KINDS = new Set(["metrics", "jobs", "runs", "samples", "vision", "all"])

const USAGE =
  "usage: aq plot [dir] [metrics|jobs|runs|samples|vision|all] [--out path] [--format png|svg|pdf] [--dpi N] [--open]"

function popFlag(rest: string[], flag: string): { value?: string; rest: string[] } {
  const idx = rest.indexOf(flag)
  if (idx < 0) return { rest }
  const value = rest[idx + 1]
  if (value === undefined) throw new Error(`usage: missing value after ${flag}`)
  return { rest: rest.filter((_, i) => i !== idx && i !== idx + 1), value }
}

function parsePlotArgs(argv: string[]): { train: string; req: KernelReq; open: boolean } {
  let rest = [...argv]
  const out = popFlag(rest, "--out")
  rest = out.rest
  const fmt = popFlag(rest, "--format")
  rest = fmt.rest
  const dpi = popFlag(rest, "--dpi")
  rest = dpi.rest
  const open = rest.includes("--open")
  rest = rest.filter((a) => a !== "--open")

  let kind = "all"
  let trainArg: string | undefined
  for (const token of rest) {
    if (token.startsWith("-")) throw new Error(USAGE)
    if (KINDS.has(token)) kind = token
    else if (!trainArg) trainArg = token
    else throw new Error(USAGE)
  }

  const train = assertTrain(trainArg ?? ".")
  const req: KernelReq = { op: "plot", kind }
  if (fmt.value) req.format = fmt.value
  if (dpi.value) req.dpi = Number(dpi.value)
  if (out.value) {
    const abs = path.isAbsolute(out.value) ? out.value : path.join(train, out.value)
    req.out_file = abs
  }
  return { train, req, open }
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
  const { train, req, open } = parsePlotArgs(argv)
  await runKernel(train, req)
  if (open && req.out_file && existsSync(req.out_file)) {
    openFile(req.out_file)
  }
}

export function plotHelp(): string {
  return [
    "  aq plot [dir] [metrics|jobs|runs|samples|all]  charts from artifacts (default: all)",
    "  aq plot [dir] metrics                   loss/lr from metrics.jsonl (matplotlib)",
    "  aq plot [dir] jobs                      job status bar chart (matplotlib)",
    "  aq plot [dir] runs                      compare run scores (matplotlib)",
    "  aq plot [dir] samples                   image grid (torchvision if installed, else Pillow)",
    "      --out path   output file (single chart)",
    "      --format png|svg|pdf",
    "      --dpi N",
    "      --open       open the file after writing (--out only)",
    "",
    "  samples looks in artifacts/samples/, artifacts/previews/, and recipe image folders.",
    "  recipe.yaml plot: block and ~/.aq/config.json set defaults.",
    "  plot.auto: true  → charts after aq train",
  ].join("\n")
}
