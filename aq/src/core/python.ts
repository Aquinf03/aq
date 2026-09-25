import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import path from "node:path"
import { assertTrain, isTrain } from "./schema.js"
import { artifactsDir } from "./paths.js"
import { openRun } from "./run.js"
import { kernelRoot } from "./root.js"

const kernelDir = kernelRoot()
const runPy = path.join(kernelDir, "run.py")

export class InterruptedError extends Error {
  readonly exitCode = 130
  constructor(message = "interrupted") {
    super(message)
    this.name = "InterruptedError"
  }
}

export function pythonBin(): string {
  const root = kernelRoot()
  for (const rel of [
    path.join(".venv", "bin", "python"),
    path.join(".venv", "bin", "python3"),
    path.join(".venv", "Scripts", "python.exe"),
    path.join(".venv", "Scripts", "python"),
  ]) {
    const candidate = path.join(root, rel)
    if (existsSync(candidate)) return candidate
  }
  const probes: { bin: string; args: string[] }[] = [
    { bin: "python3", args: ["-c", "import sys; print(sys.executable)"] },
    { bin: "py", args: ["-3", "-c", "import sys; print(sys.executable)"] },
    { bin: "python", args: ["-c", "import sys; print(sys.executable)"] },
  ]
  for (const p of probes) {
    const r = spawnSync(p.bin, p.args, { encoding: "utf8", timeout: 3000 })
    const out = (r.stdout || "").trim()
    if (r.status === 0 && out && existsSync(out)) return out
    if (r.status === 0 && out) return out
  }
  throw new Error("python3 not found (need python3, py -3, or aq/kernel/.venv)")
}

export type KernelReq = {
  op: string
  snapshot?: boolean
  ckpt?: string
  keep?: string
  probe?: string
  prompt?: string
  image?: string
  max_tokens?: number
  temperature?: number
  kind?: string
  format?: string
  dpi?: number
  out?: string
  out_file?: string
  capture_code?: boolean
  /** lock | full | true — see protocol/capture.py */
  capture_env?: boolean | string
  /** sample CPU/GPU/mem/disk/net into metrics + TUI */
  capture_system?: boolean
  /** sample grad/param norms during train */
  capture_grads?: boolean
  // plot options (CLI / SDK → kernel plot config)
  charts?: string[]
  title?: string
  fields?: string[]
  x?: string
  style?: string
  figsize?: string | number[]
  show_lr?: boolean
  metric_charts?: string[]
  max?: number
  thumb?: number
  nrow?: number
  from?: string | string[]
  backend?: string
  no_samples?: boolean
  include_samples?: boolean
  metrics?: Record<string, unknown>
  samples?: Record<string, unknown>
  jobs?: Record<string, unknown>
  runs?: Record<string, unknown>
  plot?: Record<string, unknown>
}

/** Kill the kernel and any Trainer / dataloader workers in one shot. */
function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    // Negative pid = process group (kernel was spawned detached).
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

function waitChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

/**
 * Run the Python kernel. The child is its own process group so Ctrl+C hits
 * Node only — we then SIGKILL the whole tree. Avoids HF Trainer's
 * "first SIGINT = soft stop, second = exit" dance.
 */
export async function runKernel(train: string, req: KernelReq): Promise<void> {
  const art = artifactsDir(train)
  mkdirSync(art, { recursive: true })
  writeFileSync(path.join(art, "request.json"), JSON.stringify(req, null, 2) + "\n")

  const child = spawn(pythonBin(), [runPy, train], {
    cwd: kernelDir,
    stdio: ["ignore", "inherit", "inherit"],
    // Own process group on Unix: terminal SIGINT goes to Node, not HF Trainer.
    detached: process.platform !== "win32",
    env: process.env,
  })

  let interrupted = false
  const onInterrupt = () => {
    if (interrupted) return
    interrupted = true
    process.stderr.write("\ninterrupted\n")
    if (child.pid != null) killProcessTree(child.pid, "SIGKILL")
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)

  try {
    await waitChild(child)
    if (interrupted) throw new InterruptedError()

    const resultPath = path.join(art, "result.json")
    let result: { ok?: boolean; lines?: string[]; error?: string }
    try {
      result = JSON.parse(readFileSync(resultPath, "utf8"))
    } catch {
      throw new Error("kernel failed")
    }
    if (!result.ok) {
      throw new Error(result.error || "kernel failed")
    }
    const lines = result.lines ?? []
    process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""))
  } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onInterrupt)
  }
}

