/** Aquin account login: aquin.app/aq/ desktop handoff → aq- token in ~/.aquin/config.json. */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

const CONFIG_PATH = join(homedir(), ".aquin", "config.json")
const DEFAULT_AUTH_URL = "https://aquin.app"

type Account = {
  api_key: string
  email?: string | null
  name?: string | null
  user_id?: string | null
  avatar_url?: string | null
  saved_at?: string
  verified_at?: number
}

type AuthCfg = {
  accounts: Record<string, Account>
  active_account: string
}

/** Auth app host. Prod: https://aquin.app (portal at /aq/). Local: AQUIN_AUTH_URL=http://localhost:3000 */
function authBase(): string {
  return (process.env.AQUIN_AUTH_URL || DEFAULT_AUTH_URL).replace(/\/$/, "")
}

function normalizeToken(raw: string): string {
  let key = String(raw || "").trim()
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice(7).trim()
  return key
}

function isUserUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  )
}

function accountId(email: string | null | undefined, name: string | null | undefined, userId: string | null | undefined): string {
  if (email && String(email).includes("@")) return String(email).trim().toLowerCase()
  if (userId) return String(userId)
  if (name) return String(name).trim().toLowerCase().replace(/\s+/g, "-")
  return "account"
}

function loadCfg(): AuthCfg {
  if (!existsSync(CONFIG_PATH)) return { accounts: {}, active_account: "" }
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>
    if (!data || typeof data !== "object") return { accounts: {}, active_account: "" }
    const accounts = data.accounts
    if (accounts && typeof accounts === "object" && Object.keys(accounts as object).length) {
      return {
        accounts: accounts as Record<string, Account>,
        active_account: String(data.active_account || ""),
      }
    }
    const key = normalizeToken(String(data.api_key || ""))
    const accountsDict: Record<string, Account> = {}
    let active = ""
    if (key) {
      const label = String(data.active_account || "saved").trim() || "saved"
      accountsDict[label] = {
        api_key: key,
        name: (data.account_name as string) ?? null,
        email:
          data.account_email && String(data.account_email).includes("@")
            ? String(data.account_email)
            : null,
      }
      active = label
    }
    return { accounts: accountsDict, active_account: active }
  } catch {
    return { accounts: {}, active_account: "" }
  }
}

function saveCfg(cfg: AuthCfg): void {
  mkdirSync(join(homedir(), ".aquin"), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

function saveLogin(payload: {
  api_key: string
  email?: string | null
  name?: string | null
  user_id?: string | null
  avatar_url?: string | null
}): string {
  const key = normalizeToken(payload.api_key)
  if (!key.startsWith("aq-") || key.length < 20) {
    throw new Error("Invalid account token from aquin.app.")
  }
  const aid = accountId(payload.email, payload.name, payload.user_id)
  const cfg = loadCfg()
  const prev: Account =
    cfg.accounts[aid] && typeof cfg.accounts[aid] === "object" ? cfg.accounts[aid] : { api_key: "" }
  const avatarUrl = String(payload.avatar_url || prev.avatar_url || "").trim()
  cfg.accounts[aid] = {
    ...prev,
    api_key: key,
    email: payload.email || prev.email || null,
    name: payload.name || prev.name || null,
    user_id: isUserUuid(payload.user_id)
      ? String(payload.user_id).trim()
      : isUserUuid(prev.user_id)
        ? String(prev.user_id).trim()
        : null,
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    saved_at: new Date().toISOString(),
    verified_at: Date.now() / 1000,
  }
  cfg.active_account = aid
  saveCfg(cfg)
  return aid
}

function parseHandoff(raw: string): string | null {
  let s = String(raw || "").trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  if (!s) return null
  if (!s.includes("://") && /^[A-Za-z0-9_-]{24,}$/.test(s)) return s
  const embedded = s.match(/aquin:\/\/[^\s"']+/i)
  if (embedded) s = embedded[0]
  else if (!s.toLowerCase().startsWith("aquin:")) return null
  try {
    const u = new URL(s)
    const host = (u.hostname || u.host || "").toLowerCase()
    const pathName = (u.pathname || "").replace(/^\//, "").toLowerCase()
    if (host !== "auth" && pathName !== "auth" && host !== "open" && pathName !== "open" && host !== "") {
      return null
    }
    return u.searchParams.get("code")
  } catch {
    return null
  }
}

function openBrowser(url: string): void {
  const plat = process.platform
  if (plat === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
  else if (plat === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref()
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close()
      resolve(ans.trim())
    })
  })
}

function labelOf(id: string, meta: Account): string {
  const name = String(meta.name || "").trim()
  const email = String(meta.email || "").trim()
  if (name && email) return `${name} (${email})`
  return email || name || id
}

function activeAccount(): { id: string; meta: Account } | null {
  const cfg = loadCfg()
  let id = String(cfg.active_account || "").trim()
  if (id && !cfg.accounts[id]) id = ""
  if (!id) {
    const keys = Object.keys(cfg.accounts)
    if (keys.length) id = keys[0]
  }
  const meta = id ? cfg.accounts[id] : null
  if (!meta || !normalizeToken(meta.api_key || "")) return null
  return { id, meta }
}

async function exchangeCode(code: string): Promise<{
  api_key: string
  email?: string | null
  name?: string | null
  user_id?: string | null
  avatar_url?: string | null
}> {
  const url = `${authBase()}/api/auth/desktop/exchange`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code }),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `sign-in failed (HTTP ${res.status})`)
  }
  const api_key = normalizeToken(String(data.api_key || ""))
  if (!api_key.startsWith("aq-") || api_key.length < 20) {
    throw new Error("server returned an invalid account token")
  }
  return {
    api_key,
    email: (data.email as string) ?? null,
    name: (data.name as string) ?? null,
    user_id: (data.user_id as string) ?? null,
    avatar_url: (data.avatar_url as string) ?? null,
  }
}

