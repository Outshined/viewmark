# Live run: editing matrix

Contract: `qa/editor-matrix-test-plan.md`, every section. Run on 2026-10-11 against `9bd7af4`, the HEAD of master at the time. Chromium 153.0.8010.52, headless, window 1200 by 900. Node 26.10.0. This report replaces the one from the morning of 2026-10-08, which was run against `49d5c1b` on Chromium 150.

The run used a copy of `9bd7af4` made with `git archive`, outside the repository, so commits landing during the run could not change the code under test. Each of the eight suites started its own hub as a separate process, `node cli.js --port 0 serve`, over a new temporary state directory, with a temporary repo and a proxy in front of it. The hub on 8765 was only read, to fetch the plan's cells.

Pass P1 ran, at three suites at a time.
- **How it was measured:**
  - The bytes checked are the ones the hub last sent the page. The hub itself is read once, at the end of each cell.
  - After each key, the harness waits until every edit the page sent has been answered, by a `doc`, a `noop`, or an error.
  - `DC` and `T3` cells ran twice, with 30 ms and with 250 ms between presses.
  - I12, new on 2026-10-10: the probe's Q must be drawn where the caret was drawn just before the key (R99, the owner's rule that text appears where the caret is). A Q that carries its word onto the next visual line is checked against the glyph before it, and a line with right-to-left text is skipped. Until 12:40 a soft-wrap point was also allowed on either side of the wrap. That allowance hid the Home and End failures on wrapped lines, so it was removed. A caret on an empty line is drawn in the line's own box, and that counts as drawn. Where R11 writes a newline before the Q, I12 finds the Q past it. At a soft wrap the selection has a rect on each line; the harness paints the caret red and takes the rect that holds red pixels.
- **Not checked:**
  - I6, I8, I10 (except on scrolled routes), and I11;
  - I3 for a selection;
  - passes P2 to P5.
- **Also run:** the browser tests outside the matrix, at `9bd7af4`, in the full run: all pass. That includes the tests added today for the add-comment button over a comment card, Shift+Enter's drawing, Delete between an item or a quote and a paragraph, and glyph button tooltips. Firefox 157 (`VIEWMARK_BROWSER=firefox`) was last run on the whole matrix at `010dc55`, with 663 of 744 runs passing. Its two Firefox-only cells, `MV.he.9` (`9c3vjbvx`) and `MV.hr.1` (`4utk27hc`), pass since `fdc2b0c`. Every ticket closed today was also checked in Firefox. `node --test` passes 403 of 403 in the working tree at `9bd7af4`. In the copy the run used, three tests that read git fail, because a copy made with `git archive` is not a repository.

723 runs: 715 PASS, 8 FAIL, 0 route FAIL, 0 not automated.

| section | PASS | FAIL | route FAIL | other |
|---|---|---|---|---|
| TY, typing | 45 | 0 | 0 | 0 |
| TC, typing makes a construct | 8 | 0 | 0 | 0 |
| EN, Enter | 72 | 1 | 0 | 0 |
| SE, Shift+Enter | 4 | 1 | 0 | 0 |
| EB, Enter, then Backspace | 23 | 0 | 0 | 0 |
| EF, end of file | 17 | 0 | 0 | 0 |
| BS, Backspace | 54 | 2 | 0 | 0 |
| BG, Backspace on an empty line | 179 | 0 | 0 | 0 |
| DL, Delete | 33 | 0 | 0 | 0 |
| WB, word delete back | 13 | 0 | 0 | 0 |
| WD, word delete forward | 5 | 0 | 0 | 0 |
| CR, CRLF files | 6 | 0 | 0 | 0 |
| TB, Tab | 22 | 0 | 0 | 0 |
| MV, moving | 65 | 4 | 0 | 0 |
| WK, walking the caret | 7 | 0 | 0 | 0 |
| RD, another client reads | 6 | 0 | 0 | 0 |
| CK, click | 38 | 0 | 0 | 0 |
| DC, double-click | 44 | 0 | 0 | 0 |
| T3, triple-click | 16 | 0 | 0 | 0 |
| DG, drag | 5 | 0 | 0 | 0 |
| DD, drop | 1 | 0 | 0 | 0 |
| SX, selections | 12 | 0 | 0 | 0 |
| CB, clipboard | 5 | 0 | 0 | 0 |
| UR, undo and redo | 17 | 0 | 0 | 0 |
| IM, composition | 2 | 0 | 0 | 0 |
| MS, several sessions | 16 | 0 | 0 | 0 |

## What is left

8 runs do not pass. Each has a ticket or a note.
- **`EN.fu.1`** by click: in a code fence that is not closed and has no final newline, Enter draws the caret on the new body line, and the letter appears a line below it (R99, ticket `j9gaprqe`, reopened).
- **`SE.li.1`** by click: after Shift+Enter in a list item, the caret on the new line is drawn at the left edge of the text column, and the letter appears where the item's text starts (R99, ticket `negjtfrn`, reopened).
- **`BS.pad.3`** by click: QA proposes that Backspace at the start of a paragraph under a list item joins them with no space, as `BS.pad.1` does for two paragraphs (D34, not approved). Today the page joins them with a newline, drawn as a space. Not a bug until the owner decides.
- **`BS.pad.4`** by click: QA proposes that Backspace at the start of a paragraph under a quote joins them with no space, as `BS.pad.1` does for two paragraphs (D34, not approved). Today the page joins them with a newline, drawn as a space. Not a bug until the owner decides.
- **`MV.mm.2`** by click: at the start of a fence line directly under a paragraph, a typed letter joins the paragraph above; R11's newline is not written (R11, R99, ticket `j9gaprqe`, reopened).
- **`MV.lg.1`** by click: End on a long URL, which breaks inside a word, draws the caret at the end of the full line, as the owner's rule for End says (R74), and the Q appears at the start of the next. Where a letter typed on a full line should appear is not decided (R99, ticket `pg66fa4a`, c2).
- **2 cells, 2 runs**: End on a visual line that wraps at a space draws the caret after the last word, but the Q appears at the start of the next line (R99, ticket `pg66fa4a`). The owner decided on 2026-10-10 that End goes to the end of the current display line, so the letter belongs on that line (R74). Cells: `MV.he.13`, `MV.he.14`.

