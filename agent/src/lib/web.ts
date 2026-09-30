/** Client web fallback for providers without native search (Ollama). Fetch is always local. */

import { frameworkVersion } from "../core/version.js"

const UA = `aq/${frameworkVersion().version} (local agent; +https://github.com/aquin)`
const FETCH_MAX = 24_000
const SEARCH_MAX = 8
const TIMEOUT_MS = 20_000

type Hit = { title: string; url: string; snippet: string }

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function stripHtml(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  s = decodeEntities(s)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  const t = title ? decodeEntities(title.replace(/\s+/g, " ").trim()) : ""
  return t ? `${t}\n\n${s}` : s
}

function assertHttpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`bad url: ${raw}`)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https")
  const host = u.hostname.toLowerCase()
  if (host === "169.254.169.254" || host.endsWith(".internal")) throw new Error("blocked host")
  return u
}

async function get(url: string, extra: HeadersInit = {}): Promise<{ ctype: string; body: string; final: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*", ...extra },
    })
    if (!res.ok) throw new Error(`http ${res.status}  ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const slice = buf.subarray(0, 400_000)
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase()
    return { ctype, body: slice.toString("utf8"), final: res.url || url }
  } finally {
    clearTimeout(t)
  }
}

function formatHits(hits: Hit[]): string {
  if (!hits.length) return "no results"
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`.trimEnd())
    .join("\n\n")
}

function parseDdg(html: string): Hit[] {
  const hits: Hit[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = decodeEntities(m[1] ?? "")
    const title = decodeEntities(m[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (!href || !title) continue
    let url = href
    const uddg = href.match(/[?&]uddg=([^&]+)/)
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]!)
      } catch {
        /* keep */
      }
    }
    const after = html.slice(m.index, m.index + 1200)
    const snip = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)
    const snippet = snip
      ? decodeEntities(snip[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
      : ""
    hits.push({ title, url, snippet })
    if (hits.length >= SEARCH_MAX) break
  }
  return hits
}

async function ddgSearch(query: string, n: number): Promise<Hit[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": UA,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `q=${encodeURIComponent(query)}`,
    })
    if (!res.ok) throw new Error(`http ${res.status}  duckduckgo`)
    const html = await res.text()
    return parseDdg(html).slice(0, n)
  } finally {
    clearTimeout(t)
  }
}

async function wikiSearch(query: string, n: number): Promise<Hit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&limit=${n}&namespace=0&format=json&search=${encodeURIComponent(query)}`
  const { body } = await get(url)
  const j = JSON.parse(body) as [string, string[], string[], string[]]
  const titles = j[1] ?? []
  const descs = j[2] ?? []
  const urls = j[3] ?? []
  return titles.map((title, i) => ({
    title,
    url: urls[i] ?? "",
    snippet: descs[i] ?? "",
  }))
}

export async function webSearch(query: string, count = 5): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error("need query")
  const n = Math.min(SEARCH_MAX, Math.max(1, Math.floor(count) || 5))
  let hits: Hit[] = []
  try {
    hits = await ddgSearch(q, n)
  } catch {
    hits = []
  }
  if (!hits.length) hits = await wikiSearch(q, n)
  return formatHits(hits.filter((h) => h.url))
}

export async function webFetch(raw: string): Promise<string> {
  const u = assertHttpUrl(raw.trim())
  const { ctype, body, final } = await get(u.toString())
  let text: string
  if (ctype.includes("json") || (body.trimStart().startsWith("{") && body.trimEnd().endsWith("}"))) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      text = body
    }
  } else if (ctype.includes("html") || /<html/i.test(body.slice(0, 800))) {
    text = stripHtml(body)
  } else {
    text = body
  }
  if (text.length > FETCH_MAX) text = text.slice(0, FETCH_MAX) + "\n…"
  return `${final}\n\n${text.trim() || "(empty)"}`
}
