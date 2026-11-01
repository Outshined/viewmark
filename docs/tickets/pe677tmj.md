title: Add a new ticket state
state: pending review
type: task
priority: medium
parent:
depends:
reporter: Operator
created: 2026-11-01T12:37:04.432Z

Given that some of the AIs are too retarded to allowthem to commit code without manual review, they'll do work and put a ticket into 'pending review'.  Once reviewed, I'd like a 'reviewed' state that I can put the ticket it.  The AI can then merge the code and close the ticket.

Checked on 2026-11-01. reviewed sits after pending review and before closed. The page select, ticket create, and ticket set accept it. Reviewed and review are rejected. A ticket in that state stays on the default list.