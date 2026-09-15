import { dirs, exists, usedAq, usedNamed } from "../../lib.mjs"
import path from "node:path"

export function probe({ train, tools }) {
  const errors = []
  const ran =
    usedNamed(tools, "tool", "count_rows") ||
    usedAq(tools, "tool") ||
    usedNamed(tools, "run", "count_rows")
  if (!ran) errors.push("did not run tools/count_rows")
  if (!exists(path.join(train, "artifacts", "tool-used"))) {
    errors.push("count_rows did not run (no artifacts/tool-used)")
  }
  const extra = dirs(path.join(train, "tools")).filter((n) => n !== "count_rows.sh")
  if (extra.length) errors.push("wrote extra tools: " + extra.join(" "))
  return errors
}
