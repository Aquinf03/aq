/** aq serve --api — durable local REST until Ctrl-C (keeps one-shot serve). */

import { spawn } from "node:child_process"
import path from "node:path"
import { pythonBin } from "../core/python.js"
import { kernelRoot } from "../core/root.js"
import { assertTrain, isTrain } from "../core/schema.js"

function popFlag(argv: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === name) {
      value = argv[i + 1]
      i++
      continue
    }
    if (a.startsWith(name + "=")) {
      value = a.slice(name.length + 1)
      continue
    }
    rest.push(a)
  }
  return { value, rest }
}

export function wantsServeApi(argv: string[]): boolean {
  return argv.includes("--api") || argv.includes("--listen")
}

export async function serveApi(argv: string[]): Promise<void> {
  let args = argv.filter((a) => a !== "--api" && a !== "--listen")
  const portF = popFlag(args, "--port")
  args = portF.rest
  const hostF = popFlag(args, "--host")
  args = hostF.rest
  const ckF = popFlag(args, "--ckpt")
  args = ckF.rest
  // drop one-shot-only flags if present
  for (const name of ["--image", "--max-tokens", "--temperature"]) {
    const r = popFlag(args, name)
    args = r.rest
  }

  let train = "."
  if (args[0] && isTrain(args[0])) {
    train = args[0]
    args = args.slice(1)
  }
  assertTrain(train)

  const port = portF.value ? Number(portF.value) : 8765
  const host = hostF.value || "127.0.0.1"
  const ckpt = ckF.value || "last"

  const kernel = kernelRoot()
  const pkg = path.dirname(kernel)
  const child = spawn(
    pythonBin(),
    [
      "-m",
      "aquin.serve_api",
      "--train",
      path.resolve(train),
      "--ckpt",
      ckpt,
      "--host",
      host,
      "--port",
      String(port),
    ],
    {
      cwd: path.resolve(train),
      env: {
        ...process.env,
        PYTHONPATH: [pkg, kernel, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
      },
      stdio: "inherit",
    },
  )

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM" || code === 0 || code === null) resolve()
      else reject(new Error(`serve --api exited ${code}`))
    })
  })
}
