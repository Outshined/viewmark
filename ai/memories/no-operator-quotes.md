---
name: no-operator-quotes
description: never quote the operator anywhere; state what the owner decided in QA's own words, dated and attributed, with every point kept
metadata:
  type: feedback
---

Never quote the operator: no quotation marks around the operator's words, and no verbatim sentences passed off as prose. This covers the plan, `editing.md`, ticket bodies, comment notes, commit messages, memory files, and messages to the operator. State what the owner decided in QA's own words, with the date and the ticket or thread, and keep every point the answer made ([[do-not-cut-down-instructions]]). Mark QA's reading as QA's ([[qa-rules-are-proposals]]).

**Why:** on 2026-10-11 QA put the owner's answer about End in quotation marks in the plan, `editing.md`, and ticket pg66fa4a, as it had done with earlier answers, and the operator forbade quoting an operator anywhere.

**How to apply:** when recording an answer, write the decision as a plain statement: "The owner decided on DATE (ticket X, cN) that ...". The operator's own comment notes stay as they are; they are the operator's text, not a quote. Closed tickets are left alone ([[ticket-body-for-content]]) unless the operator says otherwise; their old quotes are reported, not edited.
