/** Load a local image for chat. Path is cwd-relative or absolute. */

import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const MAX = 12 * 1024 * 1024
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export type ChatImage = {
  path: string
  mime: string
  data: string
}

export function loadImage(cwd: string, raw: string): ChatImage {
  const p = path.resolve(cwd, raw.trim())
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`no image ${raw}`)
  const ext = path.extname(p).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new Error(`unsupported image type ${ext || "(none)"}  use png jpg gif webp`)
  const buf = readFileSync(p)
  if (buf.length > MAX) throw new Error(`image too large (${buf.length} bytes)`)
  return { path: p, mime, data: buf.toString("base64") }
}

export function dataUrl(img: ChatImage): string {
  return `data:${img.mime};base64,${img.data}`
}

export function parseImageArg(arg: string): { path: string; caption: string } {
  const t = arg.trim()
  if (!t) throw new Error("usage: /image <path> [text]")
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0]
    const end = t.indexOf(q, 1)
    if (end < 0) throw new Error("unclosed quote")
    return { path: t.slice(1, end), caption: t.slice(end + 1).trim() }
  }
  const sp = t.search(/\s/)
  if (sp < 0) return { path: t, caption: "" }
  return { path: t.slice(0, sp), caption: t.slice(sp).trim() }
}
