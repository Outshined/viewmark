---
name: ticket-body-for-content
description: a ticket's body holds its content (criteria, test plans, evidence); comments are only for discussion; closed tickets are left alone
metadata:
  type: feedback
---

Put a ticket's content in its body: acceptance criteria, test plans, failing cases, measurements, and expected behavior. Use comments only for discussion about that content, such as a question for the owner or a reply. Leave closed tickets alone. The one exception is the standing check of closed tickets: a closed ticket found still broken is reopened, with a comment saying where the breakage is.

**Why:** on 2026-10-10 QA had put acceptance criteria on four tickets as many anchored comments. The owner had them moved into the bodies and said: "Use the ticket body for content, comments are for discussion about the content." The move also rewrote dnvagjc6, a closed ticket, and the owner said: "Leave closed tickets alone."

**How to apply:** when filing or extending a ticket, write the content into the body with an `edit` diff. Comment only to ask or to answer. Check a ticket's state before touching it. [[anchor-review-comments]] still holds for reviewing documents that are not tickets. Related: [[do-not-cut-down-instructions]].
