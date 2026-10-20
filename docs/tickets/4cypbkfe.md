title: Issues with bulleted list item
state: closed
type: task
priority: medium
parent:
depends:
reporter: Operator
created: 2026-10-20T20:58:05.966Z

I don't know if this is a bulleted list format problem, but it's busted.  Please figure out the scale of the renderingn problem, whether it affects other list types or constructs.

The text in the item below doesn't render as strikethrough and it should.

In vim keys mode, pressing ^ goes to the beginning of the line, but pressing l to move one to the right jumps the caret to the end of the line.  That is wrong - it should move one character to the right.


- ~~**G8. Landing.** A branch merges into `master` only after the play client has been used against it and a read-only review of its changes, area by area, against these rules finds nothing wrong.~~