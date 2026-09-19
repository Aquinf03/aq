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
const ghDocs = "https://aquinf03.github.io/aq/documentation"
const ghCl = "https://aquinf03.github.io/aq/changelog"
const llms = [
  "# Aquin / aq",
  "",
  "> Developer environment and framework for building and checking models.",
  "",
  `Home: ${site}/`,
  `Docs: ${ghDocs}/`,
  `Sitemap: ${site}/sitemap.xml`,
  `Changelog: ${ghCl}/`,
  "",
  "## Pages",
  "",
  `- ${site}/`,
  `- ${ghDocs}/`,
  `- ${ghDocs}/install/`,
  `- ${ghDocs}/train/`,
  `- ${ghDocs}/recipe/`,
  `- ${ghDocs}/cli/`,
  `- ${ghDocs}/agent/`,
  `- ${ghDocs}/eval/`,
  `- ${ghDocs}/jobs/`,
  `- ${ghDocs}/fleet/`,
  `- ${ghCl}/`,
  "",
].join("\n")

writeFileSync(path.join(webRoot, "public", "llms.txt"), llms)

console.log("sync-framework-content: install.sh + llms.txt")
