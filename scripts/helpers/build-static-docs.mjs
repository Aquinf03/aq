#!/usr/bin/env node
/**
 * Generate static HTML docs under docs/ for GitHub Pages.
 * Source of truth: web/lib/docs/sections + getting-started / train extras.
 *
 *   node --experimental-strip-types scripts/helpers/build-static-docs.mjs
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const outDir = path.join(root, "docs")
const webLib = path.join(root, "web", "lib", "docs")

async function load(rel) {
  const file = path.join(webLib, rel)
  return import(pathToFileURL(file).href)
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function commandAnchor(command) {
  return command
    .toLowerCase()
    .replace(/^curl .*\| bash/, "curl-install")
    .replace(/^pip install /, "pip-install-")
    .replace(/^aq /, "aq-")
    .replace(/^aquin /, "aquin-")
    .replace(/[<>]/g, "")
    .replace(/\|/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

function detectLanguage(code) {
  const trimmed = code.trim()
  if (/^\s*[[{]/.test(trimmed) && /[:{}[\]]/.test(trimmed) && !/^family:|^method:|^data:/m.test(trimmed)) {
    return "json"
  }
  if (/^(family|method|model|data|eval|guard|objective|rank|alpha|steps|lr|arch):/m.test(trimmed)) {
    return "yaml"
  }
  if (/^(aq |curl |pip |cd |npm |npx |python |export |git |sudo |source |# |\.\/)/m.test(trimmed)) {
    return "bash"
  }
  if (/\b(def |import |class |print\(|lambda )\b/.test(trimmed)) return "python"
  if (/my-train\/|artifacts\/|instructions\.md|recipe\.yaml/.test(trimmed)) return "text"
  return "bash"
}

function codeBlock(code, label) {
  const text = code.replace(/^\n+|\n+$/g, "")
  const lang = detectLanguage(text)
  const isShell = lang === "bash"
  const lines = text.split("\n").map((line) => {
    const trimmed = line.trimStart()
    const prompt = isShell && trimmed && !trimmed.startsWith("#")
    const isComment = !prompt && trimmed.startsWith("#")
    return { prompt, isComment, text: line }
  })
  const body = lines
    .map((line) => {
      const prompt = isShell
        ? `<span class="prompt">${line.prompt ? "$" : " "}</span>`
        : ""
      const cls = line.isComment ? ' class="comment"' : ""
      return `<span class="line">${prompt}<span${cls}>${escapeHtml(line.text) || " "}</span></span>`
    })
    .join("\n")
  return `<div class="codeblock" data-shell="${isShell ? "1" : "0"}">
  <div class="codeblock-bar">
    <span>${escapeHtml(label ?? (isShell ? "shell" : lang))}</span>
    <button type="button" class="copy-btn">Copy</button>
  </div>
  <pre><code>${body}</code></pre>
</div>`
}

function flagTable(flags) {
  if (!flags?.length) return ""
  const rows = flags
    .map(
      (f) => `<tr>
  <td class="flag">${escapeHtml(f.name)}${f.required ? '<span class="req">*</span>' : ""}</td>
  <td>${escapeHtml(f.description)}</td>
</tr>`,
    )
    .join("\n")
  return `<div class="table-wrap mb">
  <table>
    <thead><tr><th>Flag</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
}

function toolBlock(tool) {
  const examples = Array.isArray(tool.example)
    ? tool.example
    : tool.example
      ? [tool.example]
      : []
  return `<section class="tool" id="${commandAnchor(tool.command)}">
  <h3 class="tool-cmd">${escapeHtml(tool.command)}</h3>
  ${tool.agentTool ? `<p class="agent-tool">agent tool: <span>${escapeHtml(tool.agentTool)}</span></p>` : ""}
  <p class="tool-desc">${escapeHtml(tool.description)}</p>
  ${flagTable(tool.flags)}
  ${examples.map((ex) => codeBlock(ex, "example")).join("\n")}
  ${tool.notes ? `<p class="notes">${escapeHtml(tool.notes)}</p>` : ""}
</section>`
}

function sectionPage(section, footerHtml = "") {
  return `<h1>${escapeHtml(section.title)}</h1>
<p class="lead">${escapeHtml(section.intro)}</p>
${
  section.prerequisite
    ? `<div class="prereq"><span class="prereq-label">Prerequisite</span>${escapeHtml(section.prerequisite)}</div>`
    : ""
}
${section.tools.map(toolBlock).join("\n")}
${footerHtml}`
}

/** Map web path → static page id ('' = index). */
const NAV = [
  { label: "Live docs", href: "https://aq.aquin.app/docs", external: true },
  { label: "Getting started", id: "" },
  { label: "Install", id: "install" },
  { label: "Train folder", id: "train" },
  { label: "Recipe", id: "recipe" },
  { label: "CLI reference", id: "cli" },
  {
    label: "Methods",
    children: [
      { label: "Tabular", id: "methods/tabular" },
      { label: "Transformers", id: "methods/transformers" },
      { label: "LLM / LoRA", id: "methods/llm" },
      { label: "Custom", id: "methods/custom" },
    ],
  },
  { label: "Eval & inspect", id: "eval" },
  { label: "Metrics & guard", id: "metrics" },
  { label: "Jobs", id: "jobs" },
  { label: "Agent", id: "agent" },
  { label: "Skills, tools & MCP", id: "skills" },
  { label: "Plans", id: "schedules" },
]

