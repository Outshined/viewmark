# Browser tests: how to run them
The browser tests run the editing matrix of `qa/editor-matrix-test-plan.md` in Firefox:
- The keys and the mouse are real input events, sent through the browser's remote protocol.
- Each result is checked against the bytes a hub holds.
- The tests live in `browser/` in the viewmark source tree.
- Plain `node --test` does not run them.
- Eight of the files are the matrix suites, listed under Who acts in a cell. The others test one feature each, such as `browser/comments.browser.js` or `browser/two-tabs.browser.js`. They do not read the plan, and they run and report the same way.

## What you need
- **Node.** There are no packages to install.
- **Firefox.** It runs inside cage, a compositor with a headless backend, when cage is installed, and with `--headless` otherwise, so your screen and clipboard are not touched.
- **The viewmark hub, running.** At the start of every run, the tests read their cells from `qa/editor-matrix-test-plan.md` in the `viewmark` repo, through `node cli.js show`. The hub is expected on port 8765; `VIEWMARK_PLAN_PORT` names another port. If the hub cannot be reached, the suite stops at once and says so.
- **A display**, only when you want to watch (`VIEWMARK_HEADED=1`).

## Your data is not touched
Every suite starts a hub of its own, as a separate process, with a small proxy in front of it:

```text
node cli.js --port 0 serve <new temporary directory>
```

- **What runs there.**
  - It registers a temporary repo named `qa`, and every document a cell creates or edits lives on that hub.
  - The browser pages connect through the proxy, so a cell can drop their sockets the way a network would.
  - The suite refuses to run if the hub or the proxy came up on the live hub's port.
- **What it touches on yours.** The live hub is only read, to fetch the plan.
- **Cleanup.** When the suite ends, it stops its hub and deletes the state directory, the repo directory, and the browser profile.

## Running
```text
node --test browser/*.browser.js                         every suite
node --test --test-concurrency=3 browser/*.browser.js    three suites at a time, about ten minutes
node --test browser/empty-line.browser.js                one suite
node --test --test-name-pattern='^BG\.p-bl$' browser/empty-line.browser.js
                                                         one cell, with every route it has
node --test --test-name-pattern='^DL\.' browser/delete.browser.js
                                                         every cell whose id starts with DL.
```

Each suite has its own hub and its own browser, so suites can run side by side. Every cell starts from a fresh page load, so one cell that wedges the page cannot fail the next. The browser window is 1920 by 1080.

## Who acts in a cell
- **Page A** is logged in as `qa-bot` and holds the caret marked in the cell's source.
- **Page B** is a second tab, logged in as `qa-two`. It is opened only for cells that use it, those whose keys start with `B:`. It opens the same file once A's caret is placed.
- **The agent** is the CLI, run as `qa-cli`. It reads the file with `show`, then makes its change with `edit` or `comment add`, as an agent would. `read` has it only read.
- **`reconnect`** drops page A's socket at the proxy. The cell then waits for the page to retry and be sent the file again.

| suite file | sections |
|---|---|
| `browser/empty-line.browser.js` | BG |
| `browser/typing.browser.js` | TY, TC |
| `browser/enter.browser.js` | EN, SE, EB, EF |
| `browser/delete.browser.js` | BS, DL, WB, WD, CR |
| `browser/tab-move.browser.js` | TB, MV, RD, WK |
| `browser/pointer.browser.js` | CK, DC, T3, DG, DD |
| `browser/selection.browser.js` | SX, CB, UR, IM |
| `browser/sessions.browser.js` | MS: a second person, an agent, and a dropped socket |

## Settings
- `VIEWMARK_HEADED=1`: show the browser window, so you can watch the cells run.
- `VIEWMARK_KEEP_PROFILE=1`: keep the browser profile directory after the run.
- `VIEWMARK_FIREFOX`: the Firefox binary, `firefox` by default.
- `VIEWMARK_CAGE`: the cage binary, `cage` by default.
- `VIEWMARK_PLAN_PORT`: the port of the hub that holds the plan.
- `VIEWMARK_QA_RESULTS=DIR`: write each suite's results to `DIR/<suite>.json`.
- `VIEWMARK_PORT`: the live hub's port, 8765 by default. The test hub must not come up on it.

