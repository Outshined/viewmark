title: keep markdown syntax out of edit commands
state: pending review
type: task
priority: medium
parent:
depends:
reporter: Operator
created: 2026-11-03T14:32:03.747Z

When editing, consider markdown syntax to be a word boundary.  Example: **foo** with the caret on the 'f' and pressing cw leaves the trailing ** in place.

This could be a simple but reasonably significant change, please raise issues if necessary.

Checked on 2026-11-03. An operator or a word object treats parsed markdown syntax as its own word. cw with the caret on the f of **foo** leaves the trailing marks. w and Ctrl+arrow still run to whitespace, and a marker stays on that word. A mark inside code stays text. An apostrophe or a comma stays on the word. 2cw counts a syntax run as a word. An image token is one word.
