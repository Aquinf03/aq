/** Run a script file under a train cwd (used by skill_run). */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { pythonBin } from "../core/python.js"
import { aqRoot, kernelRoot } from "../core/root.js"

export function runFileCaptured(train: string, file: string, extra: string[] = []): string {
  const ext = path.extname(file)
  let cmd = file
  let args = extra
  if (ext === ".py") {
    cmd = pythonBin()
    args = [file, ...extra]
  } else if (ext === ".ts") {
    const tsxCli = path.join(aqRoot(), "node_modules", "tsx", "dist", "cli.mjs")
    if (!existsSync(tsxCli)) throw new Error("tsx not found (need it to run .ts skill code)")
    cmd = process.execPath
    args = [tsxCli, file, ...extra]
  } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    cmd = process.execPath
    args = [file, ...extra]
  } else if (ext === ".sh") {
    cmd = "sh"
    args = [file, ...extra]
  } else {
    throw new Error(`cannot run ${ext}`)
  }
  const r = spawnSync(cmd, args, {
    cwd: train,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, AQ_TRAIN: train, AQ_KERNEL: kernelRoot() },
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  if (r.status !== 0) throw new Error(out || `exit ${r.status}`)
  return out || "ok"
}
