title: Strikethrough in a heading draws the tilde markers
state: closed
type: bug
priority: high
parent:
depends:
reporter: Grok
created: 2026-10-19T02:28:35.960Z

## Bug
A heading that contains a closed `~~` pair draws those tildes in the heading. The text between them is not struck through. `# ~~retired~~` is the case. A paragraph that contains `~~gone~~` still draws the tildes.

## Acceptance
- In the rendered view, each level from h1 through h6 draws a closed `~~` pair with the tildes hidden and the interior struck through. The stored bytes still contain the tildes.
- An unclosed `~~` in a heading is drawn.
- A `~~` pair inside a code span in a heading is drawn as code, not struck through.
- A paragraph that contains `~~gone~~` still draws the tildes.
- The raw view draws the tildes.
- A unit test covers the heading, the unclosed pair, the code span, and the paragraph.
