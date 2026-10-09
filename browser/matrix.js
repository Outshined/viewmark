import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchBrowser, OTHER, Page, startHub, startProxy } from "./harness.js";
import { loadCells } from "./cells.js";
import { routesFor, runCell } from "./run.js";

// One suite: its own test hub process, a proxy in front of it, its own browser, and the plan's
// cells whose ids start with one of the prefixes. A second page, logged in as another user, is
// opened only when a cell needs it. VIEWMARK_QA_RESULTS names a directory for <name>.json.
export function defineSuite(name, prefixes) {
  const cells = loadCells("").filter((cell) => prefixes.some((prefix) => cell.id.startsWith(prefix)));
  const results = [];
  const suite = {};
  let otherPage = null;
  let serial = 0;

  before(async () => {
    suite.hub = await startHub();
    suite.proxy = await startProxy(suite.hub.port);
    suite.browser = await launchBrowser();
    suite.page = new Page(suite.browser.session, suite.proxy.port);
    await suite.page.init();
    await suite.page.login();
    suite.hasOther = () => otherPage != null;
    suite.other = async () => {
      if (!otherPage) {
        const { session } = await suite.browser.newSession();
        otherPage = new Page(session, suite.proxy.port);
        await otherPage.init();
        await otherPage.login(OTHER);
      }
      return otherPage;
    };
  });

  after(async () => {
    if (process.env.VIEWMARK_QA_RESULTS) {
      mkdirSync(process.env.VIEWMARK_QA_RESULTS, { recursive: true });
      writeFileSync(path.join(process.env.VIEWMARK_QA_RESULTS, `${name}.json`), JSON.stringify(results, null, 2));
    }
    if (suite.browser) await suite.browser.close();
    if (suite.proxy) await suite.proxy.close();
    if (suite.hub) await suite.hub.close();
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
          const result = await runCell(suite, cell, route, serial);
          results.push(result);
          if (result.routeFailed) throw new Error(`${cell.id}/route ${route}: ${result.failed.join("; ")}`);
          if (result.status === "BLOCKED") sub.skip(result.failed.join("; "));
          else if (result.status === "FAIL") throw new Error(result.failed.join("\n"));
        });
      }
    });
  }
}
