import { runKernel } from "../core/python.js"
import { assertTrain, isTrain } from "../core/schema.js"

const USAGE =
  "usage: aq data hash [dir] [--snapshot] [--view name]\n" +
  "       aq data list [dir]\n" +
  "       aq data show [dir] [ref]\n" +
  "       aq data view list|show|apply [dir] [name]"

export async function data(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log("aq data\n")
    console.log("  aq data hash [dir] [--snapshot] [--view name]")
    console.log("      hash data.path → tip + revision; --view materializes a hyper-dataset view")
    console.log("  aq data list [dir]                list data/revisions manifests")
    console.log("  aq data show [dir] [ref]          show tip | sha256:… | revision path")
    console.log("  aq data view list [dir]           list data/views/*.yaml")
    console.log("  aq data view show [dir] <name>    show view (meta or resolve)")
    console.log("  aq data view apply [dir] <name>   materialize selection.jsonl (no lake copy)")
    console.log("  recipe data.view / data.annotations — hyper-dataset hooks")
    return
  }
  if (sub === "view") {
    const vsub = argv[1]
    if (!vsub || vsub === "help" || vsub === "-h" || vsub === "--help") {
      console.log("aq data view\n")
      console.log("  aq data view list [dir]")
      console.log("  aq data view show [dir] <name>")
      console.log("  aq data view apply [dir] <name>")
      return
    }
    const rest = argv.slice(2)
    if (vsub === "list" || vsub === "ls") {
      if (rest.length > 1) throw new Error(USAGE)
      const train = assertTrain(rest[0] ?? ".")
      await runKernel(train, { op: "data_view_list" })
      return
    }
    if (vsub === "show" || vsub === "apply") {
      let train = "."
      let name = ""
      if (rest.length === 1) {
        name = rest[0]
      } else if (rest.length === 2 && isTrain(rest[0])) {
        train = rest[0]
        name = rest[1]
      } else if (rest.length === 2) {
        train = assertTrain(rest[0])
        name = rest[1]
      } else {
        throw new Error(USAGE)
      }
      if (!name) throw new Error(USAGE)
      train = assertTrain(train)
      await runKernel(train, {
        op: vsub === "show" ? "data_view_show" : "data_view_apply",
        view: name,
      })
      return
    }
    throw new Error(`unknown data view command: ${vsub}\n${USAGE}`)
  }
  if (sub === "hash") {
    const snapshot = argv.includes("--snapshot")
    let view: string | undefined
    const rest: string[] = []
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]
      if (a === "--snapshot") continue
      if (a === "--view") {
        view = argv[++i]
        continue
      }
      if (a.startsWith("--view=")) {
        view = a.slice("--view=".length)
        continue
      }
      rest.push(a)
    }
    if (rest.length > 1) throw new Error(USAGE)
    const train = assertTrain(rest[0] ?? ".")
    await runKernel(train, { op: "hash", snapshot, view })
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