function pageDepth(id) {
  if (!id) return 0
  return id.split("/").length
}

function assetPrefix(depth) {
  return depth === 0 ? "assets/" : "../".repeat(depth) + "assets/"
}

function linkTo(fromId, toId) {
  if (toId == null) return "#"
  const fromDepth = pageDepth(fromId)
  if (toId === "") {
    return fromDepth === 0 ? "./" : "../".repeat(fromDepth)
  }
  if (fromDepth === 0) return `${toId}/`
  // climb to docs root then into target
  return "../".repeat(fromDepth) + `${toId}/`
}

function renderNav(activeId) {
  const parts = []
  for (const item of NAV) {
    if (item.children) {
      const childActive = item.children.some((c) => c.id === activeId)
      parts.push(`<p class="nav-section${childActive ? " active" : ""}">${escapeHtml(item.label)}</p>`)
      for (const child of item.children) {
        const active = child.id === activeId
        parts.push(
          `<a class="nav-link nested${active ? " active" : ""}" href="${linkTo(activeId, child.id)}">${escapeHtml(child.label)}</a>`,
        )
      }
      continue
    }
    if (item.external) {
      parts.push(
        `<a class="nav-link" href="${escapeHtml(item.href)}" rel="noopener">${escapeHtml(item.label)}</a>`,
      )
      continue
    }
    const active = item.id === activeId
    parts.push(
      `<a class="nav-link${active ? " active" : ""}" href="${linkTo(activeId, item.id)}">${escapeHtml(item.label)}</a>`,
    )
  }
  return parts.join("\n")
}

