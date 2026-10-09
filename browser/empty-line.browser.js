import { after, before, test } from "node:test";
import { writeFileSync } from "node:fs";
import { launchBrowser, Page, startHub } from "./harness.js";
import { loadCells } from "./cells.js";
import { routesFor, runCell } from "./run.js";

// BG: Backspace on an empty line, every cell by every route.
const cells = loadCells("BG.");
const results = [];
let hub;
let browser;
let page;

before(async () => {
  hub = await startHub();
  browser = await launchBrowser();
  page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
});

after(async () => {
  if (process.env.VIEWMARK_QA_RESULTS) writeFileSync(process.env.VIEWMARK_QA_RESULTS, JSON.stringify(results, null, 2));
  if (browser) await browser.close();
  if (hub) await hub.close();
});

let serial = 0;
for (const cell of cells) {
  test(cell.id, async (t) => {
    if (cell.prose) {
      results.push({ id: cell.id, route: "-", status: "BLOCKED", failed: ["prose cell, not automated yet"] });
      t.skip("prose cell, not automated yet");
      return;
    }
    for (const route of routesFor(cell)) {
      await t.test(route, async (sub) => {
        serial += 1;
        const result = await runCell({ hub, page }, cell, route, serial);
        results.push(result);
        if (result.routeFailed) throw new Error(`${cell.id}/route ${route}: ${result.failed.join("; ")}`);
        if (result.status === "BLOCKED") sub.skip(result.failed.join("; "));
        else if (result.status === "FAIL") throw new Error(result.failed.join("\n"));
      });
    }
  });
}
