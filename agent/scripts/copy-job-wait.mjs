#!/usr/bin/env node
/** Cross-platform post-tsc step — copy job-wait beside dist/job. */
import { copyFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const destDir = path.join(root, "dist", "job")
mkdirSync(destDir, { recursive: true })
copyFileSync(path.join(root, "src", "job", "job-wait.mjs"), path.join(destDir, "job-wait.mjs"))
