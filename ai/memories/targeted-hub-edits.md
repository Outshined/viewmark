---
name: targeted-hub-edits
description: every edit to a hub doc or ticket names only the text it changes; never a hunk that removes and re-adds existing text or rewrites a whole body
metadata:
  type: feedback
---

An edit to a hub document or ticket body is targeted. The hunk carries only what changes, with a few unchanged words beside it as context. Existing text is never removed and added back, and a body is never sent whole.

**Why:** on 2026-10-14 QA appended acceptance criteria to a ticket whose body was one paragraph with no final newline. The diff removed the owner's whole paragraph and added it back with the criteria after it, which the owner read as overwriting the body. The owner said to use targeted updates only, for all viewmark interactions.

**How to apply:**
- To add text after a line, make the last words of that line a ` ` context line and limit the slice to them with `--start` and `--end`. The added lines are `+` lines after it.
- To change a phrase, slice to the phrase or its sentence and replace only that.
- Diff against a fresh `show` or `ticket show`, taken after checking the ticket's state ([[ticket-body-for-content]]).
- Comments go through `comment add` and `comment reply` ([[anchor-review-comments]]), never through `edit`.
