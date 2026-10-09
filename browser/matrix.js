import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchBrowser, Page, startHub } from "./harness.js";
import { loadCells } from "./cells.js";
import { routesFor, runCell } from "./run.js";

// One suite: its own test hub process, its own browser, and the plan's cells whose ids start
// with one of the prefixes. VIEWMARK_QA_RESULTS names a directory for <name>.json.
export function defineSuite(name, prefixes) {
  const cells = loadCells("").filter((cell) => prefixes.some((prefix) => cell.id.startsWith(prefix)));
  const results = [];
  let hub;
  let browser;
  let page;
  let serial = 0;

  before(async () => {
    hub = await startHub();
    browser = await launchBrowser();
    page = new Page(browser.session, hub.port);
    await page.init();
    await page.login();
  });

  after(async () => {
    if (process.env.VIEWMARK_QA_RESULTS) {
      mkdirSync(process.env.VIEWMARK_QA_RESULTS, { recursive: true });
      writeFileSync(path.join(process.env.VIEWMARK_QA_RESULTS, `${name}.json`), JSON.stringify(results, null, 2));
    }
    if (browser) await browser.close();
    if (hub) await hub.close();
  });

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
}
