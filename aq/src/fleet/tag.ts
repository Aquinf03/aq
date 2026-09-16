/** aq tag — set/list/remove labels on places and jobs. */

import { getPlace, setPlaceTags } from "./places.js"
import { loadIndex, setJobTags } from "./jobs.js"
import {
  fmtTags,
  mergeTags,
  parseTag,
  parseTags,
  removeTagKeys,
} from "./tags.js"
import { c, stepOk } from "./ui.js"

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

function tagHelp(): string {
  return [
    "aq tag place <name> key[=val]…     add/set tags on a place",
    "aq tag place <name> --rm key…      remove tags",
    "aq tag job <id> key[=val]…         add/set tags on a job",
    "aq tag job <id> --rm key…          remove tags",
    "",
    "Filter:",
    "  aq places --tag team=ml",
    "  aq jobs list --tag exp=sweep",
    "  aq jobs run --tag exp=baseline --on temp -- …",
  ].join("\n")
}

async function tagPlace(argv: string[]): Promise<void> {
  const name = argv[0]
  if (!name) throw tip("need a place name", "aq tag place temp team=ml")
  getPlace(name)
  let rm = false
  const raws: string[] = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--rm" || argv[i] === "--remove") {
      rm = true
      continue
    }
    if (argv[i].startsWith("-")) throw tip(`unknown: ${argv[i]}`, "aq tag place <name> key=val")
    raws.push(argv[i])
  }
  if (!raws.length) {
    const p = getPlace(name)
    const t = fmtTags(p.tags)
    console.log(c.bold("tags") + "  " + c.cyan(name) + (t ? "  " + t : c.dim("  (none)")))
    return
  }
  const cur = getPlace(name).tags
  if (rm) {
    const keys = raws.map((r) => parseTag(r).key)
    setPlaceTags(name, removeTagKeys(cur, keys))
    stepOk("tag", c.cyan(name) + "  removed  " + keys.join(" "))
  } else {
    const next = mergeTags(cur, parseTags(raws))
    setPlaceTags(name, next)
    stepOk("tag", c.cyan(name) + "  " + fmtTags(next))
  }
}

async function tagJob(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) throw tip("need a job id", "aq tag job <id> exp=sweep")
  const idx = loadIndex()
  if (!idx.jobs[id]) throw tip(`no local job record: ${id}`, "aq jobs list")
  let rm = false
  const raws: string[] = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--rm" || argv[i] === "--remove") {
      rm = true
      continue
    }
    if (argv[i].startsWith("-")) throw tip(`unknown: ${argv[i]}`, "aq tag job <id> key=val")
    raws.push(argv[i])
  }
  if (!raws.length) {
    const t = fmtTags(idx.jobs[id].tags)
    console.log(c.bold("tags") + "  " + c.cyan(id) + (t ? "  " + t : c.dim("  (none)")))
    return
  }
  const cur = idx.jobs[id].tags
  if (rm) {
    const keys = raws.map((r) => parseTag(r).key)
    setJobTags(id, removeTagKeys(cur, keys))
    stepOk("tag", c.cyan(id) + "  removed  " + keys.join(" "))
  } else {
    const next = mergeTags(cur, parseTags(raws))
    setJobTags(id, next)
    stepOk("tag", c.cyan(id) + "  " + fmtTags(next))
  }
}

export async function tagCmd(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(tagHelp())
    return
  }
  if (sub === "place" || sub === "places") {
    await tagPlace(argv.slice(1))
    return
  }
  if (sub === "job" || sub === "jobs") {
    await tagJob(argv.slice(1))
    return
  }
  // shorthand: aq tag <place-or-guess>
  throw tip(`unknown: ${sub}`, "aq tag place <name> · aq tag job <id>")
}
