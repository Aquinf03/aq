import { startChatUi } from "./chat-ui.js"
import { latestChat, listAllChats, listChats, loadSpec } from "./chat-store.js"
import { shortPath } from "../core/paths.js"

export async function chatCmd(argv: string[]): Promise<void> {
  const cwd = process.cwd()
  const sub = argv[0]
  if (!sub || sub === "new") {
    await startChatUi(cwd)
    return
  }
  if (sub === "list" || sub === "ls") {
    const all = argv.includes("--all")
    const chats = all ? listAllChats() : listChats(cwd)
    if (!chats.length) {
      console.log(all ? "no chats" : "no chats for this train (aq chat list --all for all)")
      return
    }
    for (const c of chats) {
      const where = all && c.train ? `  ${shortPath(c.train)}` : ""
      console.log(`${c.id}  ${c.name}${where}`)
    }
    return
  }
  if (sub === "last") {
    const last = latestChat(cwd)
    if (!last) throw new Error("no chats yet")
    await startChatUi(cwd, last.id)
    return
  }
  loadSpec(cwd, sub)
  await startChatUi(cwd, sub)
}