## Runs today

Each row is a full run of the matrix, after Grok's commit named in it. The cell count grew as cells were added to the plan.

| commit | what landed | runs | PASS |
|---|---|---|---|
| `49d5c1b` | the run this report replaces, 2026-10-08 | 810 | 531 |
| `19531fa` | step 1: every edit gets an answer | 819 | 538 |
| `ba2277a` | step 2: locks follow each edit's own changes | 820 | 565 |
| `7143a1d` | step 3: a reconnect keeps its holds and caret | 820 | 573 |
| `69d32a0` | step 4: one caret | 820 | 588 |
| `dfd53f4` | step 5: one DOM point per offset | 821 | 688 |
| `9b6594a` | step 6: double-click maps the first press; 52 regressions, `kd77s4g9` | 821 | 668 |
| `163b3fb` | a click places its caret at once | 821 | 714 |
| `8ca0808` | a clicked block opens on release | 821 | 720 |
| `61a559e` | a line drawn empty is deleted | 821 | 729 |
| `ca84e0e` | CRLF, Ctrl+A, goal column, drawer animation | 826 | 745 |
| `8246ce4` | Enter splits a paragraph | 826 | 756 |
| `7a42ae2` | quotes, raw list markers, empty items | 826 | 771 |
| `0f091a2` | Shift+Tab, Backspace after a marker, word delete, task items | 826 | 803 |
| `64978ec` | renumbering, Enter over a selection | 826 | 807 |
| `cc17fde` | Enter writes a blank line where lines would join | 826 | 819 |
| `d04ca2b` | Shift+Tab off a list keeps focus; dragging selected text moves it | 826 | 820 |
| `7554e01` | a reload keeps the newest socket for its session token | 826 | 820 |
| `bbba5d0` | a line of only spaces or tabs keeps the caret at its start | 826 | 824 |
| `c5634ec` | a later drag replaces the primary selection | 826 | 825 |
| `79b37c5` | crowded comment cards stay short and in anchor order | 826 | 825 |
| `79b37c5` | the same commit, with the new I12 check for R99; the code did not change | 826 | 765 |
| `79b37c5` | the same commit; I12 no longer allows a soft-wrap point, and cells `MV.he.11` to `MV.he.14`, `TB.ol.2`, and `TB.ol.3` are new; the code did not change | 832 | 763 |
| `ebae3bd` | the files drawer (`ac4d9bc`, `49bc005`), typing on a joined line (`7517392` to `5cb95e0`), and list numbering (`ebae3bd`). I12 now counts a caret drawn in an empty line's own box, and finds the Q past a newline written before it; without that, 42 runs passed I12 without being checked. At a soft wrap the harness now reads the caret where it is painted; Home on a wrapped line was a false failure (ticket `knyc3ktx`, closed), and its three cells pass | 832 | 767 |
| `49bc005` | the files drawer floor (`49bc005`), with the harness that reads the caret where it is painted. `IM.4` ends on the blank line between two paragraphs and joins the `j9gaprqe` list; it had passed I12 without being checked | 832 | 766 |
| `b4074ca` | the list marker hang (`6731e4c`) and the comment marker outside a line marker (`2d84c66`). The owner's answers in `editing.md` changed 51 runs' cells to rules not built yet (R7, R18, R26, R33, R40, R70, R85); each names its ticket below. No run regressed from the code | 839 | 722 |
| `8376706` | the raw view (`7f486b1`), comment moves (`2a3b306`, `02a1738`), two tabs as two sessions (`a1452b2`), a card delete keeping the caret (`d8b7cbd`), the caret after a tab (`48c90f9`), and the list marker hung with text-indent (`8376706`). 16 runs regressed: 15 list cells after an empty item's marker, and `BG.ws.3` | 839 | 708 |
| `891c8d4` | paragraph padding (`955b636`, `780edb0`, `891c8d4`), with the plan as the owner restated R7: 24 cells that started on the blank line between paragraphs retired, 9 new cells added. `CK.cm.2` retired by R105. The harness now reads the caret beside a handle marker and between lines by its paint | 764 | 647 |
| `726dd0b` | raw mode as a plain view with nothing stored (`6d4fc94`, `aefb682`, `b9db04c`) and images at their intrinsic size (`12df32a`). No cell changed | 764 | 647 |
| `cc33413` | ticket states (`72cfe39`), hard breaks (`149aa21`), a typing run as one undo step (`325be28`), and the blank line between paragraphs drawn with no height (`cc33413`). 34 cells now pass. Ten regressed: six on I12 where the blank line still draws when no paragraph follows it (`yjd3apk5`, reopened), and `MV.av.1`, `MV.av.2`, and `MV.sh.3`, whose expectations still stopped on the blank line and are updated in the plan since. `BS.pad.1` and `DL.pad.1` changed expectation today (D34) | 766 | 682 |
| `fdc2b0c` | triple-click by block (`e0b810c`), word moves (`0e1ee76`), a move keeping the caret (`b099cc2`), focus kept in a ticket field (`ec77a88`), the add-comment button in the comments column (`0d75585`), Delete on an empty line (`1d3b534`), Backspace and Delete joining paragraphs (`536b180`), Shift+Enter (`06ef8ef`), and End and → in Firefox (`fdc2b0c`). 36 runs now pass. 19 regressed: eight cells whose expectations were stale against `BS.pad.1` and R18 and are updated in the plan since, five `cleared` routes that a triple-click by block broke in the harness, and Backspace on an empty line between two paragraphs, which joined them (`s6grmd59`) | 767 | 706 |
| `9f02ece` | the add-comment button under a card (`0b0ab65`), the hard break hidden in a quote (`acf22a9`), Enter then Backspace with no final newline (`3ff4470`), the blank under an item or a quote (`14e315a`), and the paragraph join fixed (`7ed0b2e`). Six cells that started on that blank are retired. Seven regressed: leaving a list or a quote with Enter drew the caret a line below the letter (`yjd3apk5`) | 723 | 691 |
| `9bd7af4` | the blank under a paragraph, an item, or a quote with no height whatever follows (`1bdd626`, `9bd7af4`), and the letter after a final newline on its own line (`b35cad7`). 24 runs now pass, and none regressed | 723 | 715 |

