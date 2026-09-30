/** Stdio MCP client. Skills start servers; aq talks JSON-RPC. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { frameworkVersion } from "../core/version.js"

export type McpSpec = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpToolInfo = {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams
  private buf = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false

  constructor(train: string, spec: McpSpec) {
    const env = { ...process.env }
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      env[k] = interpolate(v)
    }
    this.proc = spawn(spec.command, spec.args ?? [], {
      cwd: train,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk))
    this.proc.stderr.on("data", () => {})
    this.proc.on("error", (err) => this.failAll(err))
    this.proc.on("exit", () => this.failAll(new Error("mcp server exited")))
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aq", version: frameworkVersion().version },
    })
    this.notify("notifications/initialized", {})
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    let cursor: string | undefined
    for (let i = 0; i < 8; i++) {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[]
        nextCursor?: string
      }
      for (const t of res.tools ?? []) {
        if (!t.name) continue
        out.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
        })
      }
      cursor = res.nextCursor
      if (!cursor) break
    }
    return out
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type?: string; text?: string }[]
      isError?: boolean
    }
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
      .join("\n")
      .trim()
    if (res.isError) throw new Error(text || `mcp ${name} error`)
    return text || "ok"
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error("mcp closed"))
    this.proc.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: "2.0", id, method, params })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`mcp timeout: ${method}`))
        }
      }, 20_000)
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  private write(msg: object): void {
    if (this.closed) return
    const json = JSON.stringify(msg)
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const msg = this.readMsg()
      if (!msg) break
      this.onMsg(msg)
    }
  }

  private readMsg(): unknown | null {
    const headerEnd = this.buf.indexOf("\r\n\r\n")
    if (headerEnd >= 0) {
      const header = this.buf.subarray(0, headerEnd).toString("utf8")
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4)
        return null
      }
      const len = Number(m[1])
      const start = headerEnd + 4
      if (this.buf.length < start + len) return null
      const json = this.buf.subarray(start, start + len).toString("utf8")
      this.buf = this.buf.subarray(start + len)
      try {
        return JSON.parse(json)
      } catch {
        return null
      }
    }
    const nl = this.buf.indexOf("\n")
    if (nl < 0) return null
    const line = this.buf.subarray(0, nl).toString("utf8").trim()
    this.buf = this.buf.subarray(nl + 1)
    if (!line.startsWith("{")) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  private onMsg(msg: unknown): void {
    const j = msg as { id?: number; result?: unknown; error?: { message?: string } }
    if (j.id == null) return
    const p = this.pending.get(j.id)
    if (!p) return
    this.pending.delete(j.id)
    if (j.error) p.reject(new Error(j.error.message ?? "mcp error"))
    else p.resolve(j.result)
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

export async function startMcp(train: string, spec: McpSpec): Promise<McpClient> {
  const c = new McpClient(train, spec)
  await c.initialize()
  return c
}

function interpolate(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "")
}
