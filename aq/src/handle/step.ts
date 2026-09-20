import { kernelStep, runKernel } from "../core/python.js"
import { shouldAutoPlot } from "../lib/plot-config.js"
import { followTrack, printTrackSummary } from "./track.js"

/**
 * `--tracker` / `-T` / `--tracker=follow` → keep live metrics TUI after the step.
 * Run id + sparkline always print after train/eval.
 */
function takeTrackerFollow(argv: string[]): { follow: boolean; rest: string[] } {
  const rest: string[] = []
  let follow = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--tracker" || a === "-T") {
      follow = true
      const next = argv[i + 1]
      if (next === "follow" || next === "tail" || next === "live") i++
      continue
    }
    if (a.startsWith("--tracker=")) {
      const v = a.slice("--tracker=".length).toLowerCase()
      if (v === "0" || v === "false" || v === "off" || v === "no") follow = false
      else follow = true
      continue
    }
    rest.push(a)
  }
  return { follow, rest }
}

export async function train(argv: string[]): Promise<void> {
  const { follow, rest } = takeTrackerFollow(argv)
  const trainDir = await kernelStep("train", rest)
  printTrackSummary(trainDir, { after: "train" })
  if (follow) await followTrack(trainDir)
  if (shouldAutoPlot(trainDir)) {
    try {
      await runKernel(trainDir, { op: "plot", kind: "all" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`plot (auto): ${msg}\n`)
    }
  }
}

export async function evalCmd(argv: string[]): Promise<void> {
  const { follow, rest } = takeTrackerFollow(argv)
  const trainDir = await kernelStep("eval", rest)
  printTrackSummary(trainDir, { after: "eval" })
  if (follow) await followTrack(trainDir)
}

export async function checkpoint(argv: string[]): Promise<void> {
  await kernelStep("checkpoint", argv)
}

export async function serve(argv: string[]): Promise<void> {
  await kernelStep("serve", argv)
}