No commit after `9b6594a` failed a cell that passed in the run before it, except where a ticket below says so. Runs before `0f091a2` used the working tree, on Chromium 150 and Node 26.5.0. From `0f091a2` on, runs used a copy of the commit, on Chromium 153 and Node 26.10.0. With the new versions, `7a42ae2` passes 769 instead of 771. The two are `MS.15` and `CK.mid.1`, both under What is left.

## Findings from the 2026-10-08 report

Every finding of the earlier report is fixed, and its cells pass.

| finding | ticket | fixed by | now |
|---|---|---|---|
| F1. Backspace on an empty line before another empty line | `dxunpqya` | `ba2277a` | pass |
| F2. An edit that changes nothing stops the page sending edits | `ywxv8kv8` | `19531fa` | pass |
| F3. A caret at a table's or diagram's end has no place | `48kcj3bw` | `dfd53f4` | pass |
| F4. ↓ from a table's last row skips the empty line | `bkzmqu4a` | `dfd53f4` | pass |
| F5. The caret goes to the top at the empty last line | `6zhw75ad` | `dfd53f4`, `163b3fb` | pass |
| F6. Delete at a line's end before another block | `k55fh3ph` | `ba2277a` | pass |
| F7. Deleting a comment's last character | `cgufd4zy` | `dfd53f4` | pass |
| F8. Double-click or triple-click in a code block | `twx89za3` | `9b6594a` | pass |
| F9. An arrow key into a closed table | `vet9q2d4` | `dfd53f4` | pass |
| F10. A composed character lands late | `r2w4gf74` | `69d32a0` | pass |
| F11. The add-comment button covers text | `b9xa86zd` | `9b6594a` | pass |
| F12. Arrow keys after Home or End | `qwgtm6rq` | `69d32a0`, `163b3fb` | pass |
| F13. Undo or redo with nothing to act on gets 409 | `8qmzey9x` | `19531fa` | pass |
| F14. A drag from before a list marker collapses | none | `69d32a0` | pass |
| F15. An agent reading a file moves the caret | `fevc3ppa` | `69d32a0`, `163b3fb` | pass |
| F16. A dropped connection locks out the person's own session | `sn9q5jdd` | `7143a1d`, `7554e01` | pass |
| F17. An agent cannot comment while someone is in the last paragraph | `e9ujmbkg` | `ba2277a` | pass |
| F18. An agent cannot append after the paragraph a person is in | `7s7esnry` | `ba2277a` | pass |

## Bugs found today

Found by these runs, or by browser checks made while verifying a closed ticket.

| ticket | what broke | caused by | fixed by |
|---|---|---|---|
| `76htwrw3` | a key at a comment marker deleted the comment's thread | `ba2277a` | `c32cb82`, `dfd53f4` |
| `kd77s4g9` | a single click on a table, image, diagram, or rule, or below the text, left the caret where it was | `9b6594a` | `163b3fb` |
| `u94zghcq` | within half a second of a click, Backspace and ← skipped a list, quote, or heading marker | `9b6594a` | `8ca0808` |
| `w3hccq8y` | a bullet item's continuation showed its indent spaces | before today | `b7b43ab` |
| `n6nzjhn5` | Enter on an item's or a quote's continuation line split the text out as a paragraph | `8246ce4` | `f48cb98`, `9a28c9e` |
| `5q8qsh2p` | `node --test` failed: `T-tab-key` still expected Shift+Tab off a list to fall through | `a5b47b4` | `10f5e92` |
| `xwasru5a` | comment cards on nearby paragraphs overlap and change order; found while checking `da8r8xe2`, outside the matrix | `c59734e` | `79b37c5` |
| none | a drag in the editor did not replace the primary selection, so a middle-click pasted text an earlier drag selected (`CK.mid.1` after other `CK` cells) | seen first on Chromium 153 | `c5634ec` |
| `b9xa86zd` | the add-comment button sat over the line above the selection, so a click there, or the third press of a triple-click, wrote an empty comment; then, in the comments column, it covered a card on the selection's line | `9b6594a`, then `0d75585` | `0d75585`, `0b0ab65` |
| `s6grmd59` | Backspace on an empty line between two paragraphs joined them; QA's wording of R18 said to remove the blank line above in every case | `536b180` | `7ed0b2e` |
| `s7v532j5` | Delete on the empty line between an item or a quote and a paragraph folded the paragraph into the item or the quote | `1d3b534` | `14e315a` |
| `negjtfrn` | Shift+Enter in a quote, or with nothing typed after it, left a backslash drawn | `06ef8ef` | `acf22a9` |
| `yjd3apk5` | leaving a list or a quote with Enter drew the caret a line below where the letter appears | `14e315a` | `9bd7af4` |
| `9c3vjbvx` | Firefox: End on a hard-break line went past the hidden spaces, and a letter typed there removed the break | before today | `fdc2b0c` |
| `4utk27hc` | Firefox: → from the line above a rule skipped the rule | before today | `fdc2b0c` |
| `72mpt9d6` | a change from another client took the focus out of a ticket field being typed in, and in Firefox replaced the unsaved text | before today | `ec77a88` |

