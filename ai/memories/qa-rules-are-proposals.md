---
name: qa-rules-are-proposals
description: a rule or default QA adds to the plan or editing.md is a proposal, marked not approved, until the owner approves it
metadata:
  type: feedback
---

A rule or default that QA writes into `qa/editor-matrix-test-plan.md` or `editing.md` is a proposal. Mark it "not approved" in both files, with the date QA wrote it. Never describe it as owner-approved, and never cite it in a ticket as the expected fix. A ticket cites the owner's rule it breaks (for example R99), and names the proposal only as a proposal that waits for the owner.

**Why:** on 2026-10-10 `editing.md` said every D rule was approved on 2026-10-08, but D25 and D27 were QA's own later additions, and ticket pg66fa4a told the implementer to build End to the unapproved D27. The owner called the claim "written poorly, and obviously incorrect".

**How to apply:** when adding a D rule or changing an expectation, state who decided it and when. Keep the legend in `editing.md` and the contract line in the plan accurate, in sync per [[docs-through-hub-only]].
