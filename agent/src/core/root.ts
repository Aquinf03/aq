/** Agent package root + locate the separate `aq` framework package. */

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** This package (`agent/`) root. */
export function agentRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "bin"))) return d
    d = path.dirname(d)
  }
  throw new Error("aq-agent package root not found")
}

/** @deprecated use agentRoot — kept so older call sites compile during the split. */
export function aqRoot(): string {
  return agentRoot()
}

/**
 * Framework package root (`aq/` with kernel + bin/aq).
 * Lookup: AQ_ROOT env → sibling ../aq in monorepo → PATH is not used here.
 */
export function frameworkRoot(): string {
  const env = process.env.AQ_ROOT?.trim()
  if (env && existsSync(path.join(env, "bin", "aq"))) return path.resolve(env)

  const agent = agentRoot()
  const sibling = path.resolve(agent, "..", "aq")
  if (existsSync(path.join(sibling, "bin", "aq"))) return sibling

  // Walk up from cwd for a workspace checkout
  let d = process.cwd()
  for (let i = 0; i < 8; i++) {
    const cand = path.join(d, "aq")
    if (existsSync(path.join(cand, "bin", "aq"))) return cand
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  throw new Error(
    "aq framework not found — set AQ_ROOT to the aq package (with bin/aq), or install aq next to aq-agent",
  )
}

export function aqBin(): string {
  const fromEnv = process.env.AQ_BIN?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  return path.join(frameworkRoot(), "bin", "aq")
}

export function kernelRoot(): string {
  return path.join(frameworkRoot(), "kernel")
}
