/** Packaged UI cues. macOS, Linux, Windows. Never blocks the chat. */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { soundEnabled } from "./provider.js"
import { agentRoot } from "../core/root.js"

const assets = path.join(agentRoot(), "assets")

const files = {
  click: "ui-click.mp3",
  message: "ui-message.mp3",
} as const

export type Cue = keyof typeof files

type Kind =
  | "afplay"
  | "ffplay"
  | "gst"
  | "mpg123"
  | "mpv"
  | "pw-play"
  | "paplay"
  | "play"
  | "powershell"
  | "none"

let kind: Kind | undefined

function quiet(): boolean {
  return process.env.AQ_QUIET === "1" || !soundEnabled()
}

function onPath(name: string): string | undefined {
  if (path.isAbsolute(name)) return existsSync(name) ? name : undefined
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

function pick(): Kind {
  if (kind) return kind
  if (process.platform === "darwin") {
    kind = existsSync("/usr/bin/afplay") ? "afplay" : onPath("ffplay") ? "ffplay" : "none"
    return kind
  }
  if (process.platform === "win32") {
    kind = onPath("ffplay") ? "ffplay" : onPath("powershell") || onPath("powershell.exe") ? "powershell" : "none"
    return kind
  }
  const linux: [Kind, string][] = [
    ["gst", "gst-play-1.0"],
    ["mpg123", "mpg123"],
    ["mpv", "mpv"],
    ["ffplay", "ffplay"],
    ["pw-play", "pw-play"],
    ["paplay", "paplay"],
    ["play", "play"],
  ]
  kind = linux.find(([, bin]) => onPath(bin))?.[0] ?? "none"
  return kind
}

function winPs(file: string): string {
  const lit = file.replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = (Get-Item -LiteralPath '${lit}').FullName`,
    "try {",
    "  Add-Type -AssemblyName PresentationCore",
    "  $m = New-Object System.Windows.Media.MediaPlayer",
    "  $m.Open([Uri]::new($p))",
    "  $m.Play()",
    "  Start-Sleep -Milliseconds 2500",
    "} catch {",
    "  $w = New-Object -ComObject WMPlayer.OCX",
    "  $w.URL = $p",
    "  $w.controls.play()",
    "  Start-Sleep -Milliseconds 2500",
    "}",
  ].join("; ")
}

function argv(k: Kind, file: string): { cmd: string; args: string[] } | undefined {
  if (k === "none") return
  if (k === "afplay") return { cmd: "/usr/bin/afplay", args: [file] }
  if (k === "ffplay") {
    const cmd = onPath("ffplay")
    if (!cmd) return
    return { cmd, args: ["-nodisp", "-autoexit", "-nostats", "-loglevel", "quiet", file] }
  }
  if (k === "gst") {
    const cmd = onPath("gst-play-1.0")
    if (!cmd) return
    return { cmd, args: ["--quiet", file] }
  }
  if (k === "mpg123") {
    const cmd = onPath("mpg123")
    if (!cmd) return
    return { cmd, args: ["-q", file] }
  }
  if (k === "mpv") {
    const cmd = onPath("mpv")
    if (!cmd) return
    return { cmd, args: ["--no-video", "--really-quiet", "--no-terminal", file] }
  }
  if (k === "pw-play") {
    const cmd = onPath("pw-play")
    if (!cmd) return
    return { cmd, args: [file] }
  }
  if (k === "paplay") {
    const cmd = onPath("paplay")
    if (!cmd) return
    return { cmd, args: [file] }
  }
  if (k === "play") {
    const cmd = onPath("play")
    if (!cmd) return
    return { cmd, args: ["-q", file] }
  }
  const cmd = onPath("powershell") ?? onPath("powershell.exe")
  if (!cmd) return
  return {
    cmd,
    args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", winPs(file)],
  }
}

export function playCue(cue: Cue): void {
  if (quiet()) return
  const file = path.join(assets, files[cue])
  if (!existsSync(file)) return
  const player = argv(pick(), file)
  if (!player) return
  try {
    spawn(player.cmd, player.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref()
  } catch {
    // ignore
  }
}