Closed tickets that a later commit broke, and that were reopened and then fixed again:
- `cgufd4zy`, broken by `c32cb82`, fixed by `dfd53f4`.
- `6zhw75ad`, `meu9udz4`, and `kt2vhy7b`, broken by `9b6594a`, fixed by `d3b6b79` and `163b3fb`.
- `4bpe6npn`, `z75kxa4t`, `qwgtm6rq`, and `fevc3ppa`, broken by `d3b6b79`, fixed by `163b3fb`.
- `kgpyrdr9`, closed at `eb7e46d` with typing and Backspace not ending the run of vertical moves, fixed by `a12faef`.
- `uwtqazmt`, closed at `66a4e73` with Delete before a CRLF pair leaving a lone newline, fixed by `3f26c4e`.
- `vkchc2r9`, the files drawer moved the ticket pane, fixed by `abd8f8a`.
- `sn9q5jdd`, a reload followed by a dropped connection lost the caret, found on Chromium 153, fixed by `7554e01`.
- `yjd3apk5`, closed twice with the blank still drawn at the end of a file with no final newline and of a ticket's text, fixed by `1bdd626` and `9bd7af4`.
- `j9gaprqe`, closed with Enter at the end of a paragraph still drawing the caret below the letter, then with `MV.mm.2` and `EN.fu.1` failing; reopened.
- `p4sbujyz`, closed with tooltips copied from the buttons' labels instead of written hints, fixed by `e0164de`.
- `b9xa86zd`, closed twice with the add-comment button over clickable text, fixed by `0d75585` and `0b0ab65`.
- `negjtfrn`, closed with a backslash drawn, fixed by `acf22a9`, then closed with `SE.li.1` failing; reopened.
- `s7v532j5`, closed with Delete folding a paragraph into an item or a quote, fixed by `14e315a`.

## Approved defaults

Every approved default is built, and its cells pass, except:
- D28, Shift+Enter's hard break, approved on a condition on 2026-10-11: `SE.li.1` fails on I12, with the caret on the new line drawn left of where the letter appears (ticket `negjtfrn`, reopened).

## Harness notes

- **Teardown.** Each close in a suite's teardown runs even when an earlier one fails, and a hub or browser that will not exit is killed after 5 s. The test hub and Chromium end with the test process, however it ends. This is committed as `85ee3f7`.
- **Flaky under load.** `BG.h-p` by the cleared route failed once in a full run at `0f091a2`, and passed three times out of three when run alone.
- **Flaky under load.** `BG.p-eof` by the resize route failed once in the full run at `7554e01`, where the probe's Q did not land. Run alone, it passed on all 15 of its routes three times out of three.
- **Flaky under load.** `images.browser.js`, the picture paste test, failed in about one run in three. It focused the editor and fired a synthetic click, then pressed Backspace at once, so the focus's own selection change sometimes collapsed the picture's selection. A real click with a wait passes ten times out of ten, in Chromium and in Firefox. The test is fixed in `593a27d`.

## Results by section

### TY: typing

| cell | result by route |
|---|---|
| `TY.p.1` | click PASS |
| `TY.p.2` | click PASS |
| `TY.p.3` | click PASS |
| `TY.sp.1` | click PASS |
| `TY.sp.2` | click PASS |
| `TY.hb.1` | click PASS |
| `TY.bl.1` | click PASS |
| `TY.h.1` | click PASS |
| `TY.h.2` | click PASS |
| `TY.h.3` | click PASS |
| `TY.h.4` | click PASS |
| `TY.h.5` | click PASS |
| `TY.hr.1` | click rule PASS |
| `TY.q.1` | click PASS |
| `TY.q.2` | click PASS |
| `TY.q.3` | click PASS |
| `TY.qc.1` | click PASS |
| `TY.li.1` | click PASS |
| `TY.li.2` | click PASS |
| `TY.li.3` | click PASS |
| `TY.li.4` | click PASS |
| `TY.li.5` | click PASS |
| `TY.ol.1` | click PASS |
| `TY.ol.2` | click PASS |
| `TY.nl.1` | click PASS |
| `TY.nl.2` | click PASS |
| `TY.ql.1` | click PASS |
| `TY.ql.2` | click PASS |
| `TY.fc.1` | click PASS |
| `TY.fc.2` | click PASS |
| `TY.fu.1` | click PASS |
| `TY.mm.1` | click diagram PASS |
| `TY.tb.1` | click cell 1 PASS |
| `TY.tb.2` | click cell a PASS |
| `TY.ii.1` | click image PASS |
| `TY.cm.1` | click PASS |
| `TY.cm.2` | click PASS |
| `TY.cm.3` | click PASS |
| `TY.mk.1` | click PASS |
| `TY.mk.2` | click PASS |
| `TY.mk.3` | click PASS |
| `TY.mk.4` | click PASS |
| `TY.mk.5` | click PASS |
| `TY.lk.1` | click PASS |
| `TY.im.2` | click PASS |

### TC: typing makes a construct

| cell | result by route |
|---|---|
| `TC.h.1` | click PASS |
| `TC.h.2` | click PASS |
| `TC.li.1` | click PASS |
| `TC.ol.1` | click PASS |
| `TC.q.1` | click PASS |
| `TC.hr.1` | click PASS |
| `TC.fc.1` | click PASS |
| `TC.tb.1` | click PASS |

### EN: Enter

