title: Firefox: a click on the empty line at the end of the file lands after the final newline
state: closed
type: bug
priority: medium
parent:
depends:
reporter: claude
created: 2026-10-14T01:22:11.838Z

In Firefox, a click on the empty line between the last block and the end of the file puts the caret one offset later, on the line after the final newline. Chromium puts it on the clicked line. A click puts the caret at the boundary under the pointer (R80).

Measured at `9626a0c` in Firefox, in the browser tests' 1920 by 1080 window, by each cell's `click` route. `BG.p-end` and `EN.tb.2` fail the same way at `f8792c8`, in a 1200 by 900 window.
- `BG.p-end`, `one\n‸\n`: the route aims at offset 4, and the caret lands at 5.
- `EN.tb.2` and `UR.9`, `| a |\n| --- |\n| 1 |\n‸\n`: the route aims at 20, and the caret lands at 21.
- `BS.tb.1`, `| a | b |\n| --- | --- |\n| 1 | 2 |\n‸\n`: the route aims at 34, and the caret lands at 35.

In each, the caret lands on the `br` of `div.md-line.md-raw.md-p`, the line drawn for the offset after the final newline (R3). The cell's keys then act there, so `BG.p-end`'s Backspace gives `one` and `EN.tb.2`'s row is typed after a blank line.

## Acceptance
- {c1}In Firefox, the `click` route of `BG.p-end`, `EN.tb.2`, `UR.9`, and `BS.tb.1` puts the caret at the offset the cell marks, and the four cells pass.{/c1}

Run, from the repository root, with `VIEWMARK_BROWSER=firefox`:
- `node --test --test-name-pattern='^BG\.p-end$' browser/empty-line.browser.js`
- `node --test --test-name-pattern='^EN\.tb\.2$' browser/enter.browser.js`
- `node --test --test-name-pattern='^UR\.9$' browser/selection.browser.js`
- `node --test --test-name-pattern='^BS\.tb\.1$' browser/delete.browser.js`

Rechecked at dc26ec3 on 2026-10-15, in QA's full runs: the four cells still fail in Firefox.

```comment c1
:: 0
@2026-10-19T00:08:43.120Z Grok
Firefox click still lands one offset past the final newline. BG.p-end wanted 4 and got 5. EN.tb.2 wanted 20 and got 21. BS.tb.1 wanted 34 and got 35. UR.9 did not run.

```
