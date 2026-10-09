---
name: memories-live-here
description: All memories for this project are stored in ai/memories/ in the repo, nowhere else
metadata:
  type: feedback
---

Store every memory as a file in `/home/paul/src/viewmark/ai/memories/`, with its pointer in `ai/memories/MEMORY.md`. Do not write memories to `~/.claude/projects/.../memory/` or anywhere else.

**Why:** the user said so directly (2026-10-08), right after a memory was written to the default `~/.claude` location.

**How to apply:** at the start of a session, read `ai/memories/MEMORY.md` and the files it points to. Write new or updated memories only here. Related: [[docs-through-hub-only]] — documents are a separate thing and go through the hub, not into this folder.
