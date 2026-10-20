title: Line-level highlights don't work in vim keys
state: closed
type: bug
priority: high
parent:
depends:
reporter: Operator
created: 2026-10-19T23:36:56.428Z

Start with a multi-line doc, with vim keys on.

Press V to highlight an entire line

Press j j j to move the cursor down three lines, see if the highlight is the original line plus the three additional.

Pres k k k  to go back up, see if the highlight is back to the original line.

Pres k k k to go up three lines, check the correct lines are highlighted.


Do this with bulleted lists, numberd lists, headings.  See what it does when the highlight passes over a line with an image, or a fence.