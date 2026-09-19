#!/usr/bin/env node
/** Sync install.sh into Next public/ and write llms.txt. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.join(webRoot, "..")

mkdirSync(path.join(webRoot, "public", "framework"), { recursive: true })

const installSrc = path.join(repo, "install.sh")
if (existsSync(installSrc)) {
  copyFileSync(installSrc, path.join(webRoot, "public", "framework", "install.sh"))
} else {
  console.warn(`sync-framework-content: skip missing ${installSrc}`)
}

const site = (process.env.NEXT_PUBLIC_APP_URL || "https://aq.aquin.app").replace(/\/$/, "")
const llms = [
  "# Aquin / aq",
  "",
  "> Developer environment and framework for building and checking models.",
  "> Docs are HTML pages on this site (no separate markdown tree).",
  "",
  `Home: ${site}/`,
  `Getting started: ${site}/docs`,
  `Sitemap: ${site}/sitemap.xml`,
  `Changelog: https://aquinf03.github.io/aq/changelog`,
  "",
  "## Pages",
  "",
  `- ${site}/`,
  `- ${site}/docs`,
  `- ${site}/docs/install`,
  `- ${site}/docs/train`,
  `- ${site}/docs/recipe`,
  `- ${site}/docs/cli`,
  `- ${site}/docs/agent`,
  `- ${site}/docs/eval`,
  `- ${site}/docs/jobs`,
  `- https://aquinf03.github.io/aq/changelog`,
  "",
].join("\n")

writeFileSync(path.join(webRoot, "public", "llms.txt"), llms)

console.log("sync-framework-content: install.sh + llms.txt")
