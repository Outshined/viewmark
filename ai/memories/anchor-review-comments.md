---
name: anchor-review-comments
description: Every point QA raises on a hub doc or ticket — review points and questions for the owner alike — goes in its own comment anchored on the text it is about, never one long comment
metadata:
  type: feedback
---

When reviewing a document in the hub, give each point its own thread. Anchor it with `comment add --start --end --expect` on the sentence or line it is about, such as a step's rule or its Tickets or Proof line. Reply in the requester's thread only with a short verdict that names the anchored thread ids.

**Why:** on 2026-10-09 a review of a six-step strategy went into one long reply in the thread that asked for it. The user asked for detailed comments anchored on the area each is most relevant to, instead of one giant comment.

**Again on 2026-10-14:** QA put 17 questions for the owner on a design ticket (7vdep2z4) into one comment anchored on a single sentence. The owner asked for comments placed where they are relevant. They were moved to one comment per design passage, and a question about a thread that already exists became a reply in that thread. This holds for questions and acceptance notes as much as for reviews.

**How to apply:**
- One comment per point, anchored on the design or doc text the point is about. A point that touches several places is split by place.
- A point about a topic that already has a thread is a reply in that thread.
- A table cell can take an anchor.
- Anchor on prose, not inside a fence. Comments cannot sit in a fence ([[literal-text-in-viewmark-docs]]).
- Check that the anchor text occurs once in the document before adding the comment. Short phrases such as a cell list often repeat in the findings above a strategy.
- Notes go through the CLI ([[docs-through-hub-only]]).
