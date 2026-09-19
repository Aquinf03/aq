import { cp, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathRel } from "../core/paths.js"
import { assertTrain } from "../core/schema.js"

/** Copy a run tree for internal use (e.g. spawn). Not a CLI verb. */
export const FORK_SKIP = new Set(["jobs", "artifacts", "node_modules", ".git"])

export type ForkPlan = {
  src: string
  dest: string
}

export async function fork(plan: ForkPlan): Promise<{ src: string; dest: string }> {
  const src = assertTrain(plan.src)
  const dest = path.resolve(plan.dest)
  if (src === dest) {
    throw new Error("source and dest are the same")
  }
  if (existsSync(dest)) {
    throw new Error(`already exists: ${dest}`)
  }

  const artRel = pathRel(src, "artifacts")
  const skip = new Set([...FORK_SKIP, artRel.split(/[\\/]/)[0]!])

  await mkdir(path.dirname(dest), { recursive: true })
  await cp(src, dest, {
    recursive: true,
    filter: (file) => {
      const rel = path.relative(src, file)
      if (!rel || rel === ".") return true
      const parts = rel.split(path.sep)
      if (parts[0] === "jobs") return false
      return !parts.some((p) => skip.has(p))
    },
  })
  for (const name of ["jobs", artRel] as const) {
    const dir = path.join(dest, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, ".keep"), "", "utf8")
  }

  return { src, dest }
}
