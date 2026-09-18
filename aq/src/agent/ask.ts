/** One-shot agent. No chat UI. stdout is the answer. */

import { createInterface } from "node:readline"
import { stdin, stdout, stderr } from "node:process"
import path from "node:path"
import { runTurn } from "./agent-loop.js"
import { clipToolLog, formatPermitDisplay } from "./agent-tools.js"
import { renderMarkdown } from "./markdown.js"
import { isTrain } from "../core/schema.js"

function parseAsk(argv: string[]): { train: string; prompt: string; json: boolean; yes: boolean } {
  const flags = new Set<string>()
  const rest: string[] = []
  for (const a of argv) {
    if (a === "--json") flags.add("json")
    else if (a === "-y" || a === "--yes") flags.add("yes")
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}\nusage: aq ask [-y] [--json] [dir] <prompt>`)
    else rest.push(a)
  }
  if (!rest.length) throw new Error("usage: aq ask [-y] [--json] [dir] <prompt>")
  let train = path.resolve(".")
  let words = rest
  if (rest.length >= 2 && isTrain(path.resolve(rest[0]!))) {
    train = path.resolve(rest[0]!)
    words = rest.slice(1)
  }
  const prompt = words.join(" ").trim()
  if (!prompt) throw new Error("usage: aq ask [-y] [--json] [dir] <prompt>")
  return { train, prompt, json: flags.has("json"), yes: flags.has("yes") }
}

function askYesNo(cmd: string): Promise<boolean> {
  if (stdin.isTTY !== true) return Promise.resolve(false)
  const lines = cmd.split("\n")
  const head = lines[0] ?? cmd
  stderr.write(`allow  ${head}\n`)
  if (lines.length > 1) {
    const body = formatPermitDisplay(cmd)
    const rest = body.includes("\n") ? body.slice(body.indexOf("\n") + 1) : ""
    if (rest) stderr.write(`${rest}\n`)
  }
  stderr.write(`  yes / no? `)
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stderr })
    rl.question("", (line) => {
      rl.close()
      const s = line.trim().toLowerCase()
      resolve(s === "y" || s === "yes")
    })
  })
}

export async function ask(argv: string[]): Promise<void> {
  const { train, prompt, json, yes } = parseAsk(argv)
  const tools: { name: string; args: string }[] = []
  const text = await runTurn(
    train,
    [{ role: "user", content: prompt }],
    () => {},
    (name, args) => {
      tools.push({ name, args: args ?? "" })
      if (!json) stderr.write(`${name}\n`)
    },
    async (command) => {
      if (yes) return true
      return askYesNo(command)
    },
    ({ name, label, result, failed }) => {
      if (json) return
      const head = (label.split("\n")[0] || name).replace(/\s+/g, " ")
      stderr.write(`${failed ? "fail" : "ok"}  ${head}\n`)
      if (name === "write" || name === "edit") return
      if (!result || result === "denied by user") return
      for (const ln of clipToolLog(result, 40, 6000).split("\n")) {
        stderr.write(`  ${ln}\n`)
      }
    },
  )
  const answer = text.trim()
  if (json) {
    stdout.write(JSON.stringify({ text: answer, tools }) + "\n")
    return
  }
  stdout.write(renderMarkdown(answer, undefined, { baseDir: train }) + "\n")
}
