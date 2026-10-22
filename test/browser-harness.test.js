import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER, launchBrowser, supports } from "../browser/harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the harness drives Firefox and does not read a painted caret", () => {
  assert.equal(BROWSER, "firefox");
  assert.equal(supports("paint"), false);
  assert.equal(supports("drag"), false);
  assert.equal(supports("ime"), false);
  assert.equal(supports("fonts"), false);
  assert.equal(supports("keys"), true);
  assert.match(String(launchBrowser), /launchFirefox/);
  assert.doesNotMatch(String(launchBrowser), /chromium/i);
});

test("VIEWMARK_BROWSER does not select another browser", () => {
  const href = pathToFileURL(path.join(root, "browser/harness.js")).href;
  const script = `import { BROWSER, supports } from ${JSON.stringify(href)}; if (BROWSER !== "firefox" || supports("paint") !== false) process.exit(1);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, VIEWMARK_BROWSER: "chromium", VIEWMARK_CHROMIUM: "/usr/bin/chromium" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
