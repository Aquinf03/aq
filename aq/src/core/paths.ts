import { homedir } from "node:os"
import path from "node:path"
import { readRecipeFile } from "./recipe-yaml.js"

export function insideTrain(train: string, rel: string): string {
  const root = path.resolve(train)
  const dest = path.resolve(root, rel)
  const relTo = path.relative(root, dest)
  if (relTo.startsWith("..") || path.isAbsolute(relTo)) {
    throw new Error(`outside train: ${rel}`)
  }
  return dest
}

export function shortPath(p: string): string {
  const abs = path.resolve(p)
  const home = homedir()
  if (abs === home) return "~"
  if (abs.startsWith(home + path.sep)) return "~" + abs.slice(home.length)
  return abs
}

/** Defaults match the classic layout; override via recipe.yaml `paths:`. */
export const PATH_DEFAULTS = {
  artifacts: "artifacts",
  evals: "evals",
} as const

export type PathKey = keyof typeof PATH_DEFAULTS

export function pathMap(trainOrRecipe: string): Record<PathKey, string> {
  const rec = readRecipeFile(trainOrRecipe)
  const raw = (rec.paths && typeof rec.paths === "object" && !Array.isArray(rec.paths)
    ? (rec.paths as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const out: Record<PathKey, string> = { ...PATH_DEFAULTS }
  for (const key of Object.keys(PATH_DEFAULTS) as PathKey[]) {
    const v = raw[key]
    if (v == null || v === false) continue
    const s = String(v).trim()
    if (s) out[key] = s
  }
  return out
}

export function pathRel(trainOrRecipe: string, key: PathKey): string {
  return pathMap(trainOrRecipe)[key]
}

/** Resolve a layout path (relative to train root, or absolute). */
export function resolveLayoutPath(train: string, relOrAbs: string): string {
  if (path.isAbsolute(relOrAbs)) return path.resolve(relOrAbs)
  return path.resolve(train, relOrAbs)
}

export function artifactsDir(train: string): string {
  return resolveLayoutPath(train, pathRel(train, "artifacts"))
}

export function evalsDir(train: string): string {
  return resolveLayoutPath(train, pathRel(train, "evals"))
}
