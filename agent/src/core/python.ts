/** Python for skill/run-file — prefers the framework kernel venv when present. */

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { kernelRoot } from "./root.js"

export function pythonBin(): string {
  let root: string | null = null
  try {
    root = kernelRoot()
  } catch {
    root = null
  }
  if (root) {
    for (const rel of [
      path.join(".venv", "bin", "python"),
      path.join(".venv", "bin", "python3"),
      path.join(".venv", "Scripts", "python.exe"),
      path.join(".venv", "Scripts", "python"),
    ]) {
      const candidate = path.join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  const probes: { bin: string; args: string[] }[] = [
    { bin: "python3", args: ["-c", "import sys; print(sys.executable)"] },
    { bin: "py", args: ["-3", "-c", "import sys; print(sys.executable)"] },
    { bin: "python", args: ["-c", "import sys; print(sys.executable)"] },
  ]
  for (const p of probes) {
    const r = spawnSync(p.bin, p.args, { encoding: "utf8", timeout: 3000 })
    const out = (r.stdout || "").trim()
    if (r.status === 0 && out && existsSync(out)) return out
    if (r.status === 0 && out) return out
  }
  throw new Error("python3 not found (need python3, py -3, or aq/kernel/.venv)")
}
