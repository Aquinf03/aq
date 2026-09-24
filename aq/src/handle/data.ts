import { runKernel } from "../core/python.js"
import { assertTrain } from "../core/schema.js"

const USAGE = "usage: aq data hash [dir] [--snapshot]"

export async function data(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log("aq data\n")
    console.log("  aq data hash [dir] [--snapshot]   hash + inspect recipe data.path (CLI table → data/revision.json)")
    return
  }
  if (sub !== "hash") {
    throw new Error(`unknown data command: ${sub}\n${USAGE}`)
  }
  const snapshot = argv.includes("--snapshot")
  const rest = argv.slice(1).filter((a) => a !== "--snapshot")
  if (rest.length > 1) throw new Error(USAGE)
  const train = assertTrain(rest[0] ?? ".")
  await runKernel(train, { op: "hash", snapshot })
}
