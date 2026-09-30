/** Help for the standalone aq-agent package. */

export function help(): string {
  return [
    "aq-agent  Aquin agent (separate from the aq framework CLI)",
    "",
    "Chat lives here. Train / eval / jobs / fleet live in `aq` (set AQ_ROOT if needed).",
    "",
    "  aq-agent                 chat (TTY)",
    "  aq-agent agent           same",
    "  aq-agent chat list       previous chats",
    "  aq-agent chat last       resume the latest",
    "  aq-agent chat <id>       resume that chat",
    "  aq-agent ask [dir] <prompt>   one-shot answer (no chat UI)",
    "  aq-agent ask --json [dir] <prompt>",
    "  aq-agent help            this text",
    "  aq-agent version         agent version (-v / --version; version --verbose for paths)",
    "  aq-agent provider        list openai / anthropic / grok / ollama",
    "  aq-agent provider <name> save key (hidden) and use it",
    "  aq-agent provider use <name>  switch",
    "  aq-agent doctor [dir]    health check (agent, provider, train, skills, mcp, aq framework)",
    "  aq-agent spawn agent [dir] -- <prompt>  start a worker agent",
    "  aq-agent spawn agent --kill -- <prompt>  critic: cheapest disproof",
    "  aq-agent spawn list [dir]",
    "  aq-agent spawn log [dir] <id>",
    "  aq-agent spawn cancel [dir] <id>",
    "",
    "Framework (install separately): aq train | eval | jobs | …",
    "  Docs: https://aq.aquin.app/docs",
  ].join("\n")
}