## Reading the output
Each cell is a test, and each route it runs by is a subtest. The routes are:
- `click`, `down` (↓), `up` (↑), `emptied`, and `drag`;
- for the wide `BG` cells, named in `WIDE` in `browser/run.js`, also:
  - `left` and `right`;
  - `cleared` (the line held `xyz`, triple-clicked and deleted), and `undone` (typed `x`, then Ctrl+Z);
  - `margin`, `far`, and `gap` (clicks beside the line, at the editor's right edge, and on the line's top pixel);
  - `remote` and `remote-below` (the agent adds text above or below first);
  - `reconnect`, `resize`, `refocus`, and `scrolled`;
- a named click from the plan, such as `click image`;
- `click@30` and `click@250` for double-clicks and triple-clicks, the gap between presses in milliseconds.

A subtest ends in one of four ways:
- **pass**: every check held.
- **fail**: the message lists each check that failed:
  - `I1 bytes`: the hub's bytes;
  - `I2 caret`: where the selection maps, with its DOM node;
  - `I3 drawn`: where the caret is drawn;
  - `I5 rev`: how far the rev moved;
  - `I7 quiet`: an error frame, such as a 409;
  - `I9 probe`: where a typed `Q`, and the Backspace after it, landed;
  - `focus`: the editor lost focus.
- **route fail**: the message starts `<cell>/route <route>: placement`. The caret did not reach the cell's starting place. The message also says what the cell's keys did from wherever it was.
- **skipped**, for one of three reasons:
  - the cell is not automated yet;
  - the route cannot exist for that cell, such as an agent's insertion into text the page holds, which the hub rightly refuses;
  - the browser would not do what the cell asks, such as starting a drag.

With `VIEWMARK_QA_RESULTS`, each suite writes one JSON object per run of a cell. It holds `id`, `route`, `status`, `failed` (the same lines as the messages), and `observed`. `observed` has the bytes, the caret, the drawn rect, and the frames the page sent. A failing run also has the editor's `outerHTML`.

- **Where the bytes come from.** The bytes checked are the ones the hub last sent the page, in its `doc` and `file` messages. The harness reads the hub itself only once, at the end of each cell, because a second client opening the file makes the page redraw.
- **When a key is done.** After each key or click, the harness first waits until every edit the page sent has been answered, for at most 2 seconds. Then it waits for two animation frames and 100 ms with no socket traffic.
- **Screenshots.** To check where the caret is painted (I3), the harness takes screenshots of the caret's line and reads them in memory. It does not save them. Firefox leaves the caret out of its screenshots, so in Firefox that check is reported as not done.

## Changing the cells
The plan in the hub is the only copy of the cells. Edit a cell there, and the next run uses it; the source tree keeps no copy. A cell is a line in the plan's notation, inside a `text` fence in the plan. A cell placed outside a fence would be read as markdown, which the dialect mangles: it reads comment markers even inside code spans.

## How the harness is put together
- `browser/harness.js`:
  - starts the test hub and Firefox;
  - speaks the DevTools protocol over Node's built-in `WebSocket`;
  - drives the page: keys, clicks, drags, and waiting for quiet;
  - installs a passive script that answers geometry questions and records `keydown`, `beforeinput`, and `selectionchange`.
- `browser/cells.js`: reads the plan from the hub, and decodes each cell's source, keys, and expectation.
- `browser/run.js`: places the caret by a route, presses the keys, and runs the checks.
- `browser/matrix.js`: one suite. Its own hub and browser, and the cells for its section prefixes.
- `browser/*.browser.js`: one line each, naming a suite and its prefixes.

## Known gaps
- **Checks not done.** The plan's I6 (undo), I8 (reload), and I11 (late re-render) are not checked. I3 is checked only for a collapsed caret, and not in Firefox.
- **Passes not done.** P2 to P5 (undo, probe, burst, latency) are not separate passes yet. The probe runs inside P1.
- **Glyph widths.** No cell's answer depends on glyph widths: the plan writes those as exact positions or as which line or block the caret is on.
