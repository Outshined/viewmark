title: cannot edit a fence after it's in a doc
state: closed
type: bug
priority: high
parent:
depends:
reporter: Operator
created: 2026-10-28T22:44:24.365Z

After a fence is in a doc, especially after it has a type after it, you can't edit the fence anymore.  I just put a spurious 'xml' after a fence in a doc, and I cannot delete the 'xml' now in regular or vim keys mode.  It needs to be a normal text edit in either mode.

Checked on 2026-10-28. A fence info string edits as ordinary text, with vim keys on and with vim keys off.

From the body, h and a left arrow step onto the opener, and the next delete removes a letter of the info string. In vim, x on the opener deletes a letter and insert types there. With vim keys off, ArrowLeft then Backspace does the same, and a caret already on the info string deletes and inserts. A jump that leaves the fence still stops on the body edge.