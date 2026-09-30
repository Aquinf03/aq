/** aq-agent version — from this package's package.json */

import { readFileSync } from "node:fs"
import path from "node:path"
import { agentRoot, frameworkRoot, kernelRoot } from "./root.js"

export type AgentVersion = {
  name: string
  version: string
  agentRoot: string
  frameworkRoot: string
  kernel: string
  node: string
}

export function frameworkVersion(): AgentVersion {
  const root = agentRoot()
  let version = "0.0.0"
  let name = "aq-agent"
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string
      version?: string
    }
    if (pkg.version) version = String(pkg.version)
    if (pkg.name) name = String(pkg.name)
  } catch {
    /* keep defaults */
  }
  let fw = "(missing)"
  let kernel = "(missing)"
  try {
    fw = frameworkRoot()
    kernel = kernelRoot()
  } catch {
    /* framework optional until first aq_* call */
  }
  return {
    name,
    version,
    agentRoot: root,
    frameworkRoot: fw,
    kernel,
    node: process.version,
  }
}

export function versionLine(): string {
  const v = frameworkVersion()
  return `${v.name} ${v.version}`
}

export function versionReport(verbose = false): string {
  const v = frameworkVersion()
  if (!verbose) return versionLine()
  return [
    versionLine(),
    `  agent     ${v.agentRoot}`,
    `  framework ${v.frameworkRoot}`,
    `  kernel    ${v.kernel}`,
    `  node      ${v.node}`,
  ].join("\n")
}