| cell | result by route |
|---|---|
| `EN.li.1` | click PASS |
| `EN.li.2` | click PASS |
| `EN.li.3` | click PASS |
| `EN.li.4` | click PASS |
| `EN.li.5` | click PASS |
| `EN.li.6` | click PASS |
| `EN.li.7` | click PASS |
| `EN.li.8` | click PASS |
| `EN.li.9` | click PASS |
| `EN.li.10` | click PASS |
| `EN.li.11` | click PASS |
| `EN.ol.1` | click PASS |
| `EN.ol.2` | click PASS |
| `EN.ol.3` | click PASS |
| `EN.ol.4` | click PASS |
| `EN.ol.5` | click PASS |
| `EN.tk.1` | click PASS |
| `EN.tk.2` | click PASS |
| `EN.tk.3` | click PASS |
| `EN.tk.4` | click PASS |
| `EN.li.12` | click PASS |
| `EN.nl.1` | click PASS |
| `EN.nl.2` | click PASS |
| `EN.nl.3` | click PASS |
| `EN.nl.4` | click PASS |
| `EN.ql.1` | click PASS |
| `EN.ql.2` | click PASS |
| `EN.ql.3` | click PASS |
| `EN.ql.4` | click PASS |
| `EN.q.1` | click PASS |
| `EN.q.2` | click PASS |
| `EN.q.3` | click PASS |
| `EN.q.4` | click PASS |
| `EN.q.5` | click PASS |
| `EN.q.6` | click PASS |
| `EN.qc.1` | click PASS |
| `EN.qc.2` | click PASS |
| `EN.p.1` | click PASS |
| `EN.p.2` | click PASS |
| `EN.p.3` | click PASS |
| `EN.p.4` | click PASS |
| `EN.p.5` | click PASS |
| `EN.p.6` | click PASS |
| `EN.sp.1` | click PASS |
| `EN.sp.2` | click PASS |
| `EN.sp.3` | click PASS |
| `EN.hb.1` | click PASS |
| `EN.bl.1` | click PASS |
| `EN.ii.1` | click PASS |
| `EN.cm.1` | click PASS |
| `EN.mk.1` | click PASS |
| `EN.lk.1` | click PASS |
| `EN.sel.1` | drag PASS |
| `EN.sel.2` | drag PASS |
| `EN.h.1` | click PASS |
| `EN.h.2` | click PASS |
| `EN.h.3` | click PASS |
| `EN.h.4` | click PASS |
| `EN.h.5` | click PASS |
| `EN.hr.1` | click PASS |
| `EN.hr.2` | click PASS |
| `EN.hr.3` | click PASS |
| `EN.fc.1` | click PASS |
| `EN.fc.2` | click PASS |
| `EN.fc.3` | click PASS |
| `EN.fc.4` | click PASS |
| `EN.fc.5` | click PASS |
| `EN.fc.6` | click PASS |
| `EN.fu.1` | click FAIL |
| `EN.mm.1` | click diagram PASS |
| `EN.tb.1` | click cell 1 PASS |
| `EN.tb.2` | click PASS |
| `EN.im.1` | click image PASS |

### SE: Shift+Enter

| cell | result by route |
|---|---|
| `SE.li.1` | click FAIL |
| `SE.q.1` | click PASS |
| `SE.p.1` | click PASS |
| `SE.h.1` | click PASS |
| `SE.fc.1` | click PASS |

### EB: Enter, then Backspace

| cell | result by route |
|---|---|
| `EB.p.1` | click PASS |
| `EB.p.2` | click PASS |
| `EB.p.3` | click PASS |
| `EB.p.4` | click PASS |
| `EB.p.5` | click PASS |
| `EB.p.6` | click PASS |
| `EB.p.7` | click PASS |
| `EB.li.1` | click PASS |
| `EB.li.2` | click PASS |
| `EB.ol.1` | click PASS |
| `EB.ol.2` | click PASS |
| `EB.nl.1` | click PASS |
| `EB.q.1` | click PASS |
| `EB.ql.1` | click PASS |
| `EB.h.1` | click PASS |
| `EB.hr.1` | click PASS |
| `EB.fc.1` | click PASS |
| `EB.tb.1` | click cell 1 PASS |
| `EB.bl.1` | click PASS |
| `EB.mk.1` | click PASS |
| `EB.hb.1` | click PASS |
| `EB.qc.1` | click PASS |
| `EB.sp.1` | click PASS |

### EF: end of file

| cell | result by route |
|---|---|
| `EF.1` | click below PASS |
| `EF.2` | click PASS |
| `EF.3` | click PASS |
| `EF.4` | click PASS |
| `EF.5` | click below PASS |
| `EF.6` | click below PASS |
| `EF.7` | click PASS |
| `EF.8` | click PASS |
| `EF.9` | click PASS |
| `EF.10` | click PASS |
| `EF.11` | click PASS |
| `EF.12` | click below PASS |
| `EF.13` | click PASS |
| `EF.14` | click below PASS |
| `EF.15` | click PASS |
| `EF.16` | click below PASS |
| `EF.17` | click below PASS |

### BS: Backspace

| cell | result by route |
|---|---|
| `BS.p.1` | click PASS |
| `BS.p.2` | click PASS |
| `BS.p.3` | click PASS |
| `BS.sp.1` | click PASS |
| `BS.hb.1` | click PASS |
| `BS.hb.2` | click PASS |
| `BS.h.1` | click PASS |
| `BS.h.2` | click PASS |
| `BS.h.3` | click PASS |
| `BS.h.4` | click PASS |
| `BS.hr.1` | click PASS |
| `BS.q.1` | click PASS |
| `BS.q.2` | click PASS |
| `BS.q.3` | click PASS |
| `BS.q.4` | click PASS |
| `BS.qc.1` | click PASS |
| `BS.li.1` | click PASS |
| `BS.li.2` | click PASS |
| `BS.li.3` | click PASS |
| `BS.li.4` | click PASS |
| `BS.li.5` | click PASS |
| `BS.ol.1` | click PASS |
| `BS.ol.2` | click PASS |
| `BS.tk.1` | click PASS |
| `BS.tk.2` | click PASS |
| `BS.nl.1` | click PASS |
| `BS.nl.2` | click PASS |
| `BS.nl.3` | click PASS |
| `BS.ql.1` | click PASS |
| `BS.ql.2` | click PASS |
| `BS.fc.1` | click PASS |
| `BS.fc.2` | click PASS |
| `BS.fc.3` | click PASS |
| `BS.fc.4` | click PASS |
| `BS.fu.1` | click PASS |
| `BS.mm.1` | click diagram PASS |
| `BS.tb.1` | click PASS |
| `BS.tb.2` | click cell 1 PASS |
| `BS.im.1` | click PASS |
| `BS.ii.1` | drag PASS |
| `BS.cm.1` | click PASS |
| `BS.cm.2` | click PASS |
| `BS.cm.3` | click PASS |
| `BS.cm.4` | click PASS |
| `BS.pad.1` | click PASS |
| `BS.pad.2` | click PASS |
| `BS.pad.3` | click FAIL |
| `BS.pad.4` | click FAIL |
| `BS.mk.1` | click PASS |
| `BS.mk.2` | click PASS |
| `BS.st.1` | click PASS |
| `BS.lk.1` | click PASS |
| `BS.sel.1` | drag PASS |
| `BS.sel.2` | drag PASS |
| `BS.sel.3` | drag PASS |
| `BS.sel.4` | drag PASS |

