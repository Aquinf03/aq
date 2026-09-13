/** Run identity: config YAML + artifacts folder (SDK-first). */

import { existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"
import { migrateLegacyIdentity } from "./schema.js"

export type RunHandle = {
  /** Directory that contains recipe.yaml (and usually artifacts/). */
  root: string
  configPath: string
  artifactsDir: string
  configDigest?: string
}

/**
 * Open a run from a recipe path or a directory that contains recipe.yaml.
 * Artifacts default to `<root>/artifacts`. experiment.md is optional.
 */
export function openRun(configOrDir: string, artifactsDir?: string): RunHandle {
  const resolved = path.resolve(configOrDir)
  if (!existsSync(resolved)) {
    throw new Error(`not found: ${resolved}`)
  }

  let root: string
  let configPath: string

  if (statSync(resolved).isDirectory()) {
    root = resolved
    migrateLegacyIdentity(root)
    configPath = path.join(root, "recipe.yaml")
    if (!existsSync(configPath)) {
      throw new Error(`not a run (need recipe.yaml): ${root}`)
    }
  } else {
    if (path.basename(resolved) !== "recipe.yaml" && !resolved.endsWith(".yaml") && !resolved.endsWith(".yml")) {
      throw new Error(`expected recipe.yaml path or run directory: ${resolved}`)
    }
    configPath = resolved
    root = path.dirname(resolved)
    migrateLegacyIdentity(root)
  }

  const artifacts = path.resolve(artifactsDir ?? path.join(root, "artifacts"))
  mkdirSync(artifacts, { recursive: true })

  return { root, configPath, artifactsDir: artifacts }
}

/** Resolve CLI/cwd train arg to a RunHandle (compat with assertTrain callers). */
export function openRunFromTrainArg(dir: string): RunHandle {
  return openRun(dir)
}
