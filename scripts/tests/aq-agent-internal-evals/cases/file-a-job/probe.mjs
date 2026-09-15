import { jobs, usedAq, usedNamed } from "../../lib.mjs"

export function probe({ train, tools }) {
  const errors = []
  const ids = jobs(train)
  if (!ids.length) errors.push("no jobs/ spec")
  const filed =
    usedAq(tools, "job") ||
    usedNamed(tools, "run", "detach=true") ||
    usedNamed(tools, "run", '"detach":true')
  if (!filed && !ids.length) errors.push("did not file a job or detached run")
  return errors
}
