---
title: AI Crawler Access & LLMs.txt
description: Machine-readable documentation endpoints, .md URL extensions, and llms.txt integration.
---

# AI Crawler Access & LLMs.txt

Cloud Harness MCP documentation is built from the ground up for both human operators and autonomous AI agents.

## 1. Raw Markdown at `.md` URLs

Every page on this site is mirrored as a clean, static Markdown file with frontmatter stripped. AI web scrapers and agents can directly fetch:

```text
https://docs.harness.agentkit.best/<page-path>.md
```

**Examples:**
- `https://docs.harness.agentkit.best/getting-started.md`
- `https://docs.harness.agentkit.best/how-it-works.md`
- `https://docs.harness.agentkit.best/reference/tools.md`
- `https://docs.harness.agentkit.best/reference/environment-variables.md`

Cloudflare Pages serves these paths with `Content-Type: text/markdown; charset=utf-8` and CORS enabled (`Access-Control-Allow-Origin: *`).

---

## 2. Standard `llms.txt`

The site exposes a standard [llms.txt](https://llmstxt.org/) index at the root:

```text
https://docs.harness.agentkit.best/llms.txt
```

---

## 3. Full Documentation Stream: `llms-full.txt`

For ingestion into context windows or retrieval databases in a single HTTP request:

```text
https://docs.harness.agentkit.best/llms-full.txt
```
