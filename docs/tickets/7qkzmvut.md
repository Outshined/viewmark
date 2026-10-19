title: Graphical artifacts when ticket drawer compacts
state: pending review
type: bug
priority: low
parent:
depends:
reporter: Operator
created: 2026-10-16T02:00:20.076Z


when the ticket drawer reels back in, it first goes transparent so any text behind it mingles and it looks really messy.  It needs ot stay opaque until it has withdrawn completely, not go basically transparent first.

## What QA measured
At 62f6923, in the browser tests' 1920 by 1080 window, with eight tickets and a document of long lines open. The pointer rests on the Tickets block until the drawer is wide, 80% of the window, then moves to the right of the page. QA asked the browser which element is on top at nine points inside the drawer's box, while it narrows.
- Chromium: the drawer stays wide and on top for the 200 ms the page waits. Then it drops back into the page's flow while it is still 1335 px wide. From 260 ms to 450 ms after the pointer leaves, every point QA tested inside the drawer is document text, not the drawer. At 350 ms the ticket titles and the document's lines are drawn over each other. By 550 ms the drawer is narrow enough to sit in its column.
- Firefox: the same, from 350 ms to 650 ms.

The drawer has no opacity change. When the page takes away its wide class, the drawer loses its fixed position and its `z-index` at once, but its width still runs its 0.5 s transition. For that time the document column, which comes later in the page, is drawn over the wide drawer.

## Acceptance
- While the ticket drawer narrows, from the moment it starts to the moment it is back in its column, it is drawn on top: at every point inside its box, the drawer or one of its rows is the top element, and no document text, comment card, or control shows through it.
- Its background stays opaque for that whole time.
- When it has narrowed, it sits in its column as it does today, and widening works as it does today, including a pointer that comes back within 200 ms.
- All of the above in Firefox.

QA builds a browser test named for this ticket when it lands.

## QA check of 96851ca
96851ca keeps the wide class, and with it the fixed position and `z-index`, until the width has eased back into the column. QA's tests are `browser/ticket-drawer-close.browser.js`, committed as `fc1efe4`, one test for each criterion above. `--test-name-pattern=7qkzmvut` runs them. They sample the page on every animation frame, at a 6 by 6 grid of points over the drawer's box, from the moment the pointer leaves until the drawer has rested for 10 frames.
- At be24b6f, all 5 pass in Firefox and in Chromium. In Firefox, the drawer is still fixed and on top at 650 ms, 397 px wide, and back in its column, 216 px wide, by 900 ms.
- At 0a3bca2 in Firefox, the two tests that the drawer is on top fail, and the other three pass. So the tests catch the failure this ticket reports.
- A pointer that comes back while the drawer narrows widens it again, and nothing covers it on the way.
- `ticket-links`, `menu-close`, `assignee`, `ticket-menu`, `ticket-cross-repo`, and `file-drawer` in Firefox: 61 of 61 pass.