### BG: Backspace on an empty line

| cell | result by route |
|---|---|
| `BG.h-p` | click PASS, down PASS, up PASS, emptied PASS, left PASS, right PASS, cleared PASS, undone PASS, margin PASS, far PASS, gap PASS, remote PASS, remote-below PASS, reconnect PASS, resize PASS, refocus PASS, scrolled PASS |
| `BG.h6-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.hr-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.fc-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.mm-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.im-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.bl-p` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.bof-p` | click PASS, up PASS, emptied PASS |
| `BG.p-h` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-hr` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-q` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-li` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-ol` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-fc` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-mm` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-tb` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-im` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-bl` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-bl2` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-bl3` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-end` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.p-eof` | click PASS, down PASS, emptied PASS, right PASS, cleared PASS, undone PASS, margin PASS, far PASS, gap PASS, remote PASS, remote-below PASS, reconnect PASS, resize PASS, refocus PASS, scrolled PASS |
| `BG.p-eof2` | click PASS, down PASS, emptied PASS |
| `BG.li-li` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.ol-ol` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.nl-nl` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.q-q` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.h-h` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.fc-fc` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.tb-tb` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.fb-fb` | click PASS, down PASS, up PASS, emptied PASS, left PASS, right PASS, cleared PASS, undone PASS, margin PASS, far PASS, gap PASS, remote PASS, remote-below PASS, reconnect PASS, resize PASS, refocus PASS, scrolled PASS |
| `BG.ws.1` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.ws.2` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.ws.3` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.ws.4` | click PASS, down PASS, up PASS, emptied PASS |
| `BG.rep.1` | click PASS, down PASS, up PASS, emptied PASS |

### DL: Delete

| cell | result by route |
|---|---|
| `DL.p.1` | click PASS |
| `DL.p.2` | click PASS |
| `DL.p.3` | click PASS |
| `DL.sp.1` | click PASS |
| `DL.hb.1` | click red¦ PASS |
| `DL.hb.2` | click PASS |
| `DL.qc.1` | click PASS |
| `DL.hr.1` | click PASS |
| `DL.mm.1` | click PASS |
| `DL.im.1` | click PASS |
| `DL.ii.1` | click PASS |
| `DL.mk.1` | click PASS |
| `DL.lk.1` | click PASS |
| `DL.bl.2` | click PASS, up PASS |
| `DL.bl.3` | click PASS, down PASS, up PASS |
| `DL.bl.4` | click PASS, down PASS, up PASS |
| `DL.h.1` | click PASS |
| `DL.h.2` | click PASS |
| `DL.li.1` | click PASS |
| `DL.q.1` | click PASS |
| `DL.fc.1` | click PASS |
| `DL.tb.1` | click cell 1 PASS |
| `DL.cm.1` | click PASS |
| `DL.cm.2` | click PASS |
| `DL.pad.1` | click PASS |
| `DL.pad.2` | click red¦ PASS |
| `DL.sel.1` | drag PASS |
| `DL.eof.1` | click PASS |

### WB: word delete back

| cell | result by route |
|---|---|
| `WB.p.1` | click PASS |
| `WB.p.2` | click PASS |
| `WB.p.3` | click PASS |
| `WB.p.4` | click PASS |
| `WB.sp.1` | click PASS |
| `WB.h.1` | click PASS |
| `WB.li.1` | click PASS |
| `WB.mk.1` | click PASS |
| `WB.mk.2` | click PASS |
| `WB.lk.1` | click PASS |
| `WB.cm.1` | click PASS |
| `WB.hr.1` | click PASS |
| `WB.fc.1` | click PASS |

### WD: word delete forward

| cell | result by route |
|---|---|
| `WD.p.1` | click PASS |
| `WD.p.2` | click PASS |
| `WD.p.3` | click PASS |
| `WD.p.4` | click PASS |
| `WD.mk.1` | click PASS |

### CR: CRLF files

| cell | result by route |
|---|---|
| `CR.1b` | click PASS |
| `CR.2` | click PASS |
| `CR.3` | click PASS |
| `CR.4` | click PASS |
| `CR.5` | click PASS |
| `CR.6` | click PASS |

### TB: Tab

| cell | result by route |
|---|---|
| `TB.li.1` | click PASS |
| `TB.li.2` | click PASS |
| `TB.li.3` | click PASS |
| `TB.li.4` | click PASS |
| `TB.li.5` | click PASS |
| `TB.li.6` | click PASS |
| `TB.li.7` | click PASS |
| `TB.li.8` | drag PASS |
| `TB.ol.1` | click PASS |
| `TB.ol.2` | click PASS |
| `TB.ol.3` | click PASS |
| `TB.ql.1` | click PASS |
| `TB.en.1` | click PASS |
| `TB.p.1` | click PASS |
| `TB.p.2` | drag PASS |
| `TB.p.3` | click PASS |
| `TB.h.1` | click PASS |
| `TB.q.1` | click PASS |
| `TB.hr.1` | click PASS |
| `TB.bl.1` | click PASS |
| `TB.fc.1` | click PASS |
| `TB.fc.2` | click PASS |

