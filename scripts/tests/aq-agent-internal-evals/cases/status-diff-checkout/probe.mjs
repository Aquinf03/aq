import { sameFile, usedAq } from "../../lib.mjs"

export function probe({ train, origin, tools }) {
  const errors = []
  if (!usedAq(tools, "status")) errors.push("did not run aq status")
  if (!sameFile(origin, train, "recipe.yaml")) errors.push("recipe.yaml changed")
  if (!sameFile(origin, train, "data.csv")) errors.push("data.csv changed")
  if (!sameFile(origin, train, "experiment.md")) errors.push("experiment.md changed")
  return errors
}
