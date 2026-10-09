---
name: literal-text-in-viewmark-docs
description: In docs stored in the hub, put literal markdown, test strings, and comment markers inside ```text fences; code spans and backslashes do not protect them in this dialect
metadata:
  type: feedback
---

When a hub document has to show characters that markdown must not read (test fixtures, fence backticks, comment markers like an id in braces), put them inside a ```` ```text ```` fence. Verify the result by rendering it with `plan()` from `src/editor.js` before handing it over. Tell the user about a rendering problem only after testing it.

The dialect (checked 2026-10-08):
- It reads comment markers anywhere in prose, including inside a code span, and a backslash before the brace does not stop that.
- A code span ends at the next backtick, so it cannot hold one, and a double-backtick delimiter is not supported.
- A fence protects everything inside it.

**Why:** the editor-matrix plan first used bare double-quoted strings holding ``` and code spans holding comment markers. Both rendered as garbage or as live comments. When the user asked, "If you need to put characters in a markdown doc that you don't want markdown to interpret, what do you normally do? Why are you not doing that here?", that was the expected answer. I had also warned the user about the problem instead of testing it.

**How to apply:** any doc written through the hub ([[docs-through-hub-only]]) that quotes markdown goes in text fences. Prose describes markers instead of spelling them out. Comments cannot be anchored inside a fence, so keep the parts the user will annotate, such as decisions, in prose.