function pageShell({ id, title, description, body }) {
  const depth = pageDepth(id)
  const assets = assetPrefix(depth)
  const home = linkTo(id, "")
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · aq Docs</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="icon" href="${assets}favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${assets}docs.css" />
</head>
<body>
  <header class="docs-header">
    <div class="docs-header-inner">
      <a class="brand" href="${home}" title="Aquin Labs">
        <img src="${assets}mainlogo2.png" alt="" width="22" height="22" />
        <span>Aquin<span class="brand-gap">Labs</span></span>
      </a>
      <div class="header-actions">
        <a class="header-link" href="https://aquin.app/changelog" rel="noopener">Changelog</a>
        <a class="header-cta" href="https://aq.aquin.app/" rel="noopener">Sign in</a>
      </div>
    </div>
  </header>
  <div class="docs-frame">
    <aside class="docs-sidebar" aria-label="Documentation">
      <nav>${renderNav(id)}</nav>
    </aside>
    <main class="docs-main">${body}</main>
  </div>
  <script src="${assets}docs.js"></script>
</body>
</html>
`
}

function chip(code) {
  return `<code class="chip">${escapeHtml(code)}</code>`
}

function gettingStartedHtml() {
  const pieces = [
    ["Aquin", "The product: developer environment and framework."],
    ["aq", "The CLI you type (TypeScript). Quiet, cwd-based, like git."],
    ["Kernel", "Python under aq/kernel/. Fit, eval, serve, hash. Talks to the CLI through files."],
    ["Train", "A directory with instructions.md + recipe.yaml. The real unit of work."],
    ["Agent", "Lives inside that Unix: same cwd, same files, same verbs. Not a side chat."],
  ]
  const next = [
    ["install", "Install", "curl release or checkout link, doctor, login, providers"],
    ["train", "Train folder", "slots, artifacts, checkout"],
    ["recipe", "Recipe", "tabular, transformers, LLM, guard"],
    ["cli", "CLI", "every verb"],
    ["jobs", "Jobs", "detached work with resource asks"],
  ]
  return `<article>
  <h1 class="hero">Getting started</h1>
  <p class="lead">Aquin is a <strong>developer environment and framework</strong> for building and checking models. The unit of work is a directory. You grow that folder, run ${chip("aq")} against it, and keep enough on disk that you (or someone else) can fork, resume, and audit what happened. Disk is the source of truth. The UI is a view. The Unix is the product.</p>

  <h2>How the pieces fit</h2>
  <div class="table-wrap mb">
    <table class="plain">
      <thead><tr><th>Name</th><th>What it is</th></tr></thead>
      <tbody>
        ${pieces.map(([n, w]) => `<tr><td class="mono">${escapeHtml(n)}</td><td>${escapeHtml(w)}</td></tr>`).join("\n")}
      </tbody>
    </table>
  </div>
  <p class="lead">Flow is always the same shape: you work in a train folder, the CLI routes verbs, the kernel does the numeric work, artifacts land back on disk. Accounts and docs live at ${chip("aq.aquin.app")}. Auth is identity and tokens only — it does not own trains. <a href="https://aq.aquin.app/">Sign in</a>.</p>

  <h2>The directory system</h2>
  <p class="lead">A <strong>train</strong> is any folder with both ${chip("instructions.md")} (what this is for) and ${chip("recipe.yaml")} (the full train API for built-ins). ${chip("aq init")} scaffolds the rest. Convention over registration: drop a file in the right slot and it exists. No central registry.</p>
  __TRAIN_LAYOUT__
  <p class="lead">${chip("data/")} and ${chip("evals/")} are yours. ${chip("methods/")}, ${chip("tools/")}, ${chip("skills/")}, ${chip("schedules/")}, and ${chip("stages/")} extend the train locally. ${chip("jobs/")} and ${chip("artifacts/")} are system-owned. Forking copies the science and skips runtime state so a variant starts clean. Full layout: <a href="${linkTo("", "train")}">Train folder</a>.</p>

  <h2>CLI</h2>
  <p class="lead">${chip("aq")} is the face. Cwd is the workspace. Help is short. Verbs do one thing and compose: ${chip("aq train")} fits, ${chip("aq eval")} scores, ${chip("aq serve")} generates, ${chip("aq status")} / ${chip("aq diff")} read history, ${chip("aq job run")} files long work with resource asks, ${chip("aq spawn agent")} runs a worker.</p>
  <p class="lead">On a TTY, bare ${chip("aq")} opens the agent. Without a TTY it prints help. Account tokens live under ${chip("~/.aquin")}; provider keys for the agent under ${chip("~/.aq")}. Reference: <a href="${linkTo("", "cli")}">CLI</a>.</p>

  <h2>Kernel (Python)</h2>
  <p class="lead">The kernel is the programmatic engine. TypeScript and Python do not share memory. They talk through files:</p>
  <ol class="lead-list">
    <li>CLI writes ${chip("artifacts/request.json")}</li>
    <li>Spawns ${chip("kernel/run.py")} on the train path</li>
    <li>Kernel runs the op (${chip("hash")}, ${chip("train")}, ${chip("eval")}, ${chip("checkpoint")}, ${chip("serve")})</li>
    <li>Writes ${chip("artifacts/result.json")} and appends ${chip("metrics.jsonl")}; live steps stream on stderr</li>
  </ol>
  <p class="lead">For built-ins you do not write Python. ${chip("recipe.yaml")} is the API. Custom fits go in ${chip("methods/<name>.py")} with ${chip("fit(src, rec)")}. See <a href="${linkTo("", "recipe")}">Recipe</a> and <a href="${linkTo("", "methods/tabular")}">Methods</a>.</p>

  <h2>Agent</h2>
  <p class="lead">The agent is not a chat toy with a private filesystem. It is a resident of the train: same cwd, same ${chip("recipe.yaml")}, same tools. Humans own the eval gate. Surfaces: interactive ${chip("aq")} / ${chip("aq agent")}, one-shot ${chip("aq ask")}, resume via ${chip("aq chat")}, workers via ${chip("aq spawn")}. Details: <a href="${linkTo("", "agent")}">Agent</a> and <a href="${linkTo("", "skills")}">Skills, tools &amp; MCP</a>.</p>

  <h2>What “working” means</h2>
  <p class="lead">A stranger should be able to open a train, point the recipe at their data, set their gate, run train then eval, fail, inspect, edit one file, and run again. Long work files as ${chip("aq job run")}. There is no preset eval zoo. You write the probes.</p>

  <h2>Where to go next</h2>
  <ul class="next-list">
    ${next
      .map(
        ([id, label, blurb]) =>
          `<li><a href="${linkTo("", id)}">${escapeHtml(label)}</a><span class="dot"> · </span>${escapeHtml(blurb)}</li>`,
      )
      .join("\n")}
  </ul>
</article>`
}

async function main() {
  const install = await load("sections/install.ts")
  const train = await load("sections/train.ts")
  const recipe = await load("sections/recipe.ts")
  const cli = await load("sections/cli.ts")
  const agent = await load("sections/agent.ts")
  const methods = await load("sections/methods.ts")
  const ops = await load("sections/ops.ts")

  const pages = [
    {
      id: "",
      title: "Getting started with aq",
      description:
        "What Aquin is: developer environment and framework. Train folders, aq CLI, Python kernel, and the in-train agent.",
      body: gettingStartedHtml().replace(
        "__TRAIN_LAYOUT__",
        codeBlock(train.TRAIN_LAYOUT, "train folder"),
      ),
    },
    {
      id: "install",
      title: install.INSTALL.title,
      description: install.INSTALL.intro,
      body: sectionPage(install.INSTALL),
    },
    {
      id: "train",
      title: train.TRAIN_FOLDER.title,
      description: train.TRAIN_FOLDER.intro,
      body:
        sectionPage(train.TRAIN_FOLDER) +
        `<h2>Canonical layout after aq init</h2>
<p class="lead">aq init copies templates and creates optional slots with .keep files. A directory is a train when it has both instructions.md and recipe.yaml.</p>
${codeBlock(train.TRAIN_LAYOUT, "layout")}
<h2>What each slot is for</h2>
<div class="table-wrap mb">
  <table class="plain">
    <thead><tr><th>Slot</th><th>Who uses it</th><th>Notes</th></tr></thead>
    <tbody>
      ${train.TRAIN_SLOT_ROWS.map(
        (row) =>
          `<tr><td class="mono">${escapeHtml(row.slot)}</td><td>${escapeHtml(row.who)}</td><td>${escapeHtml(row.notes)}</td></tr>`,
      ).join("\n")}
    </tbody>
  </table>
</div>
<h2>Artifacts after real work</h2>
<p class="lead">Everything under artifacts/ is system-owned output. Forking skips jobs/ and artifacts/ so the child starts clean.</p>
${codeBlock(train.ARTIFACTS_LAYOUT, "artifacts")}
<h2>Mental tests</h2>
<ol class="lead-list">
  <li>Can I copy the folder to another machine and run aq status?</li>
  <li>Can I fork, change one recipe key, and compare with aq diff?</li>
  <li>Can a stranger read instructions.md and know the gate?</li>
  <li>If artifacts/ is deleted, can I retrain from recipe + data alone?</li>
</ol>`,
    },
    {
      id: "recipe",
      title: recipe.RECIPE.title,
      description: recipe.RECIPE.intro,
      body: sectionPage(recipe.RECIPE),
    },
    {
      id: "cli",
      title: cli.CLI.title,
      description: cli.CLI.intro,
      body: sectionPage(cli.CLI),
    },
    {
      id: "methods/tabular",
      title: methods.METHODS_TABULAR.title,
      description: methods.METHODS_TABULAR.intro,
      body: sectionPage(methods.METHODS_TABULAR),
    },
    {
      id: "methods/transformers",
      title: methods.METHODS_TRANSFORMERS.title,
      description: methods.METHODS_TRANSFORMERS.intro,
      body: sectionPage(methods.METHODS_TRANSFORMERS),
    },
    {
      id: "methods/llm",
      title: methods.METHODS_LLM.title,
      description: methods.METHODS_LLM.intro,
      body: sectionPage(methods.METHODS_LLM),
    },
    {
      id: "methods/custom",
      title: methods.METHODS_CUSTOM.title,
      description: methods.METHODS_CUSTOM.intro,
      body: sectionPage(methods.METHODS_CUSTOM),
    },
    {
      id: "eval",
      title: ops.EVAL_INSPECT.title,
      description: ops.EVAL_INSPECT.intro,
      body: sectionPage(ops.EVAL_INSPECT),
    },
    {
      id: "metrics",
      title: ops.METRICS_GUARD.title,
      description: ops.METRICS_GUARD.intro,
      body: sectionPage(ops.METRICS_GUARD),
    },
    {
      id: "jobs",
      title: ops.JOBS.title,
      description: ops.JOBS.intro,
      body: sectionPage(ops.JOBS),
    },
    {
      id: "agent",
      title: agent.AGENT.title,
      description: agent.AGENT.intro,
      body: sectionPage(agent.AGENT),
    },
    {
      id: "skills",
      title: ops.SKILLS_TOOLS.title,
      description: ops.SKILLS_TOOLS.intro,
      body: sectionPage(ops.SKILLS_TOOLS),
    },
    {
      id: "schedules",
      title: ops.SCHEDULES_STAGES.title,
      description: ops.SCHEDULES_STAGES.intro,
      body: sectionPage(ops.SCHEDULES_STAGES),
    },
  ]

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(path.join(outDir, "assets"), { recursive: true })

  // assets
  copyFileSync(
    path.join(root, "web", "public", "mainlogo2.png"),
    path.join(outDir, "assets", "mainlogo2.png"),
  )
  try {
    copyFileSync(
      path.join(root, "web", "public", "favicon.ico"),
      path.join(outDir, "assets", "favicon.ico"),
    )
  } catch {
    /* optional */
  }

  writeFileSync(path.join(outDir, "assets", "docs.css"), CSS)
  writeFileSync(path.join(outDir, "assets", "docs.js"), JS)
  writeFileSync(path.join(outDir, ".nojekyll"), "")
  writeFileSync(
    path.join(outDir, "README.md"),
    `# Static aq docs (GitHub Pages)

HTML mirror of the product docs. Same stone / \`#f5f5f3\` chrome as \`web/app/docs\`.

**Regenerate** (after editing \`web/lib/docs/sections\`):

\`\`\`bash
node --experimental-strip-types scripts/helpers/build-static-docs.mjs
\`\`\`

Point GitHub Pages at the \`/docs\` folder on your default branch.
`,
  )

  for (const page of pages) {
    const dir = page.id ? path.join(outDir, page.id) : outDir
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "index.html"),
      pageShell({
        id: page.id,
        title: page.title,
        description: page.description,
        body: page.body,
      }),
    )
  }

  console.log(`build-static-docs: ${pages.length} pages → ${outDir}`)
}

