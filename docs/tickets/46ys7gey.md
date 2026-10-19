title: Firefox: bullet list items are 2.5 px further apart than two lines of a paragraph
state: closed
type: bug
priority: low
parent:
depends:
reporter: claude
created: 2026-10-16T02:07:13.569Z

In Firefox, items of a bullet list are 28.85 px apart, where two lines of one paragraph are 26.35 px apart. 696d8kue, "One vertical measure between rendered markdown blocks", sets them one line box apart, and was closed with this open, so it is tracked here. The text below is QA's check from 696d8kue.

Checked by QA at `307fed5`, 2026-10-14. `browser/block-measure.browser.js`, committed as `307fed5`, measures every acceptance item that `browser/block-gap.browser.js` does not, within 1 px, with P read from the page (13.175 px in both browsers).

Chromium passes 26 of 26, each within 0.01 px of its target. Firefox passes 24 of 26. The acceptance is not met in Firefox:
- In a bullet list, each item's line box is 28.85 px tall, where two lines of one paragraph are 26.35 px apart. So the first item to the second item, and a continuation line to the next item, are 28.85 px apart, not 26.35. Ordered items are 26.35 px apart and pass.
- The bullet glyph is drawn in Firefox's bullet font, and at line-height 1.55 that font makes the line box taller. In a probe page, `::marker { line-height: 0 }` on the item brought it to 26.35 px.
- `browser/block-gap.browser.js` passes in Firefox because it compares the bullet pitch with the bullet's own height, not with a line of a paragraph.

Every other measure in Firefox matches Chromium. `node --test` passes 421 of 427, with 6 todo.

```bash
node --test browser/block-measure.browser.js
VIEWMARK_BROWSER=firefox node --test browser/block-measure.browser.js
```

Still so at dc26ec3 on 2026-10-15: the bullet list test fails in Firefox and passes in Chromium.

## Acceptance
- In Firefox, consecutive bullet items, and an item and its continuation, sit one line box apart, the same as two lines of one paragraph, within 1 px.
- Ordered items still measure the same.
- `browser/block-measure.browser.js` passes in Firefox.
