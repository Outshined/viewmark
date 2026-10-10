---
name: do-not-cut-down-instructions
description: carry out what the owner says in full; never narrow, trim, or simplify an instruction or text that was given
metadata:
  type: feedback
---

When the owner says what to do, or hands over text to use, apply all of it. Do not narrow it to the part that seems to fit, and do not shorten text that is moved or quoted. Moved text goes word for word, and a check confirms nothing was dropped.

**Why:** on 2026-10-10 the owner answered "use the same targeting as comments" for the image `attach` command, and QA wrote only `--start LINE:OFFSET` into the test plan, dropping `--end` and the `--expect` safety check. The owner said: "Do not 'cut down' text that you are given. That is a failure."

**How to apply:** when an answer says "the same as X", copy X's whole form, including its checks and refusals. When text moves from comments to a body, or between documents, compare every piece against the source afterwards. Where a part does not seem to fit, keep it and say why it might not, rather than dropping it. Related: [[qa-rules-are-proposals]].
