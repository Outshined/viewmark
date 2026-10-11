---
name: anchor-review-comments
description: When reviewing a hub doc, put each point in its own comment anchored on the text it is about, not one long reply in a single thread
metadata:
  type: feedback
---

When reviewing a document in the hub, give each point its own thread. Anchor it with `comment add --start --end --expect` on the sentence or line it is about, such as a step's rule or its Tickets or Proof line. Reply in the requester's thread only with a short verdict that names the anchored thread ids.

**Why:** on 2026-10-09 a review of a six-step strategy went into one long reply in the thread that asked for it. The user asked for detailed comments anchored on the area each is most relevant to, instead of one giant comment.

**How to apply:**
- Anchor on prose, not inside a fence. Comments cannot sit in a fence ([[literal-text-in-viewmark-docs]]).
- Check that the anchor text occurs once in the document before adding the comment. Short phrases such as a cell list often repeat in the findings above a strategy.
- Notes go through the CLI ([[docs-through-hub-only]]).
