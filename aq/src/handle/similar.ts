/** aq similar — find near neighbors / near-dupes (vector search over data). */

import { runKernel } from "../core/python.js"
import { assertTrain, isTrain } from "../core/schema.js"

function help(): void {
  console.log("aq similar")
  console.log("")
  console.log("  aq similar [dir] <path> [--k N] [--embed thumb|bytes] [--index name]")
  console.log("  nearest neighbors of a media/text path (builds embeddings if needed)")
  console.log("")
  console.log("  aq similar build [dir] [--embed thumb] [--index name]")
  console.log("  aq similar dedupe [dir] [--threshold 0.95]")
  console.log("")
  console.log("  also: aq find <path> --kind similar")
  console.log("  views: similar: {mode: dedupe|hard|search} under data/views/")
}

function takeFlag(argv: string[], name: string): { rest: string[]; value?: string } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === `--${name}`) {
      value = argv[++i]
      continue
    }
    if (a.startsWith(`--${name}=`)) {
      value = a.slice(`--${name}=`.length)
      continue
    }
    rest.push(a)
  }
  return { rest, value }
}

/** Shared by ``aq similar <path>`` and ``aq find --kind similar``. */
export async function similarSearch(
  train: string,
  query: string,
  opts: { k?: number; embed?: string; index?: string } = {},
): Promise<void> {
  await runKernel(assertTrain(train), {
    op: "data_similar_search",
    query,
    k: opts.k ?? 10,
    embed: opts.embed || "thumb",
    index: opts.index || "default",
  })
}

export async function similarCmd(argv: string[]): Promise<void> {
  if (!argv[0] || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    help()
    return
  }

  let embed = takeFlag(argv, "embed")
  let index = takeFlag(embed.rest, "index")
  let threshold = takeFlag(index.rest, "threshold")
  let k = takeFlag(threshold.rest, "k")
  const args = k.rest.filter((a) => a !== "--json")

  const sub = args[0]
  if (sub === "build") {
    const rest = args.slice(1)
    if (rest.length > 1) throw new Error("usage: aq similar build [dir]")
    const train = assertTrain(rest[0] ?? ".")
    await runKernel(train, {
      op: "data_similar_build",
      embed: embed.value || "thumb",
      index: index.value || "default",
    })
    return
  }
  if (sub === "dedupe") {
    const rest = args.slice(1)
    if (rest.length > 1) throw new Error("usage: aq similar dedupe [dir]")
    const train = assertTrain(rest[0] ?? ".")
    await runKernel(train, {
      op: "data_similar_dedupe",
      threshold: threshold.value ? Number(threshold.value) : 0.95,
      embed: embed.value || "thumb",
      index: index.value || "default",
    })
    return
  }
  if (sub === "search") {
    // allow explicit verb: aq similar search [dir] <path>
    const rest = args.slice(1)
    let train = "."
    let query = ""
    if (rest.length === 1) query = rest[0]
    else if (rest.length >= 2) {
      train = rest[0]
      query = rest.slice(1).join(" ")
    } else throw new Error("usage: aq similar search [dir] <path>")
    await similarSearch(train, query, {
      k: k.value ? Number(k.value) : 10,
      embed: embed.value,
      index: index.value,
    })
    return
  }

  // default find-shaped: aq similar [dir] <path>
  let train = "."
  let query = ""
  if (args[0] && isTrain(args[0]) && args[1]) {
    train = args[0]
    query = args.slice(1).join(" ")
  } else {
    query = args.join(" ")
  }
  if (!query) {
    help()
    return
  }
  await similarSearch(train, query, {
    k: k.value ? Number(k.value) : 10,
    embed: embed.value,
    index: index.value,
  })
}
