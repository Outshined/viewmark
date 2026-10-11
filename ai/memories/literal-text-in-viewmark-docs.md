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

**Why:** the editor-matrix plan first used bare double-quoted strings holding ``` and code spans holding comment markers. Both rendered as garbage or as live comments. The user asked what I normally do with characters that markdown must not interpret, and why I was not doing it here; that was the expected answer. I had also warned the user about the problem instead of testing it.

**Generated reports.** Inside a text fence, any line that starts with three backticks ends the fence early. Tool output often spans several lines and holds a document's own fence lines, such as a hub refusal that echoes the file. Flatten every message to one line before it goes into a fence. Run the fence-balance check, and do not publish when the check fails. On 2026-10-08 a report went to the hub with a failed check, and was broken from its middle on until it was republished.

**Comment notes are fences too.** A comment thread is stored as a fence, so a note must never contain a line starting with three backticks: it closes the thread early, leaves the rest of the note as document text, and opens a stray fence. On 2026-10-10 a note with a text fence broke ticket `j9gaprqe` until it was repaired by `edit`. For literal examples in a note, indent the lines instead, and check the document with `plan()` (one comment parsed, fence lines even) after posting.

**How to apply:** any doc written through the hub ([[docs-through-hub-only]]) that quotes markdown goes in text fences. Prose describes markers instead of spelling them out. Comments cannot be anchored inside a fence, so keep the parts the user will annotate, such as decisions, in prose.
