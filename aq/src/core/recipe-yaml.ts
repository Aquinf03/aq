/** Indent-aware subset of YAML for recipe.yaml (nested maps, simple lists). */

import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

function scalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s === "" || s === "null" || s === "~" || s === "None") return null
  if (s === "true" || s === "yes") return true
  if (s === "false" || s === "no") return false
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s)
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => scalar(x) as string)
  }
  return s
}

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === " ") n += 1
    else if (ch === "\t") n += 2
    else break
  }
  return n
}

/**
 * Parse a small YAML subset into nested objects/arrays.
 * Enough for nested recipe config and path-based keys.
 */
export function parseSimpleYaml(text: string): Record<string, YamlValue> {
  const root: Record<string, YamlValue> = {}
  type Frame = { indent: number; obj: Record<string, YamlValue> | YamlValue[] }
  const stack: Frame[] = [{ indent: -1, obj: root }]

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ""
    const noComment = raw.split("#", 1)[0] ?? ""
    if (!noComment.trim()) continue
    const indent = indentOf(noComment)
    const trimmed = noComment.trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]!

    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim()
      if (!Array.isArray(parent.obj)) {
        throw new Error(`yaml: list item without list parent near: ${trimmed}`)
      }
      if (item.includes(":") && !item.startsWith("[") && !item.endsWith(":")) {
        const [k, ...rest] = item.split(":")
        const child: Record<string, YamlValue> = { [k!.trim()]: scalar(rest.join(":")) }
        parent.obj.push(child)
        stack.push({ indent, obj: child })
      } else if (item.endsWith(":")) {
        const child: Record<string, YamlValue> = {}
        parent.obj.push(child)
        stack.push({ indent, obj: child })
      } else {
        parent.obj.push(scalar(item))
      }
      continue
    }

    if (!trimmed.includes(":")) continue
    const colon = trimmed.indexOf(":")
    const key = trimmed.slice(0, colon).trim()
    const rest = trimmed.slice(colon + 1).trim()

    if (Array.isArray(parent.obj) || typeof parent.obj !== "object" || parent.obj == null) {
      continue
    }

    if (rest === "") {
      let isList = false
      for (let j = i + 1; j < lines.length; j++) {
        const peek = (lines[j] ?? "").split("#", 1)[0] ?? ""
        if (!peek.trim()) continue
        const nextIndent = indentOf(peek)
        if (nextIndent <= indent) break
        isList = peek.trim().startsWith("- ")
        break
      }
      if (isList) {
        const arr: YamlValue[] = []
        parent.obj[key] = arr
        stack.push({ indent, obj: arr })
      } else {
        const child: Record<string, YamlValue> = {}
        parent.obj[key] = child
        stack.push({ indent, obj: child })
      }
    } else {
      parent.obj[key] = scalar(rest)
    }
  }

  return root
}

export function readRecipeFile(trainOrRecipe: string): Record<string, YamlValue> {
  let file = trainOrRecipe
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = path.join(file, "recipe.yaml")
  }
  if (!existsSync(file)) return {}
  return parseSimpleYaml(readFileSync(file, "utf8"))
}