const CSS = `/* Mirror of aq.aquin.app docs chrome */
:root {
  --bg: #f5f5f3;
  --text: #1c1917;
  --muted: #57534e;
  --faint: #a8a29e;
  --border: #e7e5e4;
  --hover: #f5f5f4;
  --active: #f5f5f4;
  --header-h: 3.75rem;
  --chrome-top: calc(var(--header-h) + 2.5rem);
  --font: "Host Grotesk", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
::selection { background: #fde047; color: #000; }

a { color: #292524; text-underline-offset: 2px; }
a:hover { color: #0c0a09; }

.docs-header {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 50;
  height: var(--header-h);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 95%, transparent);
  backdrop-filter: blur(8px);
}
.docs-header-inner {
  max-width: 80rem;
  margin: 0 auto;
  height: 100%;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  text-decoration: none;
  color: var(--text);
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.04em;
}
.brand img { height: 22px; width: auto; display: block; }
.brand-gap { margin-left: 0.25ch; }
.header-actions { display: flex; align-items: center; gap: 0.75rem; }
.header-link {
  font-size: 13px;
  color: var(--muted);
  text-decoration: none;
}
.header-link:hover { color: var(--text); }
.header-cta {
  display: inline-flex;
  align-items: center;
  height: 2.25rem;
  padding: 0 0.875rem;
  border-radius: 0.5rem;
  background: #1c1917;
  color: #fff !important;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.header-cta:hover { background: #292524; }

.docs-frame {
  max-width: 80rem;
  margin: 0 auto;
  padding: var(--chrome-top) 1.5rem 6rem;
  display: grid;
  gap: 2.5rem;
}
@media (min-width: 1024px) {
  .docs-frame { grid-template-columns: 11.5rem minmax(0, 1fr); }
}
@media (min-width: 1280px) {
  .docs-frame { grid-template-columns: 11.5rem minmax(0, 48rem); }
}

.docs-sidebar {
  display: none;
  position: sticky;
  top: var(--chrome-top);
  align-self: start;
  max-height: calc(100vh - var(--chrome-top) - 2rem);
  overflow-y: auto;
  padding-bottom: 2rem;
  padding-right: 1rem;
  border-right: 1px solid var(--border);
}
@media (min-width: 1024px) { .docs-sidebar { display: block; } }

.nav-link {
  display: block;
  padding: 0.375rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 13px;
  line-height: 1.35;
  color: var(--muted);
  text-decoration: none;
}
.nav-link:hover { background: color-mix(in srgb, var(--hover) 80%, transparent); color: var(--text); }
.nav-link.active { background: var(--active); color: var(--text); font-weight: 500; }
.nav-link.nested { padding-left: 1.25rem; }
.nav-section {
  margin: 1.5rem 0 0.375rem;
  padding: 0 0.75rem;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}
.nav-section.active { color: #78716c; }

.docs-main { min-width: 0; }

h1 {
  margin: 0 0 0.75rem;
  font-size: 1.875rem;
  font-weight: 400;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
h1.hero {
  font-size: clamp(2.25rem, 5vw, 3rem);
  margin-bottom: 1rem;
}
h2 {
  margin: 2.5rem 0 0.75rem;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
h3.tool-cmd {
  margin: 0 0 0.5rem;
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
}

.lead {
  margin: 0 0 1rem;
  max-width: 42rem;
  font-size: 15px;
  line-height: 1.65;
  color: var(--muted);
}
.lead-list, .next-list {
  margin: 0 0 1rem;
  max-width: 42rem;
  padding-left: 1.25rem;
  font-size: 15px;
  line-height: 1.65;
  color: var(--muted);
}
.next-list { list-style: none; padding-left: 0; }
.next-list li { margin-bottom: 0.5rem; }
.next-list a { font-weight: 500; color: var(--text); }
.dot { color: var(--faint); }

.chip {
  font-family: var(--mono);
  font-size: 13px;
  background: color-mix(in srgb, #e7e5e4 60%, transparent);
  padding: 0.05rem 0.25rem;
  border-radius: 0.25rem;
}

.prereq {
  max-width: 42rem;
  margin: 0 0 2rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 13px;
  color: #78716c;
}
.prereq-label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.tool {
  margin-bottom: 2.5rem;
  padding-bottom: 2.5rem;
  border-bottom: 1px solid var(--border);
  scroll-margin-top: 7rem;
}
.tool:last-of-type { border-bottom: 0; }
.tool-desc {
  margin: 0 0 1rem;
  font-size: 14px;
  line-height: 1.65;
  color: var(--muted);
}
.agent-tool {
  margin: 0 0 0.75rem;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
}
.agent-tool span { color: #78716c; }
.notes {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 13px;
  line-height: 1.55;
  color: #78716c;
}

.table-wrap { overflow-x: auto; }
.table-wrap.mb { margin-bottom: 1rem; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
table.plain { font-size: 14px; }
thead tr { border-bottom: 1px solid #d6d3d1; }
tbody tr { border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent); }
th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  font-weight: 600;
  color: #292524;
}
td { padding: 0.625rem 0.75rem; vertical-align: top; color: var(--muted); line-height: 1.5; }
td.flag, td.mono, .mono {
  font-family: var(--mono);
  font-size: 11px;
  color: #292524;
  white-space: nowrap;
}
table.plain td.mono { font-size: 13px; }
.req { color: #ef4444; margin-left: 0.25rem; }
.table-wrap:not(:has(.plain)) {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.codeblock {
  margin-bottom: 1rem;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-family: var(--mono);
  font-size: 12px;
  color: #44403c;
  background: transparent;
}
.codeblock-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}
.copy-btn {
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: var(--faint);
  cursor: pointer;
  padding: 0.125rem 0.375rem;
  border-radius: 0.375rem;
}
.copy-btn:hover { color: #44403c; }
.codeblock pre {
  margin: 0;
  padding: 0.75rem;
  overflow-x: auto;
  line-height: 1.7;
}
.codeblock code { display: block; white-space: pre; }
.codeblock .line { display: flex; gap: 0.5rem; }
.codeblock .prompt {
  width: 0.75rem;
  flex-shrink: 0;
  user-select: none;
  color: var(--faint);
}
.codeblock .comment { color: var(--faint); }

@media (max-width: 1023px) {
  .docs-sidebar { display: none; }
}
`

const JS = `document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const block = btn.closest(".codeblock");
    const lines = [...block.querySelectorAll(".line")].map((line) => {
      const spans = [...line.querySelectorAll(":scope > span")];
      const textSpan = spans.length > 1 ? spans[1] : spans[0];
      return (textSpan?.textContent || "").replace(/\\u00a0/g, " ");
    });
    const text = lines.join("\\n").replace(/^\\n+|\\n+$/g, "");
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1400);
    } catch {}
  });
});
`

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
