/**
 * Spawns the Python AsyncSSH sidecar and speaks newline-delimited JSON-RPC over stdio.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

class SshBridge {
  /**
   * @param {{ root: string, pythonPath?: string }} opts
   */
  constructor(opts) {
    this.root = opts.root;
    this.pythonPath = opts.pythonPath || "python3";
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.child = null;
    /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
  }

  async start() {
    const script = path.join(this.root, "desktop", "ssh-service", "main.py");
    const pythonPath = path.isAbsolute(this.pythonPath)
      ? this.pythonPath
      : path.resolve(this.root, this.pythonPath);

    this.child = spawn(pythonPath, ["-u", script], {
      cwd: path.join(this.root, "desktop", "ssh-service"),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => {
      console.error("[ssh-service] spawn error:", err);
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.#onLine(line));

    this.child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (text) console.error("[ssh-service]", text);
    });

    this.child.on("exit", (code, signal) => {
      this.ready = false;
      const err = new Error(`SSH service exited (code=${code}, signal=${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.child = null;
    });

    // Give Python a moment to bind stdin before the first write.
    await new Promise((r) => setTimeout(r, 50));

    const ping = await this.request("ping", {});
    if (!ping || ping.ok !== true) {
      throw new Error("SSH service ping failed");
    }
    this.ready = true;
  }

  async stop() {
    if (!this.child) return;
    try {
      await this.request("shutdown", {});
    } catch {
      /* ignore */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    this.child.kill("SIGTERM");
    this.child = null;
    this.ready = false;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  request(method, params = {}) {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("SSH service is not running"));
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`SSH request timed out: ${method}`));
        }
      }, 120_000);
    });
  }

  /** @param {string} line */
  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[ssh-service] bad JSON:", line);
      return;
    }
    const id = msg?.id != null ? String(msg.id) : null;
    if (!id || !this.pending.has(id)) return;
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (msg.error) {
      pending.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
}

module.exports = { SshBridge };
