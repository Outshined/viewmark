title: 'down' out of a graph jumps to page bottom
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-10-22T14:04:34.177Z

Still having issues when navigating around mermaid graphs.  if you move the caret down line by line out of the end of a mermaid graph fence when it flips back to the graphic the caret tends to drop to the bottom of the page.

Please use a copy of hatchet-yard.md in the server repo the hub knows about to load intio Firefox and make sure that al caret operations around mermaid graphs make sense.  Do not just walk through the code for this - you've done that a few times and I still keep finding issues.  Your goal is to havae me not find simple caret navigation issues.  You will find them, fix them, and write tests to ensure that the caret behaves properly when crossing all the boundaries.