function popFlag(rest: string[], flag: string): { value?: string; rest: string[] } {
  const idx = rest.indexOf(flag)
  if (idx < 0) return { rest }
  const value = rest[idx + 1]
  if (value === undefined) throw new Error(`usage: missing value after ${flag}`)
  return {
    value,
    rest: rest.filter((_, i) => i !== idx && i !== idx + 1),
  }
}

export async function kernelStep(step: string, argv: string[]): Promise<string> {
  let rest = argv
  let captureCode = false
  let captureEnv: string | boolean | undefined
  let captureSystem: boolean | undefined
  let captureGrads: boolean | undefined
  const nextRest: string[] = []
  for (const a of rest) {
    if (a === "--capture-code" || a === "--capture=code") {
      captureCode = true
      continue
    }
    if (a === "--no-capture-code") {
      captureCode = false
      continue
    }
    if (a === "--capture-env" || a === "--capture-env=lock" || a === "--capture=env") {
      captureEnv = "lock"
      continue
    }
    if (a === "--capture-env=full" || a === "--capture-env-full") {
      captureEnv = "full"
      continue
    }
    if (a.startsWith("--capture-env=")) {
      captureEnv = a.slice("--capture-env=".length) || "lock"
      continue
    }
    if (a === "--no-capture-env") {
      captureEnv = false
      continue
    }
    if (a === "--system" || a === "--capture-system" || a === "--capture=system") {
      captureSystem = true
      continue
    }
    if (a === "--no-system" || a === "--no-capture-system") {
      captureSystem = false
      continue
    }
    if (
      a === "--grads" ||
      a === "--gradients" ||
      a === "--capture-grads" ||
      a === "--capture=grads"
    ) {
      captureGrads = true
      continue
    }
    if (a === "--no-grads" || a === "--no-capture-grads") {
      captureGrads = false
      continue
    }
    nextRest.push(a)
  }
  rest = nextRest
  const ck = popFlag(rest, "--ckpt")
  rest = ck.rest
  const keep = popFlag(rest, "--keep")
  rest = keep.rest
  const mt = popFlag(rest, "--max-tokens")
  rest = mt.rest
  const temp = popFlag(rest, "--temperature")
  rest = temp.rest
  const image = popFlag(rest, "--image")
  rest = image.rest

  let train: string
  let probe: string | undefined
  let prompt: string | undefined
  if (step === "eval" && rest.length === 2) {
    train = assertTrain(rest[0])
    probe = rest[1]
  } else if (step === "eval" && rest.length === 1 && !isTrain(path.resolve(rest[0]))) {
    train = assertTrain(".")
    probe = rest[0]
  } else if (step === "serve") {
    if (rest.length === 2) {
      train = assertTrain(rest[0])
      prompt = rest[1]
    } else if (rest.length === 1 && !isTrain(path.resolve(rest[0]))) {
      train = assertTrain(".")
      prompt = rest[0]
    } else if (rest.length === 1) {
      train = assertTrain(rest[0])
    } else if (rest.length === 0) {
      train = assertTrain(".")
    } else {
      throw new Error(
        "usage: aq serve [dir] [prompt] [--image path] [--ckpt name] [--max-tokens n] [--temperature t]",
      )
    }
  } else if (rest.length > 1) {
    throw new Error(`usage: aq ${step} [dir]`)
  } else {
    train = assertTrain(rest[0] ?? ".")
  }
  const req: KernelReq = { op: step }
  if (ck.value) req.ckpt = ck.value
  if (keep.value) req.keep = keep.value
  if (probe) req.probe = probe
  if (prompt) req.prompt = prompt
  if (image.value) req.image = image.value
  if (mt.value !== undefined) req.max_tokens = Number(mt.value)
  if (temp.value !== undefined) req.temperature = Number(temp.value)
  if (captureCode) req.capture_code = true
  if (captureEnv !== undefined && captureEnv !== false) req.capture_env = captureEnv
  if (captureSystem === true) req.capture_system = true
  if (captureSystem === false) req.capture_system = false
  if (captureGrads === true) req.capture_grads = true
  if (captureGrads === false) req.capture_grads = false
  const root = openRun(train).root
  await runKernel(root, req)
  return root
}
