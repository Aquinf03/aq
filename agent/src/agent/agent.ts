/** Terminal chat. `aq-agent` and `aq-agent agent` are the same entry. */

import { stdin, stdout } from "node:process"
import { startChatUi } from "./chat-ui.js"
import { help } from "../help.js"

export type ChatDecision = "help" | "chat" | "usage" | "skip"

export function decideChat(argv: string[], opts: { tty: boolean }): ChatDecision {
  const cmd = argv[0]
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return "help"
  if (cmd && cmd !== "agent") return "skip"
  if (cmd === "agent" && argv.length > 1) return "usage"
  if (!opts.tty) return "help"
  return "chat"
}

export async function runAgent(argv: string[], cwd: string): Promise<void> {
  const tty = stdin.isTTY === true && stdout.isTTY === true
  const decision = decideChat(argv, { tty })
  if (decision === "skip") return
  if (decision === "help") {
    console.log(help())
    return
  }
  if (decision === "usage") {
    throw new Error("usage: aq-agent agent")
  }
  await startChat(cwd)
}

export async function startChat(cwd: string, id?: string): Promise<void> {
  await startChatUi(cwd, id)
}
