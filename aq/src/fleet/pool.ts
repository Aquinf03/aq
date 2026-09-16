/** SSH pools — pick a free member with simple load awareness. */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  getPlace,
  loadPlaces,
  type PoolPlace,
  type SshPlace,
} from "./places.js"
import { assertPlaceCanSatisfy, sshCheck, sshExec } from "./ssh.js"
import { c } from "./ui.js"

export type ResolveAsk = { gpu?: number }

export type ResolvedSsh = {
  /** Name used in --on (pool or ssh). */
  requested: string
  /** Concrete SSH place name. */
  name: string
  place: SshPlace
  viaPool?: string
}

function tip(msg: string, hint: string): Error {
  return new Error(msg + "\n  " + c.dim("tip") + "  " + hint)
}

/** Running-ish jobs for a place from local index + optional remote peek. */
function localRunningLoad(member: string): number {
  const p = path.join(homedir(), ".aquin", "fleet-jobs.json")
  if (!existsSync(p)) return 0
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      jobs?: Record<string, { place?: string }>
    }
    let n = 0
    for (const j of Object.values(raw.jobs || {})) {
      if (j.place === member) n += 1
    }
    // index includes finished jobs — prefer remote count when cheap; weight lightly
    return Math.min(n, 20)
  } catch {
    return 0
  }
}

function memberLoad(name: string, place: SshPlace): number {
  const local = localRunningLoad(name)
  const r = sshExec(
    place,
    [
      `n=0`,
      `for d in "$HOME"/aq-runs/*/jobs/*/pid "$HOME"/aq-runs/jobs/*/pid; do`,
      `  [ -f "$d" ] || continue`,
      `  pid=$(cat "$d" 2>/dev/null || true)`,
      `  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then n=$((n+1)); fi`,
      `done`,
      `echo $n`,
    ].join("\n"),
    { timeoutMs: 12_000 },
  )
  if (r.status !== 0) return local
  const n = Number((r.stdout || "").trim().split("\n").pop())
  return Number.isFinite(n) ? n : local
}

/**
 * Resolve a place name to a concrete SSH host.
 * Pools → pick reachable member with lowest live-job load that satisfies ask.
 */
export function resolveSshTarget(
  requested: string,
  ask: ResolveAsk = {},
): ResolvedSsh {
  const place = getPlace(requested)
  if (place.kind === "ssh") {
    if (ask.gpu != null && ask.gpu > 0) assertPlaceCanSatisfy(place, ask)
    return { requested, name: requested, place }
  }
  if (place.kind !== "pool") {
    throw tip(`place ${requested} is ${(place as { kind: string }).kind}`, "aq add ssh · aq add pool")
  }
  return pickPoolMember(requested, place, ask)
}

export function pickPoolMember(
  poolName: string,
  pool: PoolPlace,
  ask: ResolveAsk = {},
): ResolvedSsh {
  if (!pool.members.length) {
    throw tip(`pool ${poolName} has no members`, "aq add pool " + poolName)
  }
  const file = loadPlaces()
  type Cand = { name: string; place: SshPlace; load: number }
  const ok: Cand[] = []
  const skipped: string[] = []

  for (const m of pool.members) {
    const p = file.places[m]
    if (!p || p.kind !== "ssh") {
      skipped.push(m + " (missing)")
      continue
    }
    const check = sshCheck(p)
    if (!check.ok) {
      skipped.push(m + " (down)")
      continue
    }
    try {
      assertPlaceCanSatisfy(p, ask)
    } catch {
      skipped.push(m + " (resources)")
      continue
    }
    const load = memberLoad(m, p)
    ok.push({ name: m, place: p, load })
  }

  if (!ok.length) {
    const why = skipped.length ? skipped.join(", ") : "no members"
    throw tip(`pool ${poolName}: no free member`, why)
  }

  ok.sort((a, b) => a.load - b.load || a.name.localeCompare(b.name))
  const best = ok[0]
  return {
    requested: poolName,
    name: best.name,
    place: best.place,
    viaPool: poolName,
  }
}

export function describePick(r: ResolvedSsh): string {
  if (r.viaPool) return `${c.cyan(r.viaPool)} → ${c.cyan(r.name)}`
  return c.cyan(r.name)
}
