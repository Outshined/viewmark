---
name: docs-hold-reader-material
description: hub docs hold only what other readers need (rules, how-tos, contracts); QA state tracking, findings, run records, build and pass status, decision history, and ticket lists stay out
metadata:
  type: feedback
---

A document in the hub holds only material that is useful to other readers: the rules, the contract, how to run and read the tests, and the questions that are still open. QA's state tracking stays out of it. That covers run records, findings logs, "built in", "fixed", and "passes at <commit>" notes, "today the page does X" notes, lists of the tickets behind a rule, decision dates and provenance ("the owner decided this on …, in ticket …"), and pointers to closed tickets. That material belongs on the ticket, in the test, or in the commit.

**Why:** on 2026-10-13 the owner asked QA to clean up its cruft (state tracking, findings, and the like) and keep only what other readers can use. QA removed two run records and a findings log, and stripped the tracking from `editing.md` and the plans.

**How to apply:** when a rule changes, change the rule text and its R or D id. Keep a short "not approved" mark or "QA's reading" on a proposal ([[qa-rules-are-proposals]]). Point to a ticket only for a question that is still open on an open ticket. Put a verification, a measurement, or a failing cell in a ticket, and file a ticket for a failure rather than noting it in a doc.

**Open questions stay:** a question to the owner that is not answered stays in the doc, even in a cleanup. QA's reading that an existing rule or default covers it is not an answer, and neither is filing a ticket that assumes one. On 2026-10-14 QA removed the open question on lines of only spaces between paragraphs, on its reading of D16, and filed `au8zeeem` on that reading. A side agent flagged it, and the owner then answered: the caret can stop on any line that is not only markdown structure the renderer consumes.
