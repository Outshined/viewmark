---
name: owner-decisions-stand
description: an owner decision stands over any later edit by the implementer; restore it and report the deviation instead of asking the owner again
metadata:
  type: feedback
---

When the plan or `editing.md` is edited against something the owner already decided, the owner's decision stands. Restore it in both files, keep or retire the cells it calls for, and report the change that went against it, in the code or the docs, on the relevant ticket. Do not lay the settled question back before the owner as a choice between the decision and the deviation.

**Why:** on 2026-10-10 the owner had said that in formatted text there is no line between two paragraphs for the caret to land on. The implementer then edited the plan to say the blank line stays a line the caret can stop on, and restored the cells built on it. QA filed that as a question for the owner, listing both options. The owner said: "That's lame - I was clear about the behavior. There is no line to stop on, so by definition the caret cannot stop there. ... Clean up the mess."

**How to apply:** before asking the owner to choose, check whether the owner's own words already settle it, in `editing.md` threads, ticket comments, or the conversation. If they do, act on them. Ask only where the owner's words leave the point open. Related: [[qa-rules-are-proposals]], [[do-not-cut-down-instructions]].
