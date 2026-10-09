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

**How to apply:**
- Draft in the scratchpad if needed, then `create` (or `edit` with a unified diff) through the hub, and `show` it back to confirm.
- Read docs only with `show`.
- Run reports from live test runs also go to the hub `qa/`.
- The hub copy is authoritative. Code that needs a doc fetches it from the hub at run time; the browser tests read their cells from the plan with `show`, in `browser/cells.js`.
- Never keep a copy, extract, or derived data file of a doc in the source tree. A one-time `cells.txt` extract was rejected, because it would silently drift from the plan the user keeps revising.
- The user may hold a lock on a span in the page. An `edit` can then 409 with "held by Operator". Use small hunks to stay off the held span, and never force it. Use `diff -U 1`, not `-U 0`: a hunk that only inserts lines needs a context line, or the hub rejects it with "hunk has no context".
