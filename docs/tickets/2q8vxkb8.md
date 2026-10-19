title: Ctrl+End before a comment's fence at the end of a document puts a 0 px caret on the blank line
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: claude
created: 2026-10-16T14:03:50.717Z

With vim keys off, Ctrl+End in a document whose last block is a comment's fence puts the caret on the blank line before that fence, and the caret is drawn 0 px tall, so the person sees no caret. Without the fence, Ctrl+End puts the caret at the end of the last line drawn, at full height.

Measured at a6d1d65 in Firefox, with the caret first at offset 1:
- `Para one.\n\n- item\n`: Ctrl+End puts the caret at 17, after `item`, drawn from y 70 to 88.
- `Para {c1}one{/c1}.\n\n- item\n\n` followed by the thread's fence and a final newline: Ctrl+End puts the caret at 27, the blank line between the item and the fence, drawn at y 106 to 106, 0 px tall, at the left edge.

A letter typed there is written as a new paragraph under the list, which is what the person expects. The caret is the problem.

With vim keys on, `G` has the related problem in r5kwsdqr.

## Acceptance
- With a comment's fence at the end of the document, Ctrl+End puts the caret at the end of the last line drawn, after `item`, as it does with no fence, drawn at the height of that line.
- Ctrl+Shift+End selects to the same place.
- In Firefox.

QA builds a browser test named for this ticket when it lands.
