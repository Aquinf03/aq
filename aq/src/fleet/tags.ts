/** Labels/tags for places & jobs — local governance, no cloud account. */

export type Tags = Record<string, string>

function tip(msg: string, hint: string): Error {
  // lazy import avoided — callers wrap with ui tip style
  return new Error(msg + "\n  tip  " + hint)
}

/** Parse `key` or `key=value` (value may be empty). */
export function parseTag(raw: string): { key: string; value: string } {
  const s = raw.trim()
  if (!s) throw tip("empty tag", "aq tag place temp team=ml")
  const eq = s.indexOf("=")
  const key = (eq < 0 ? s : s.slice(0, eq)).trim()
  const value = eq < 0 ? "" : s.slice(eq + 1).trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_./:-]*$/.test(key)) {
    throw tip(`bad tag key: ${key}`, "letters, numbers, _ . / : -")
  }
  return { key, value }
}

export function parseTags(raws: string[]): Tags {
  const out: Tags = {}
  for (const r of raws) {
    const { key, value } = parseTag(r)
    out[key] = value
  }
  return out
}

export function mergeTags(base: Tags | undefined, add: Tags): Tags {
  return { ...(base || {}), ...add }
}

export function removeTagKeys(base: Tags | undefined, keys: string[]): Tags {
  const out = { ...(base || {}) }
  for (const k of keys) delete out[k]
  return out
}

/** True if `have` satisfies every required tag (exact value; empty required value = key present). */
export function matchTags(have: Tags | undefined, need: Tags): boolean {
  const h = have || {}
  for (const [k, v] of Object.entries(need)) {
    if (!(k in h)) return false
    if (v !== "" && h[k] !== v) return false
  }
  return true
}

export function fmtTags(tags: Tags | undefined): string {
  if (!tags || !Object.keys(tags).length) return ""
  return Object.keys(tags)
    .sort()
    .map((k) => (tags[k] === "" ? k : `${k}=${tags[k]}`))
    .join(" ")
}

export function tagsEqual(a: Tags | undefined, b: Tags | undefined): boolean {
  return fmtTags(a) === fmtTags(b)
}
