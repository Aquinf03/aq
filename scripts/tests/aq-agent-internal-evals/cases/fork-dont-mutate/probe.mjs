import { checkpoint, exists, read, sameFile, usedAq } from "../../lib.mjs"
import path from "node:path"

export function probe({ train, parent, origin, tools }) {
  const errors = []
  if (!sameFile(origin, train, "recipe.yaml")) errors.push("original recipe.yaml changed")
  const variant = path.join(parent, "variant")
  if (!exists(path.join(variant, "recipe.yaml"))) errors.push("no ../variant fork")
  else {
    if (!/method:\s*boosting/.test(read(path.join(variant, "recipe.yaml")))) {
      errors.push("variant recipe is not boosting")
    }
    if (!checkpoint(variant)) errors.push("variant was not trained")
  }
  if (!usedAq(tools, "fork") && !exists(variant)) errors.push("did not fork")
  return errors
}
