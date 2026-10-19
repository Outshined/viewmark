title: Firefox: up arrow skips a line that holds only spaces or a tab
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: claude
created: 2026-10-14T01:22:11.998Z

In Firefox, ↑ from the paragraph below a line that holds only spaces or a tab skips that line, and lands at the end of the paragraph above it. Chromium lands at the start of that line. A line drawn empty has one caret position, at its start, and a click, ↓, and ↑ all land there (D16, R73).

The owner decided on 2026-10-14 that the caret can stop on any line that is not only markdown structure the renderer consumes, and that a line of only spaces or a tab between two paragraphs is such a place. QA had filed this ticket on its own reading of D16 before that answer; the answer confirms it.

Measured at `9626a0c` in Firefox, in the browser tests' 1920 by 1080 window, and the same at `f8792c8` in a 1200 by 900 window. Each cell's `up` route puts the caret at the start of `two` and presses ↑:
- `BG.ws.1`, `one\n\n‸ \n\ntwo\n`, a line of one space: the caret lands at 3, the end of `one`. Wanted 5.
- `BG.ws.2`, the same with a tab: lands at 3. Wanted 5.
- `BG.ws.4`, the same with two spaces: lands at 3. Wanted 5.

The `click`, `down`, and `emptied` routes of the three cells pass in Firefox, so the line can hold the caret; only ↑ passes over it.

## Acceptance
- {c1}{c2}In Firefox, the `up` route of `BG.ws.1`, `BG.ws.2`, and `BG.ws.4` lands at the start of the line of spaces or the tab, and the three cells pass on every route.{/c2}{/c1}
- They still pass in Chromium.

Run, from the repository root, in Chromium and again with `VIEWMARK_BROWSER=firefox`:
- `node --test --test-name-pattern='^BG\.ws\.' browser/empty-line.browser.js`

Rechecked at dc26ec3 on 2026-10-15, in QA's full runs: the three cells still fail in Firefox and pass in Chromium.

```comment c1
:: 0
@2026-10-19T00:08:43.191Z Grok
Firefox up still skips the line. BG.ws.1, BG.ws.2, and BG.ws.4 wanted offset 5 and landed at 3, the end of the paragraph above. Click and down on those three passed. BG.ws.3 passed on every route.

```

```comment c2
:: 0
@2026-10-19T03:04:54.380Z Grok
BG.ws.1 up wanted offset 5 and got 3. BG.ws.2 up wanted offset 5 and got 3. BG.ws.4 up wanted offset 5 and got 3.

```
