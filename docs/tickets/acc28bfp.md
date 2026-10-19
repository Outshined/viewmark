title: Shift+Enter with nothing after the break leaves a backslash that other markdown viewers show
state: pending review
type: enhancement
priority: low
parent:
depends:
reporter: claude
created: 2026-10-11T21:07:38.856Z

On 2026-10-11 the owner asked QA to define a clean case for Shift+Enter, one that other markdown viewers render the way Viewmark draws it, and to put it in a ticket. The owner is not much concerned, because other features, such as comment threads, do not carry over to other viewers either. The criteria below are QA's definition. {c1}The owner approved them on c1 and c2 on 2026-10-16.{/c1}

The problem. Shift+Enter writes a backslash and a newline (R26, D28). CommonMark, and GitHub with it, reads those as a line break only when more text of the same block follows. A backslash at the end of a block is an ordinary character. Viewmark hides it (R1), so the page looks right, but another viewer shows the backslash.

Measured at `ad31b0d`: Shift+Enter at the end of `alpha` with nothing typed, then ↑, and the file rendered with cmark-gfm, GitHub's renderer. Bytes are in the plan's notation, where `\\` is one backslash and `\n` a newline.
- An item, then a paragraph: `- alpha\n\nend\n` becomes `- alpha\\\n\n\nend\n`. GitHub draws the item as `alpha\`.
- A quote, then a paragraph: `> alpha\n\nend\n` becomes `> alpha\\\n> \n\nend\n`. GitHub draws the quote as `alpha\`.
- A paragraph, then a paragraph: `alpha\n\nend\n` becomes `alpha\\\n\n\nend\n`. GitHub draws `alpha\`.
- A paragraph at the end of the file: `alpha\n` becomes `alpha\\\n\n`. GitHub draws `alpha\`.
- An item, then another item: `- alpha\n- beta\n` becomes `- alpha\\\n\n- beta\n`. GitHub draws `alpha\`, and the blank line makes the list loose, so each item is drawn as its own paragraph, with space between the items.

With a letter typed after the break, all five are clean: GitHub draws `alpha`, a line break, and the letter, in the same block, as Viewmark does.

{c2}Acceptance criteria, QA's definition of the clean case:{/c2}
- Once the caret has left the line a Shift+Enter break opened, and that line is still empty, the file holds no backslash break that ends its block. The break and the empty line go, and the file is as it was before the Shift+Enter. In the five cases above, Shift+Enter then ↑ leaves `- alpha\n\nend\n`, `> alpha\n\nend\n`, `alpha\n\nend\n`, `alpha\n`, and `- alpha\n- beta\n`. ↓, or a click on another block, gives the same.
- The same holds when the text after a break is deleted later: Shift+Enter, `x`, Backspace, then ↑, leaves the file as it was before the Shift+Enter.
- With text after the break, nothing changes. The file keeps the backslash break, and GitHub draws the line break the page draws. The `SE` cells and `browser/shift-enter.browser.js` check this today.
- Every file these steps leave renders in cmark-gfm with the line breaks the page draws, and with no backslash that the page hides.

Accepted: while the caret is still on the empty line, the file holds the break, so a viewer that reads the file at that moment shows the backslash.

QA builds the tests when this lands.

```comment c1 resolved
:: 0
@2026-10-16T01:56:04.477Z claude
QA's question for the owner. Do you approve the acceptance criteria below as the clean case for Shift+Enter? The page does not meet them yet. QA builds the tests once they are approved and the change lands.

:: 1
@2026-10-16T14:14:07.768Z Operator
Approved, see c2.
```

```comment c2
:: 0
@2026-10-16T14:13:55.205Z Operator
Accepted, please implement this way.
```
