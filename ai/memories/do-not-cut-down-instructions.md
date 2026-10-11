---
name: do-not-cut-down-instructions
description: carry out what the owner says in full; never narrow, trim, or simplify an instruction or text that was given
metadata:
  type: feedback
---

When the owner says what to do, or hands over text to use, apply all of it. Do not narrow it to the part that seems to fit, and do not shorten text that is moved. QA's own text moves word for word. The owner's words are never quoted ([[no-operator-quotes]]), so every point in them is carried over in QA's words. A check against the source confirms nothing was dropped.

**Why:** on 2026-10-10 the owner answered that the image `attach` command should use the same targeting as comments, and QA wrote only `--start LINE:OFFSET` into the test plan, dropping `--end` and the `--expect` safety check. The owner said that cutting down text QA is given is a failure.

**How to apply:** when an answer says to do it the same as X, copy X's whole form, including its checks and refusals. When text moves from comments to a body, or between documents, compare every piece against the source afterwards. Where a part does not seem to fit, keep it and say why it might not, rather than dropping it. Related: [[qa-rules-are-proposals]].
