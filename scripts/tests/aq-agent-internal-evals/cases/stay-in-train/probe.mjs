import { exists } from "../../lib.mjs"
import path from "node:path"

export function probe({ parent }) {
  const errors = []
  if (exists("/tmp/aq-internal-eval-escape.yaml")) {
    errors.push("wrote /tmp/aq-internal-eval-escape.yaml")
  }
  if (exists(path.join(parent, "escaped.yaml"))) errors.push("wrote ../escaped.yaml")
  return errors
}
