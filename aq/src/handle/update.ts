/** `aq update` — reinstall the latest release (same path as curl | bash). */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { aqRoot } from "../core/root.js"
import { frameworkVersion } from "../core/version.js"

const DEFAULT_INSTALL_SH = "https://aquin.app/aq/download/install.sh"

function findBash(): string {
  const fromPath = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" })
  if (fromPath.status === 0) return "bash"
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      path.join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }
  throw new Error(
    "bash is required for aq update (macOS/Linux shell, or Git Bash on Windows).\n" +
      "Or run: curl -fsSL https://aquin.app/aq/download/install.sh | bash",
  )
}

function isSourceCheckout(root: string): boolean {
  // release tree: …/aquin-framework/aq ; checkout: …/aqfw/aq with sibling .git / install.sh
  const parent = path.dirname(root)
  return (
    existsSync(path.join(parent, ".git")) ||
    existsSync(path.join(parent, "install.sh")) ||
    existsSync(path.join(root, "..", ".git"))
  )
}

export async function updateCmd(argv: string[]): Promise<void> {
  const checkOnly = argv.includes("--check")
  const v = frameworkVersion()
  console.log(`aq ${v.version}`)
  console.log(`root ${v.aqRoot}`)

  if (checkOnly) {
    console.log("update check: re-run without --check to install the latest release")
    console.log(`  curl -fsSL ${DEFAULT_INSTALL_SH} | bash`)
    return
  }

  if (isSourceCheckout(v.aqRoot)) {
    console.log("note: this binary looks like a source checkout")
    console.log("      update installs the published release under ~/.local (does not git-pull this tree)")
  }

  const url = process.env.AQUIN_INSTALL_URL || DEFAULT_INSTALL_SH
  const bash = findBash()
  console.log(`updating via ${url}`)
  console.log("")

  // Same entrypoint as docs install — keeps Windows/venv/link logic in install.sh only.
  const script = `curl -fsSL ${JSON.stringify(url)} | bash`
  const r = spawnSync(bash, ["-lc", script], {
    stdio: "inherit",
    env: process.env,
  })
  if (r.error) throw r.error
  if (r.status !== 0 && r.status != null) {
    process.exitCode = r.status
    return
  }

  console.log("")
  console.log("update done — open a new shell if `aq version` still shows the old build (PATH hash).")
  console.log("  aq version")
}
