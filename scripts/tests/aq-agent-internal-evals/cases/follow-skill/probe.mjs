import { exists, firstAq, usedAq, usedNamed } from "../../lib.mjs"
import path from "node:path"

export function probe({ train, tools }) {
  const errors = []
  const loaded =
    usedNamed(tools, "skill_load", "hash-first") || usedNamed(tools, "read", "skills/hash-first")
  if (!loaded) errors.push("did not load or read skills/hash-first")
  if (!usedAq(tools, "data")) errors.push("did not run aq data hash")
  if (!usedAq(tools, "train")) errors.push("did not run aq train")
  const hashAt = firstAq(tools, "data")
  const trainAt = firstAq(tools, "train")
  if (hashAt < 0 || trainAt < 0) {
    /* already noted */
  } else if (hashAt > trainAt) errors.push("aq train before aq data hash")
  if (!exists(path.join(train, "data", "revision.json"))) errors.push("missing data/revision.json")
  return errors
}