async function whoamiToken(api_key: string): Promise<{
  email?: string | null
  name?: string | null
  user_id?: string | null
  avatar_url?: string | null
}> {
  const url = `${authBase()}/api/sdk/whoami`
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${api_key}`, accept: "application/json" },
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `whoami failed (HTTP ${res.status})`)
  }
  return {
    email: (data.email as string) ?? null,
    name: (data.name as string) ?? null,
    user_id: (data.user_id as string) ?? null,
    avatar_url: (data.avatar_url as string) ?? null,
  }
}

function printStatus(): void {
  const cur = activeAccount()
  if (!cur) {
    console.log("not signed in")
    console.log("  aq login")
    return
  }
  console.log("signed in")
  console.log("  " + labelOf(cur.id, cur.meta))
  console.log("  " + CONFIG_PATH)
}

export async function loginCmd(argv: string[]): Promise<void> {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(
      [
        "usage: aq login [--force] [--token <aq-…>] [--check]",
        "       aq logout [email]",
        "       aq switch [email]",
        "",
        "Opens aquin.app/aq/?view=desktop&client=cli, then paste",
        "aquin://auth?code=… (or the bare code). Token is stored in ~/.aquin/config.json.",
        "Override host with AQUIN_AUTH_URL (e.g. http://localhost:3000).",
      ].join("\n"),
    )
    return
  }

  const force = argv.includes("--force")
  const check = argv.includes("--check")
  let token = ""
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token") {
      token = String(argv[i + 1] || "")
      i++
    } else if (argv[i].startsWith("--token=")) {
      token = argv[i].slice("--token=".length)
    }
  }

  if (check) {
    printStatus()
    return
  }

  const already = activeAccount()
  if (already && !force && !token) {
    console.log("already signed in as " + labelOf(already.id, already.meta))
    console.log("  aq login --force   sign in again")
    return
  }

  if (token) {
    const key = normalizeToken(token)
    if (!key.startsWith("aq-") || key.length < 20) {
      throw new Error("token must start with aq-")
    }
    const info = await whoamiToken(key)
    const id = saveLogin({ api_key: key, ...info })
    console.log("signed in")
    console.log("  " + id)
    console.log("  " + CONFIG_PATH)
    return
  }

  if (stdin.isTTY !== true) {
    throw new Error("usage: aq login --token <aq-…>   (no TTY; cannot paste a desktop code)")
  }

  const base = authBase()
  const url = `${base}/aq/?view=desktop&client=cli`
  console.log("sign in at aquin.app/aq/")
  console.log("  " + url)
  try {
    openBrowser(url)
  } catch {
    console.log("open that URL in a browser")
  }
  console.log("after sign-in, paste aquin://auth?code=… or the code")
  const pasted = await prompt("> ")
  const code = parseHandoff(pasted)
  if (!code) throw new Error("need aquin://auth?code=… or a one-time code")
  const payload = await exchangeCode(code)
  const id = saveLogin(payload)
  console.log("signed in")
  console.log("  " + id)
  console.log("  " + CONFIG_PATH)
}

export async function logoutCmd(argv: string[]): Promise<void> {
  const who = String(argv[0] || "").trim()
  const cfg = loadCfg()
  if (who) {
    const target = who.toLowerCase()
    for (const k of Object.keys(cfg.accounts)) {
      const meta = cfg.accounts[k]
      const email = String(meta?.email || "").toLowerCase()
      if (k.toLowerCase() === target || email === target) delete cfg.accounts[k]
    }
  } else {
    const active = String(cfg.active_account || "").trim()
    if (active) delete cfg.accounts[active]
    else cfg.accounts = {}
  }
  const remaining = Object.keys(cfg.accounts)
  cfg.active_account = remaining[0] || ""
  saveCfg(cfg)
  if (!remaining.length) console.log("signed out")
  else console.log("signed out. active: " + cfg.active_account)
}

export async function switchCmd(argv: string[]): Promise<void> {
  const cfg = loadCfg()
  const ids = Object.keys(cfg.accounts)
  if (!ids.length) {
    console.log("no saved accounts. aq login")
    return
  }
  const want = String(argv[0] || "").trim().toLowerCase()
  if (!want) {
    for (const id of ids) {
      const mark = id === cfg.active_account ? "*" : " "
      console.log(mark + " " + labelOf(id, cfg.accounts[id]))
    }
    return
  }
  let aid = ""
  for (const k of ids) {
    const email = String(cfg.accounts[k]?.email || "").toLowerCase()
    if (k.toLowerCase() === want || email === want) aid = k
  }
  if (!aid) throw new Error(`no saved account matches "${argv[0]}"`)
  cfg.active_account = aid
  saveCfg(cfg)
  console.log("switched")
  console.log("  " + labelOf(aid, cfg.accounts[aid]))
}
