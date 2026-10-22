---
title: Maintain the docs
description: Keep human and LLM documentation together and build the static Astro site.
---

## Maintain one source

Edit Markdown or MDX under `packages/docs/src/content/docs/`. Every page needs a frontmatter `title` and `description`. Add new pages to the sidebar in `packages/docs/astro.config.mjs`. Update the relevant guide in the same change as the behavior it describes.

Prefer self-contained instructions, explicit prerequisites, complete commands, and expected results. Label placeholders such as `<run-id>` and explain where to get their values. Distinguish shipped behavior from planned features. Keep essential explanations in prose and code blocks so they remain useful without interactive components.

The repository's `docs/` directory holds design notes and deeper engineering references. The pages in this site are the maintained user-facing guides.

## Preview and verify

From the repository root:

```sh
bun install --frozen-lockfile
bun run docs:dev
```

Open `http://127.0.0.1:4321`. Before merging documentation changes, run:

```sh
bun run docs:typecheck
bun run docs:build
bun run docs:preview
```

The preview serves the production build, including search and generated text files. `bun run verify` also includes the documentation checks alongside the runtime checks.

## LLM-friendly documentation

[starlight-llms-txt](https://delucis.github.io/starlight-llms-txt/getting-started/) generates three routes from the same documentation collection:

- [`/llms.txt`](/llms.txt): the entry point linking to the documentation sets.
- [`/llms-full.txt`](/llms-full.txt): the complete documentation as text, including code examples.
- [`/llms-small.txt`](/llms-small.txt): an abridged version for smaller context windows.

The overview and getting-started pages come first. Every HTML page advertises `/llms.txt` with a discovery link. These files are generated during the build; do not maintain separate copies. Inspect them in the production preview after changing Markdown, MDX, or rendering components. An assistant can fetch these URLs explicitly; the files do not guarantee automatic crawler discovery.

## Canonical URLs

`DOCS_SITE_URL` sets the canonical links, the sitemap URLs, and the absolute links in the LLM files for a static build. When it is unset, the build uses `http://127.0.0.1:4321`. For a production-equivalent build, export the public origin before building:

```sh
DOCS_SITE_URL=https://docs.example.com bun run docs:build
```
