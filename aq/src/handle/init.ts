import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { OPTIONAL_DIRS } from "../core/schema.js"
import { aqRoot } from "../core/root.js"

const templates = path.join(aqRoot(), "templates")

/** Default folder name when user runs bare `aq init`. Safe to rename anytime. */
export const DEFAULT_EXPERIMENT_NAME = "aq-experiment"

export type InitResult = {
  root: string
  created: string[]
  skipped: string[]
}

async function writeNew(
  dest: string,
  body: string,
  created: string[],
  skipped: string[],
  cwd: string,
): Promise<void> {
  const rel = path.relative(cwd, dest) || dest
  if (existsSync(dest)) {
    skipped.push(rel)
    return
  }
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, body, "utf8")
  created.push(rel)
}

async function copyTemplateFiles(
  subdir: string,
  destDir: string,
  created: string[],
  skipped: string[],
  cwd: string,
): Promise<void> {
  const srcDir = path.join(templates, subdir)
  if (!existsSync(srcDir)) return
  await mkdir(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    if (name.startsWith(".")) continue
    const src = path.join(srcDir, name)
    const dest = path.join(destDir, name)
    const rel = path.relative(cwd, dest) || dest
    if (existsSync(dest)) {
      skipped.push(rel)
      continue
    }
    await copyFile(src, dest)
    created.push(rel)
  }
}

function assertNotCliHome(root: string): void {
  const pkg = path.join(root, "package.json")
  const cli = path.join(root, "src", "cli.ts")
  if (!existsSync(pkg) || !existsSync(cli)) return
  throw new Error("this is the aq CLI package. init a train folder: aq init")
}

/** Empty or missing dir is OK. Non-empty dirs get a -newN sibling instead. */
function isUsableTarget(dir: string): boolean {
  if (!existsSync(dir)) return true
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/**
 * Pick `base`, or `base-new1`, `base-new2`, … under parent.
 * Folder name is only a label — rename freely; aq keys off files inside the train.
 */
export function allocateExperimentDir(parent: string, baseName: string): string {
  const base =
    baseName
      .replace(/[/\\]/g, "")
      .replace(/^\.+/, "")
      .trim() || DEFAULT_EXPERIMENT_NAME
  const first = path.join(parent, base)
  if (isUsableTarget(first)) return first
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.join(parent, `${base}-new${i}`)
    if (isUsableTarget(candidate)) return candidate
  }
  throw new Error(`could not allocate a free folder name under ${parent}`)
}

/**
 * Where bare / named `aq init` should create the train.
 * Never initializes into cwd itself (avoids exploding the working tree).
 */
export function resolveInitRoot(arg?: string): string {
  const cwd = process.cwd()
  if (!arg || arg === ".") {
    return allocateExperimentDir(cwd, DEFAULT_EXPERIMENT_NAME)
  }
  const resolved = path.resolve(cwd, arg)
  return allocateExperimentDir(path.dirname(resolved), path.basename(resolved))
}

/** Write train skeleton into an exact directory (e.g. stages/<name>). */
export async function init(dir: string): Promise<InitResult> {
  const root = path.resolve(dir)
  const cwd = process.cwd()
  await mkdir(root, { recursive: true })
  assertNotCliHome(root)

  const created: string[] = []
  const skipped: string[] = []

  // recipe.yaml is required identity; experiment.md is optional brief (still scaffolded).
  for (const name of ["recipe.yaml", "experiment.md"] as const) {
    const dest = path.join(root, name)
    const body = await readFile(path.join(templates, name), "utf8")
    await writeNew(dest, body, created, skipped, cwd)
  }

  for (const name of OPTIONAL_DIRS) {
    const dest = path.join(root, name)
    const keep = path.join(dest, ".keep")
    if (existsSync(dest)) {
      skipped.push(path.relative(cwd, dest) || dest)
      continue
    }
    await mkdir(dest, { recursive: true })
    await writeFile(keep, "", "utf8")
    created.push(path.relative(cwd, dest) || dest)
  }

  await copyTemplateFiles("tools", path.join(root, "tools"), created, skipped, cwd)
  await copyTemplateFiles("skills", path.join(root, "skills"), created, skipped, cwd)

  return { root, created, skipped }
}
