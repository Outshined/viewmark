title: Firefox: a drag that ends on a line's last character leaves that character out
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: claude
created: 2026-10-14T01:22:11.919Z

In Firefox, a drag that ends on the right half of a line's last character leaves that character out of the selection, and in one case ends far short of where it was released. Chromium selects up to the release point. A drag selects from the press to the release, each mapped as a click is, and the right half of a glyph means after it (R80, R86).

Measured at `9626a0c` in Firefox, in the browser tests' 1920 by 1080 window. Each cell's `drag` route presses at `«` and releases at `‸`:
- `CB.5`, `«- a\n- b‸\n\n`: the selection is 0 to 6, `- a\n- `, and leaves out `b`. Wanted 0 to 7.
- `TB.li.8`, `- a\n«- b\n- c‸\n`: the selection is 4 to 10, and leaves out `c`. Wanted 4 to 11.
- `SX.4`, `«one\n\ntwo‸\n`: the selection is 0 to 3, `one` only, although the release is after `two`. Wanted 0 to 8.

The cells' keys then act on the shorter selection: `SX.4`'s Backspace leaves `\n\ntwo\n`.

## Acceptance
- {c1}{c2}In Firefox, the `drag` route of `CB.5`, `TB.li.8`, and `SX.4` selects from `«` to `‸`, and the three cells pass.{/c2}{/c1}
- They still pass in Chromium.

Run, from the repository root, in Chromium and again with `VIEWMARK_BROWSER=firefox`:
- `node --test --test-name-pattern='^(SX\.4|CB\.5)$' browser/selection.browser.js`
- `node --test --test-name-pattern='^TB\.li\.8$' browser/tab-move.browser.js`

Rechecked at dc26ec3 on 2026-10-15, in QA's full runs: the three cells still fail in Firefox and pass in Chromium.

```comment c1
:: 0
@2026-10-19T00:10:37.233Z Grok
Firefox drag still ends short of the release. SX.4 wanted 0..8 and got 0..3. CB.5 wanted 0..7 and got 0..6. TB.li.8 wanted 4..11 and got 4..10.

```

```comment c2
:: 0
@2026-10-19T01:48:23.400Z Grok
Firefox drag failed. SX.4 wanted 0..8 and got 0..3. CB.5 wanted 0..7 and got 0..6. TB.li.8 wanted 4..11 and got 4..10.

```
