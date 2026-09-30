import { existsSync, readdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"

/**
 * A run is recipe.yaml (+ runtime dir from paths.artifacts, default artifacts/).
 * experiment.md is optional brief — not required for SDK / kernel.
 */

export const LEGACY_IDENTITY = "instructions.md" as const
/** @deprecated Prefer recipe-only; kept for messaging / migration docs. */
export const REQUIRED = ["recipe.yaml"] as const
export const OPTIONAL_IDENTITY = "experiment.md" as const

export const OPTIONAL_DIRS = [
  // Legacy optional slots — not created by init. Paths belong in recipe.yaml.
  "data",
  "evals",
  "artifacts",
] as const

function hasRecipe(root: string): boolean {
  return existsSync(path.join(root, "recipe.yaml"))
}

function hasIdentity(root: string): boolean {
  return (
    existsSync(path.join(root, OPTIONAL_IDENTITY)) ||
    existsSync(path.join(root, LEGACY_IDENTITY))
  )
}

/** Rename legacy `instructions.md` to `experiment.md` when present. */
export function migrateLegacyIdentity(dir: string): void {
  const root = path.resolve(dir)
  const exp = path.join(root, OPTIONAL_IDENTITY)
  const leg = path.join(root, LEGACY_IDENTITY)
  if (!existsSync(exp) && existsSync(leg)) {
    renameSync(leg, exp)
  }
}

/** True if dir has recipe.yaml (SDK-first identity). */
export function isTrain(dir: string): boolean {
  const root = path.resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) return false
  return hasRecipe(root)
}

/** @deprecated Use has recipe only; identity file is optional. */
export function hasTrainBrief(dir: string): boolean {
  return hasIdentity(path.resolve(dir))
}

export function assertTrain(dir: string): string {
  const root = path.resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`)
  }
  migrateLegacyIdentity(root)
  if (!isTrain(root)) {
    throw new Error(`not a run (need recipe.yaml): ${root}`)
  }
  return root
}

/** Train folders directly under dir (relative paths). */
export function childTrains(dir: string): string[] {
  const root = path.resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const out: string[] = []
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue
    const p = path.join(root, name)
    try {
      if (statSync(p).isDirectory() && isTrain(p)) out.push(name)
    } catch {
      /* skip */
    }
  }
  return out.sort()
}

/** First argv token after verb that resolves to a train under cwd. */
export function trainInArgv(cwd: string, parts: string[]): string | null {
  const head = parts[0]
  if (!head) return null
  const tail = parts.slice(1)
  for (const t of tail) {
    if (t.startsWith("-")) continue
    const p = path.resolve(cwd, t)
    if (isTrain(p)) return p
    if (head === "eval" || head === "serve") break
  }
  return null
}
