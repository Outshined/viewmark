---
name: qa-rules-are-proposals
description: a rule or default QA adds to the plan or editing.md is a proposal, marked not approved, until the owner approves it; an owner answer is recorded for exactly what it says, never widened by inference
metadata:
  type: feedback
---

A rule or default that QA writes into `qa/editor-matrix-test-plan.md` or `editing.md` is a proposal. Mark it "not approved" in both files. The date and the ticket that record who decided what go in the ticket, not in the doc ([[docs-hold-reader-material]]). Never describe it as owner-approved, and never cite it in a ticket as the expected fix. A ticket cites the owner's rule it breaks (for example R99), and names the proposal only as a proposal that waits for the owner.

**Why:** on 2026-10-10 `editing.md` said every D rule was approved on 2026-10-08, but D25 and D27 were QA's own later additions, and ticket pg66fa4a told the implementer to build End to the unapproved D27. The owner called the claim poorly written and obviously incorrect.

**How to apply:** when adding a D rule or changing an expectation, say in the doc only whether it is approved, or which part is QA's reading. Record who decided it and when on the ticket. Keep the legend in `editing.md` and the contract line in the plan accurate, in sync per [[docs-through-hub-only]].

**Also:** record an owner's answer for exactly what it decides, in QA's own words, never as a quote ([[no-operator-quotes]]). Where the answer leaves a case open, keep the case open in both files and on the ticket, and keep the harness checking the owner's standing rule there. Never relax an invariant on the strength of QA's own reading. On 2026-10-10 the owner said End goes to the end of the current display line. QA wrote that a letter typed on a full line going to the next line was the owner's decision, and stopped I12 checking it (`1092f59`). A side agent flagged it, and the owner told QA to keep the other agent honest without waiting to be told. That covers QA's own work as much as the implementer's: call out an overreach on the ticket as soon as it is seen, whoever made it. Related: [[owner-decisions-stand]].
