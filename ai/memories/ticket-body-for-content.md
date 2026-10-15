---
name: ticket-body-for-content
description: a ticket's body holds its content (criteria, test plans, evidence); comments are only for discussion; closed tickets are left alone
metadata:
  type: feedback
---

Put a ticket's content in its body: acceptance criteria, test plans, failing cases, measurements, and expected behavior. Use comments only for discussion about that content, such as a question for the owner or a reply. Leave closed tickets alone. A closed ticket found still broken is not reopened: the breakage goes in a new ticket.

**Why:** on 2026-10-10 QA had put acceptance criteria on four tickets as many anchored comments. The owner had them moved into the bodies: the body holds the content, and comments are for discussion about it. The move also rewrote dnvagjc6, a closed ticket, and the owner said to leave closed tickets alone. Later the owner ruled that breakage found in a closed ticket is a new ticket, not a reopen.

**How to apply:** when filing or extending a ticket, write the content into the body with a targeted `edit` diff ([[targeted-hub-edits]]). Comment only to ask or to answer. Check a ticket's state in its own step, read the result, and only then write to it. Twice on 2026-10-10 a state check and a write ran in one command, so a closed ticket (8e4ybvc2, then xj3zqv5t) was written to before the check could stop it. [[anchor-review-comments]] still holds for reviewing documents that are not tickets. Related: [[do-not-cut-down-instructions]].
