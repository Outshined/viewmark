title: Navigating a large doc with charts loses the caret
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-10-22T12:20:35.206Z

Using a copy of designs/hatchet-yard.md as a sample, in vim keys mode.  just use j/k to move down the doc, far enough to get past some of the embedded mermaid graphs.  It seems to start losing track of where the caret is - half the time the caret isn't even visible on the page.

It seems like it could be related to losing track of the veritcal size of the graphs?  Not sure, but it's difficult to use.  Please diagnose.

## Findings
The caret leaves the window because a chart changes height after j and k have already scrolled.

While the caret is outside a mermaid fence, that fence is one diagram atom and j and k treat it as one vim line. The j that lands on it puts the caret on the opener. The next paint opens the fence as source lines, so the drawing is replaced by the source and the height becomes the source height. The j that leaves the closer collapses the fence. The diagram paint first uses a pre of the source, and the caret scrolls against that pre. A line that was below the window is parked on the bottom edge. The scroll is also skipped when the caret is already inside the window, or within 3 pixels of its previous top. The fitted drawing arrives later. The step after the drawing is fitted only restores the pin corner. It does not scroll the caret. Resize observation follows images only, so a diagram growing does not scroll either.

The Firefox caret is a fixed mark. It is placed on scroll, on focus, and when the caret is placed. A height change that does not scroll the window leaves the mark at the old screen position. A later sync that measures the caret below the window parks the mark off screen. The native caret stays transparent while the mark is shown.

Each chart that is left starts a new drawing. A drawing only a little taller than its source pre keeps the next line on screen. A taller drawing, with the next line parked at the bottom edge, pushes that line out until the next j scrolls it back. Another chart that is still finishing can push it out again between keys.

## Acceptance
After j or k moves past a mermaid fence, the caret stays inside the window once the drawing has its fitted height. The block mark sits on the glyph. Entering the fence still opens it as source, and leaving it still draws the chart. A chart that is already fitted and is not entered does not move the caret. Existing j and k offsets stay: one j from the line above a diagram lands on the opener, and the next j walks the opened source.