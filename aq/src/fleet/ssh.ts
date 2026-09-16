/** SSH place: sync train, optional aq setup, interactive shell. */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { aqRoot } from "../core/root.js"
import type { SshPlace } from "./places.js"

export function sshTarget(place: SshPlace): string {
  const user = (place.user || "").trim()
  if (user) return `${user}@${place.host}`
  return place.host
}

export function sshBaseArgs(place: SshPlace): string[] {
  const args: string[] = []
  if (place.port != null && place.port !== 22) {
    args.push("-p", String(place.port))
  }
  if (place.key) {
    const key = place.key.startsWith("~")
      ? path.join(process.env.HOME || "", place.key.slice(1))
      : place.key
    args.push("-i", key)
  }
  args.push("-o", "StrictHostKeyChecking=accept-new")
  return args
}

function expandRemoteDir(remoteDir: string): string {
  // Keep ~/… for remote shell; rsync wants user@host:~/…
  return remoteDir
}

export function rsyncToRemote(train: string, place: SshPlace, remoteDir: string): void {
  const target = sshTarget(place)
  const dest = `${target}:${expandRemoteDir(remoteDir)}/`
  const sshArgs = sshBaseArgs(place)
  const shellSsh = ["ssh", ...sshArgs].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")

  // Ensure remote parent exists
  const mkdir = spawnSync(
    "ssh",
    [...sshBaseArgs(place), target, `mkdir -p ${remoteDir}`],
    { stdio: "inherit", encoding: "utf8" },
  )
  if (mkdir.status !== 0) throw new Error(`ssh mkdir failed (${mkdir.status ?? "?"})`)

  const excludes = [
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    "--exclude",
    "jobs",
    "--exclude",
    "**/__pycache__",
    "--exclude",
    ".venv",
    "--exclude",
    "artifacts/checkpoints",
  ]
  const r = spawnSync(
    "rsync",
    ["-az", "--delete", ...excludes, "-e", shellSsh, train + "/", dest],
    { stdio: "inherit", encoding: "utf8" },
  )
  if (r.error) throw new Error(`rsync: ${r.error.message} (is rsync installed?)`)
  if (r.status !== 0) throw new Error(`rsync failed (${r.status ?? "?"})`)
}

/** Best-effort: ensure `aq` on remote PATH. */
export function setupAqOnRemote(place: SshPlace): void {
  const target = sshTarget(place)
  const localAq = path.join(aqRoot(), "bin", "aq")
  const hasLocal = existsSync(localAq)

  const check = spawnSync(
    "ssh",
    [...sshBaseArgs(place), target, "command -v aq >/dev/null && aq version 2>/dev/null | head -1"],
    { encoding: "utf8" },
  )
  if (check.status === 0 && (check.stdout || "").trim()) {
    console.log("aq on remote")
    console.log("  " + (check.stdout || "").trim())
    return
  }

  if (hasLocal) {
    console.log("setup")
    console.log("  syncing local aq package → ~/.aquin/aq-pkg")
    const pkg = aqRoot()
    const remotePkg = "~/.aquin/aq-pkg"
    const mkdir = spawnSync(
      "ssh",
      [...sshBaseArgs(place), target, "mkdir -p ~/.aquin/aq-pkg ~/.aquin/bin"],
      { stdio: "inherit" },
    )
    if (mkdir.status !== 0) throw new Error("remote mkdir for aq-pkg failed")

    const sshArgs = sshBaseArgs(place)
    const shellSsh = ["ssh", ...sshArgs].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")
    const r = spawnSync(
      "rsync",
      [
        "-az",
        "--delete",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        "--exclude",
        "kernel/.venv",
        "-e",
        shellSsh,
        pkg + "/",
        `${target}:${remotePkg}/`,
      ],
      { stdio: "inherit" },
    )
    if (r.status !== 0) throw new Error("rsync aq package failed")

    const link = spawnSync(
      "ssh",
      [
        ...sshBaseArgs(place),
        target,
        [
          "ln -sfn ~/.aquin/aq-pkg/bin/aq ~/.aquin/bin/aq",
          "grep -q '.aquin/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=\"$HOME/.aquin/bin:$PATH\"' >> ~/.bashrc",
          "export PATH=\"$HOME/.aquin/bin:$PATH\"",
          "command -v node >/dev/null || echo 'warn: node not found on remote — install Node >= 18'",
          "aq version 2>/dev/null || node ~/.aquin/aq-pkg/bin/aq version 2>/dev/null || true",
        ].join(" && "),
      ],
      { stdio: "inherit" },
    )
    if (link.status !== 0) throw new Error("remote aq link failed")
    console.log("aq on remote")
    console.log("  ~/.aquin/bin/aq")
    return
  }

  console.log("setup")
  console.log("  installing aq via install.sh")
  const inst = spawnSync(
    "ssh",
    [
      ...sshBaseArgs(place),
      target,
      "curl -fsSL https://aq.aquin.app/framework/install.sh | bash",
    ],
    { stdio: "inherit" },
  )
  if (inst.status !== 0) {
    throw new Error(
      "remote aq install failed — install Node + aq on the host, or use --no-setup",
    )
  }
}

export function sshInteractive(place: SshPlace, remoteDir: string): Promise<number> {
  const target = sshTarget(place)
  const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.aquin/bin:$PATH" && exec bash -l`
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshBaseArgs(place), "-t", target, remoteCmd], {
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

export function sshCheck(place: SshPlace): { ok: boolean; detail: string } {
  const target = sshTarget(place)
  const r = spawnSync(
    "ssh",
    [...sshBaseArgs(place), target, "echo ok && hostname"],
    { encoding: "utf8", timeout: 15_000 },
  )
  if (r.status === 0) {
    return { ok: true, detail: (r.stdout || "").trim().replace(/^ok\n?/, "") || "ok" }
  }
  const err = ((r.stderr || r.stdout || "") as string).trim() || `exit ${r.status}`
  return { ok: false, detail: err.slice(0, 200) }
}

export function runRemote(
  place: SshPlace,
  remoteDir: string,
  command: string[],
): number {
  const target = sshTarget(place)
  const quoted = command.map((c) => `'${c.replace(/'/g, `'\"'\"'`)}'`).join(" ")
  const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.aquin/bin:$PATH" && ${quoted}`
  const r = spawnSync("ssh", [...sshBaseArgs(place), "-t", target, remoteCmd], {
    stdio: "inherit",
  })
  return r.status ?? 1
}
