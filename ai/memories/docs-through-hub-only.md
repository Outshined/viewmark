---
name: docs-through-hub-only
description: "Every document (plans, reports, notes) is created, read, and edited only through the viewmark hub CLI; never the filesystem, never inspect hub storage"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 930feb28-bde9-42f8-9fab-99eb691cb3f8
  modified: 2026-10-09T00:59:47.114Z
---

All documents go through the hub — `node cli.js --user claude --repo <repo> create|show|edit|list ...` — and nowhere else. For this project the repo is `viewmark`, and QA plans and run reports go under `qa/` in it (e.g. `qa/editor-matrix-test-plan.md`). Never write a doc with Write/Edit into the source tree, and never look at where the hub stores files (repo paths, `docs/`, `state/`) — the user said that is none of my business.

**Why:** the user reviews and annotates docs with comments in the Viewmark page; a file on disk outside the hub is invisible to that workflow. Writing the editor-matrix plan to the source tree's `qa/` and then poking at `docs/` drew a sharp correction (2026-10-08).

**How to apply:** draft in the scratchpad if needed, then `create` (or `edit` with a unified diff) through the hub and `show` it back to confirm. Read docs only with `show`. Run reports from live test runs also go to the hub `qa/`.
