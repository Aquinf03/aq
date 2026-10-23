import { runKernel } from "../core/python.js"
import { assertTrain } from "../core/schema.js"

const USAGE =
  "usage: aq data hash [dir] [--snapshot]\n" +
  "       aq data list [dir]\n" +
  "       aq data show [dir] [ref]"

export async function data(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log("aq data\n")
    console.log("  aq data hash [dir] [--snapshot]   hash + inspect data.path → tip + immutable revision")
    console.log("  aq data list [dir]                list data/revisions/<hex>.json manifests")
    console.log("  aq data show [dir] [ref]          show tip | sha256:… | digest prefix | revision path")
    console.log("  optional recipe data.name stamps a logical dataset name on the revision")
    return
  }
  if (sub === "hash") {
    const snapshot = argv.includes("--snapshot")
    const rest = argv.slice(1).filter((a) => a !== "--snapshot")
    if (rest.length > 1) throw new Error(USAGE)
    const train = assertTrain(rest[0] ?? ".")
    await runKernel(train, { op: "hash", snapshot })
    return
  }
  if (sub === "list" || sub === "ls") {
    const rest = argv.slice(1)
    if (rest.length > 1) throw new Error(USAGE)
    const train = assertTrain(rest[0] ?? ".")
    await runKernel(train, { op: "data_list" })
    return
  }
  if (sub === "show") {
    const rest = argv.slice(1)
    let train = "."
    let ref = "last"
    if (rest.length === 1) {
      // could be dir or ref
      try {
        train = assertTrain(rest[0])
      } catch {
        ref = rest[0]
        train = assertTrain(".")
      }
    } else if (rest.length === 2) {
      train = assertTrain(rest[0])
      ref = rest[1]
    } else if (rest.length > 2) {
      throw new Error(USAGE)
    } else {
      train = assertTrain(".")
    }
    await runKernel(train, { op: "data_show", ref })
    return
  }
  throw new Error(`unknown data command: ${sub}\n${USAGE}`)
}
