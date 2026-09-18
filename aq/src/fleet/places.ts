/** Named compute places (~/.aquin/places.json) + last fleet session. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { Tags } from "./tags.js"

export type PlaceGpu = { kind: "nvidia" | "amd" | "mps" | "none"; count: number }

/** Probed once on `aq add` (refresh with `aq places --probe`). */
export type PlaceResources = {
  cpu: number
  ram: number
  disk: number
  gpu: PlaceGpu
  at: string
}

export type SshPlace = {
  kind: "ssh"
  host: string
  user?: string
  port?: number
  key?: string
  resources?: PlaceResources
  tags?: Tags
}

/** Named group of SSH places — pick a free member at launch/job time. */
export type PoolPlace = {
  kind: "pool"
  members: string[]
  tags?: Tags
}

export type Place = SshPlace | PoolPlace

export type PlacesFile = {
  places: Record<string, Place>
}

export type FleetSession = {
  place: string
  /** Concrete SSH member when `place` is a pool. */
  member?: string
  train: string
  remoteDir: string
  at: string
}

function aquinDir(): string {
  const d = path.join(homedir(), ".aquin")
  mkdirSync(d, { recursive: true })
  return d
}

export function placesPath(): string {
  return path.join(aquinDir(), "places.json")
}

export function sessionPath(): string {
  return path.join(aquinDir(), "fleet-session.json")
}

export function loadPlaces(): PlacesFile {
  const p = placesPath()
  if (!existsSync(p)) return { places: {} }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as PlacesFile
    if (!raw || typeof raw !== "object" || !raw.places || typeof raw.places !== "object") {
      return { places: {} }
    }
    return { places: raw.places }
  } catch {
    throw new Error(`bad places file: ${p}`)
  }
}

export function savePlaces(file: PlacesFile): void {
  writeFileSync(placesPath(), JSON.stringify(file, null, 2) + "\n", "utf8")
}

export function getPlace(name: string): Place {
  const file = loadPlaces()
  const place = file.places[name]
  if (!place) {
    const names = Object.keys(file.places)
    const hint = names.length ? `known: ${names.join(", ")}` : "none yet — aq add ssh"
    throw new Error(`unknown place: ${name} (${hint})`)
  }
  return place
}

export function upsertPlace(name: string, place: Place): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(`bad place name: ${name} (use letters, numbers, _-)`)
  }
  const file = loadPlaces()
  file.places[name] = place
  savePlaces(file)
}

export function setPlaceTags(name: string, tags: Tags): void {
  const p = getPlace(name)
  upsertPlace(name, { ...p, tags })
}

export function listPlaceNames(): string[] {
  return Object.keys(loadPlaces().places).sort()
}

export function listSshPlaceNames(): string[] {
  const file = loadPlaces()
  return Object.keys(file.places)
    .filter((n) => file.places[n].kind === "ssh")
    .sort()
}

/**
 * Resolve which place to use:
 * 1. explicit `--on` / name
 * 2. last fleet session (if still registered)
 * 3. the only registered place
 * Otherwise throw — caller should tip with `aq places · aq add ssh`.
 */
export function resolvePlaceName(onFlag?: string | null): string {
  const flag = (onFlag || "").trim()
  if (flag) return flag

  const names = listPlaceNames()
  const session = loadSession()
  if (session?.place && names.includes(session.place)) {
    return session.place
  }
  if (names.length === 1) return names[0]
  if (!names.length) {
    throw new Error("no places yet — aq add ssh")
  }
  throw new Error(`need --on <place> (known: ${names.join(", ")})`)
}

export function saveSession(session: FleetSession): void {
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2) + "\n", "utf8")
}

export function clearSession(): void {
  const p = sessionPath()
  if (existsSync(p)) unlinkSync(p)
}

export function loadSession(): FleetSession | null {
  const p = sessionPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FleetSession
  } catch {
    return null
  }
}

export function remoteTrainDir(trainLocal: string): string {
  const base = path.basename(path.resolve(trainLocal)) || "run"
  return `~/aq-runs/${base}`
}
