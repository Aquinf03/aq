import { exists, usedNamed } from "../../lib.mjs"
import path from "node:path"

export function probe({ train, tools }) {
  const errors = []
  if (!usedNamed(tools, "tool", "broken")) errors.push("did not run tools/broken")
  if (!usedNamed(tools, "tool", "ok") && !exists(path.join(train, "artifacts", "recovered.txt"))) {
    errors.push("did not run tools/ok after the failure")
  }
  if (!exists(path.join(train, "artifacts", "recovered.txt"))) {
    errors.push("task not finished (missing artifacts/recovered.txt)")
  }
  return errors
}
