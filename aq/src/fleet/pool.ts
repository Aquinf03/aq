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
  const many = pickPoolMembers(poolName, pool, ask, 1)
  return many[0]
}

/** Pick N free members (lowest load first). Needs a pool with enough capacity. */
export function pickPoolMembers(
  poolName: string,
  pool: PoolPlace,
  ask: ResolveAsk = {},
  n: number,
): ResolvedSsh[] {
  if (n < 1) throw tip("nodes must be >= 1", "aq jobs run --nodes 2 --on <pool>")
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

  if (ok.length < n) {
    const why = skipped.length ? skipped.join(", ") : "not enough members"
    throw tip(
      `pool ${poolName}: need ${n} free, have ${ok.length}`,
      why + " · aq places · aq add ssh",
    )
  }

  ok.sort((a, b) => a.load - b.load || a.name.localeCompare(b.name))
  return ok.slice(0, n).map((c) => ({
    requested: poolName,
    name: c.name,
    place: c.place,
    viaPool: poolName,
  }))
}

/** Resolve --on + --nodes into one or more SSH targets. */
export function resolveSshTargets(
  requested: string,
  ask: ResolveAsk = {},
  nodes = 1,
): ResolvedSsh[] {
  if (nodes < 1) throw tip("nodes must be >= 1", "aq jobs run --nodes 2")
  const place = getPlace(requested)
  if (nodes === 1) return [resolveSshTarget(requested, ask)]
  if (place.kind !== "pool") {
    throw tip(
      `--nodes ${nodes} needs a pool (got ${place.kind} ${requested})`,
      "aq add pool gpus a b · aq jobs run --on gpus --nodes 2 -- …",
    )
  }
  return pickPoolMembers(requested, place, ask, nodes)
}

export function describePick(r: ResolvedSsh): string {
  if (r.viaPool) return `${c.cyan(r.viaPool)} → ${c.cyan(r.name)}`
  return c.cyan(r.name)
}

export function describeGang(rs: ResolvedSsh[]): string {
  if (rs.length <= 1) return describePick(rs[0])
  const pool = rs[0].viaPool || rs[0].requested
  return `${c.cyan(pool)} → ${rs.map((r) => c.cyan(r.name)).join(", ")} ${c.dim(`(${rs.length} nodes)`)}`
}