### MV: moving

| cell | result by route |
|---|---|
| `MV.p.1` | click PASS |
| `MV.p.2` | click PASS |
| `MV.sp.1` | click PASS |
| `MV.li.1` | click PASS |
| `MV.li.2` | click PASS |
| `MV.li.3` | click PASS |
| `MV.h.1` | click PASS |
| `MV.q.1` | click PASS |
| `MV.hr.1` | click PASS |
| `MV.fc.1` | click PASS |
| `MV.lk.1` | click PASS |
| `MV.cm.1` | click PASS |
| `MV.cm.2` | click PASS |
| `MV.mk.1` | click PASS |
| `MV.im.1` | click PASS |
| `MV.tb.1` | click PASS |
| `MV.tb.2` | click PASS |
| `MV.tb.3` | click PASS |
| `MV.mm.1` | click PASS |
| `MV.mm.2` | click FAIL |
| `MV.av.1` | click PASS |
| `MV.av.2` | click PASS |
| `MV.av.3` | click PASS |
| `MV.av.4` | click PASS |
| `MV.av.5` | click PASS |
| `MV.av.6` | click PASS |
| `MV.av.7` | click PASS |
| `MV.av.8` | click PASS |
| `MV.av.9` | click PASS |
| `MV.av.10` | click PASS |
| `MV.av.11` | click PASS |
| `MV.sh.1` | click PASS |
| `MV.sh.2` | click PASS |
| `MV.sh.3` | click PASS |
| `MV.sh.4` | click PASS |
| `MV.cw.1` | click PASS |
| `MV.cw.2` | click PASS |
| `MV.cw.3` | click PASS |
| `MV.cw.4` | click PASS |
| `MV.cw.5` | click PASS |
| `MV.cw.6` | click PASS |
| `MV.cw.7` | click PASS |
| `MV.pad.1` | click PASS |
| `MV.pad.2` | click PASS |
| `MV.pad.3` | click PASS |
| `MV.pad.4` | click PASS |
| `MV.ce.1` | click PASS |
| `MV.ce.2` | click PASS |
| `MV.pg.1` | click PASS |
| `MV.esc.1` | click PASS |
| `MV.lg.1` | click FAIL |
| `MV.qc.1` | click PASS |
| `MV.hb.1` | click PASS |
| `MV.rtl.1` | click PASS |
| `MV.he.1` | click PASS |
| `MV.he.2` | click PASS |
| `MV.he.3` | click PASS |
| `MV.he.3b` | click PASS |
| `MV.he.4` | click PASS |
| `MV.he.5` | click PASS |
| `MV.he.6` | click PASS |
| `MV.he.7` | click PASS |
| `MV.he.8` | click PASS |
| `MV.he.9` | click PASS |
| `MV.he.10` | click PASS |
| `MV.he.11` | click PASS |
| `MV.he.12` | click PASS |
| `MV.he.13` | click FAIL |
| `MV.he.14` | click FAIL |

### WK: walking the caret

| cell | result by route |
|---|---|
| `WK.1` | click PASS |
| `WK.2` | click PASS |
| `WK.3` | click PASS |
| `WK.4` | click PASS |
| `WK.5` | click PASS |
| `WK.6` | click PASS |
| `WK.7` | click PASS |

### RD: another client reads

| cell | result by route |
|---|---|
| `RD.1` | click PASS |
| `RD.2` | click PASS |
| `RD.3` | click PASS |
| `RD.4` | click PASS |
| `RD.5` | click PASS |
| `RD.6` | click PASS |

### CK: click

| cell | result by route |
|---|---|
| `CK.p.1` | click PASS |
| `CK.mk.1` | click PASS |
| `CK.mk.2` | click PASS |
| `CK.mk.3` | click PASS |
| `CK.mk.4` | click PASS |
| `CK.it.1` | click PASS |
| `CK.co.1` | click PASS |
| `CK.lk.1` | click PASS |
| `CK.h.1` | click PASS |
| `CK.h.2` | click PASS |
| `CK.li.1` | click PASS |
| `CK.li.2` | click PASS |
| `CK.ol.1` | click PASS |
| `CK.q.1` | click PASS |
| `CK.q.2` | click PASS |
| `CK.sp.1` | click PASS |
| `CK.sp.2` | click PASS |
| `CK.hb.1` | click PASS |
| `CK.bl.1` | click PASS |
| `CK.hr.1` | click PASS |
| `CK.tb.1` | click PASS |
| `CK.tb.2` | click PASS |
| `CK.im.1` | click PASS |
| `CK.mm.1` | click PASS |
| `CK.fc.1` | click PASS |
| `CK.cm.1` | click PASS |
| `CK.nl.1` | click PASS |
| `CK.ql.1` | click PASS |
| `CK.ii.1` | click PASS |
| `CK.sh.1` | click PASS |
| `CK.sh.2` | click PASS |
| `CK.tab.1` | click PASS |
| `CK.mid.1` | drag PASS |
| `CK.eof.1` | click PASS |
| `CK.eof.2` | click PASS |
| `CK.wr.1` | click PASS |
| `CK.ac.1` | click PASS |
| `CK.ac.2` | click PASS |

### DC: double-click

| cell | result by route |
|---|---|
| `DC.p.1` | click@30 PASS, click@250 PASS |
| `DC.mk.1` | click@30 PASS, click@250 PASS |
| `DC.mk.2` | click@30 PASS, click@250 PASS |
| `DC.mk.3` | click@30 PASS, click@250 PASS |
| `DC.mk.4` | click@30 PASS, click@250 PASS |
| `DC.it.1` | click@30 PASS, click@250 PASS |
| `DC.it.2` | click@30 PASS, click@250 PASS |
| `DC.co.1` | click@30 PASS, click@250 PASS |
| `DC.lk.1` | click@30 PASS, click@250 PASS |
| `DC.lk.2` | click@30 PASS, click@250 PASS |
| `DC.h.1` | click@30 PASS, click@250 PASS |
| `DC.li.1` | click@30 PASS, click@250 PASS |
| `DC.q.1` | click@30 PASS, click@250 PASS |
| `DC.cm.1` | click@30 PASS, click@250 PASS |
| `DC.st.1` | click@30 PASS, click@250 PASS |
| `DC.p.2` | click@30 PASS, click@250 PASS |
| `DC.p.3` | click@30 PASS, click@250 PASS |
| `DC.p.4` | click@30 PASS, click@250 PASS |
| `DC.p.5` | click@30 PASS, click@250 PASS |
| `DC.sp.1` | click@30 PASS, click@250 PASS |
| `DC.fc.1` | click@30 PASS, click@250 PASS |
| `DC.tb.1` | click@30 PASS, click@250 PASS |

### T3: triple-click

| cell | result by route |
|---|---|
| `T3.p.1` | click@30 PASS, click@250 PASS |
| `T3.h.1` | click@30 PASS, click@250 PASS |
| `T3.li.1` | click@30 PASS, click@250 PASS |
| `T3.li.2` | click@30 PASS, click@250 PASS |
| `T3.fc.1` | click@30 PASS, click@250 PASS |
| `T3.sp.1` | click@30 PASS, click@250 PASS |
| `T3.q.1` | click@30 PASS, click@250 PASS |
| `T3.ac.1` | click@30 PASS, click@250 PASS |

### DG: drag

| cell | result by route |
|---|---|
| `DG.p.1` | click PASS |
| `DG.p.2` | click PASS |
| `DG.mk.1` | click PASS |
| `DG.x.1` | click PASS |
| `DG.x.2` | click PASS |

### DD: drop

| cell | result by route |
|---|---|
| `DD.1` | drag PASS |

### SX: selections

| cell | result by route |
|---|---|
| `SX.1` | drag PASS |
| `SX.2` | drag PASS |
| `SX.3` | drag PASS |
| `SX.4` | drag PASS |
| `SX.5` | drag PASS |
| `SX.6` | drag PASS |
| `SX.7` | click PASS |
| `SX.8` | click PASS |
| `SX.9` | click PASS |
| `SX.10` | drag PASS |
| `SX.11` | click PASS |
| `SX.12` | click PASS |

### CB: clipboard

| cell | result by route |
|---|---|
| `CB.1` | drag PASS |
| `CB.2` | drag PASS |
| `CB.3` | drag PASS |
| `CB.4` | drag PASS |
| `CB.5` | drag PASS |

### UR: undo and redo

| cell | result by route |
|---|---|
| `UR.1` | click PASS |
| `UR.2` | click PASS |
| `UR.3` | click PASS |
| `UR.4` | click PASS |
| `UR.5` | click PASS |
| `UR.6c` | click PASS |
| `UR.7` | drag PASS |
| `UR.8` | click PASS |
| `UR.9` | click PASS |
| `UR.10` | click PASS |
| `UR.11` | click PASS |
| `UR.g.1` | click PASS |
| `UR.g.2` | click PASS |
| `UR.g.3` | click PASS |
| `UR.g.4` | click PASS |
| `UR.g.5` | drag PASS |
| `UR.g.6` | click PASS |

### IM: composition

| cell | result by route |
|---|---|
| `IM.1` | click PASS |
| `IM.3` | click PASS |

### MS: several sessions

| cell | result by route |
|---|---|
| `MS.1` | click PASS |
| `MS.2` | click PASS |
| `MS.3` | click PASS |
| `MS.4` | click PASS |
| `MS.5` | click PASS |
| `MS.6` | click PASS |
| `MS.7` | click PASS |
| `MS.8` | click PASS |
| `MS.9` | click PASS |
| `MS.10` | click PASS |
| `MS.11` | click PASS |
| `MS.12` | click PASS |
| `MS.13` | click PASS |
| `MS.14` | click PASS |
| `MS.15` | click PASS |
| `MS.16` | click PASS |

## Runs that do not pass

### EN.fu.1 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 302.4 y 89.2, but the caret was drawn at x 302.4 y 62.8
```

### SE.li.1 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 324.5 y 62.8, but the caret was drawn at x 302.4 y 62.8
```

### BS.pad.3 by click

```text
click: FAIL
  I1 bytes: wanted "- alphatwo\n", got "- alpha\ntwo\n"
  I2 caret: wanted 7, got 8 at div.md-line.md-raw.md-li[0-11] > span.md-p[8-11] > #text:0
  I3 drawn: caret at x 377.4 y 36.5, boundary at x 373.1 y 28.0-45.0
  I9 probe: Q wanted "- alphaQtwo\n", got "- alpha\nQtwo\n"
```

### BS.pad.4 by click

```text
click: FAIL
  I1 bytes: wanted "> alphatwo\n", got "> alpha\ntwo\n"
  I2 caret: wanted 7, got 8 at div.md-line.md-raw.md-quote[0-11] > span.md-p[8-11] > #text:0
  I3 drawn: caret at x 370.6 y 36.5, boundary at x 365.9 y 28.0-45.0
  I9 probe: Q wanted "> alphaQtwo\n", got "> alpha\nQtwo\n"
```

### MV.mm.2 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 315.3 y 36.5, but the caret was drawn at x 302.4 y 76.0
  I9 probe: Q wanted "x\n\nQ```mermaid\nA-->B\n```\ntwo\n", got "x\nQ```mermaid\nA-->B\n```\ntwo\n"
```

### MV.lg.1 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 302.4 y 62.8, but the caret was drawn at x 806.5 y 36.5
```

### MV.he.13 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 302.4 y 194.6, but the caret was drawn at x 777.3 y 168.2
```

### MV.he.14 by click

```text
click: FAIL
  I12 typed: the Q is drawn at x 302.4 y 352.6, but the caret was drawn at x 777.3 y 326.3
```
