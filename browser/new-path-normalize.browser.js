import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 96wy2aby: the hub normalizes a new document's path to lowercase and dashes, and leaves
// a document already stored on its path. Each test is one acceptance criterion in that ticket's
// body, the hub's list and QA's. The bytes are read back only through GET /raw and the CLI.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const run = (hub, args, input = "") => cli(hub.port, ["--user", AGENT, "--repo", REPO, ...args], input);

async function listed(hub) {
  const out = await run(hub, ["list"]);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.split("\n").filter(Boolean);
}

function getRaw(port, address) {
  const rel = address.split("/").map(encodeURIComponent).join("/");
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `/raw/${REPO}/${rel}`, method: "GET", headers: { Connection: "close" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup(t) {
  const hub = await startHub();
  const ctx = { hub, browser: null };
  t.after(async () => {
    if (ctx.browser) await ctx.browser.close();
    await hub.close();
  });
  return ctx;
}

async function openPage(ctx, file) {
  ctx.browser = await launchBrowser();
  const page = new Page(ctx.browser.session, ctx.hub.port);
  await page.init();
  await page.login(USER);
  await page.open(file);
  return page;
}

// The person presses New file, types a name, and presses Enter.
async function newFile(page, name) {
  const at = await page.eval(`(() => { const r = document.querySelector("button.md-new-file").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`!!document.activeElement && document.activeElement.classList.contains("md-new-name")`), "the name field");
  await page.type(name);
  await page.key("Enter");
}

const drawerPaths = (page) => page.eval(`[...document.querySelectorAll(".file-block button.md-file")].map((b) => b.dataset.path)`);

// ---- The hub's list --------------------------------------------------------------------------

test("96wy2aby: create of Test Page stores test-page.md, and the command prints that path", async (t) => {
  const { hub } = await setup(t);
  const out = await run(hub, ["create", "Test Page"], "Body.\n");
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout.trim(), "test-page.md");
  assert.deepEqual(await listed(hub), ["test-page.md"]);
  assert.equal((await hub.show("test-page.md")).text, "Body.\n");
});

test("96wy2aby: create --json of Test Page prints the stored path and rev 0", async (t) => {
  const { hub } = await setup(t);
  const out = await run(hub, ["--json", "create", "Test Page"], "Body.\n");
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { path: "test-page.md", rev: 0 });
});

for (const [typed, stored] of [["Plan (draft).md", "plan-draft.md"], ["notes/My Notes", "notes/my-notes.md"], ["Äpfel.md", "äpfel.md"]]) {
  test(`96wy2aby: create of ${JSON.stringify(typed)} stores ${JSON.stringify(stored)}`, async (t) => {
    const { hub } = await setup(t);
    const out = await run(hub, ["create", typed], "Body.\n");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), stored);
    assert.deepEqual(await listed(hub), [stored]);
  });
}

test("96wy2aby: a second create that normalizes to a stored path exits 409 and writes nothing", async (t) => {
  const { hub } = await setup(t);
  assert.equal((await run(hub, ["create", "test-page.md"], "Keep.\n")).code, 0);
  const out = await run(hub, ["create", "Test Page"], "New.\n");
  assert.equal(out.code, 153, `exit ${out.code}: ${out.stderr}`);
  assert.deepEqual(await listed(hub), ["test-page.md"]);
  assert.equal((await hub.show("test-page.md")).text, "Keep.\n");
});

for (const name of ["!!!", "tickets/Hello"]) {
  test(`96wy2aby: create of ${JSON.stringify(name)} exits 400 and writes nothing`, async (t) => {
    const { hub } = await setup(t);
    const out = await run(hub, ["create", name], "Body.\n");
    assert.equal(out.code, 144, `exit ${out.code}: ${out.stderr}`);
    assert.deepEqual(await listed(hub), []);
  });
}

test("96wy2aby: a document already stored as Test Page.md keeps that path, and opening it does not rename it", async (t) => {
  const ctx = await setup(t);
  ctx.hub.plant("Test Page.md", "Body.\n");
  const page = await openPage(ctx, "Test Page.md");
  await page.quiet();
  assert.deepEqual(await listed(ctx.hub), ["Test Page.md"]);
  assert.equal((await ctx.hub.show("Test Page.md")).text, "Body.\n");
  assert.ok((await page.eval("location.hash")).endsWith(`/doc/${encodeURIComponent("Test Page.md")}`));
});

test("96wy2aby: the files pane labels test-page.md with its heading, and a document with no title line with its filename", async (t) => {
  const ctx = await setup(t);
  await ctx.hub.create("test-page.md", "# Test Page\n\nBody.\n");
  await ctx.hub.create("no-title.md", "Body only.\n");
  const page = await openPage(ctx, "no-title.md");
  const labels = await page.eval(`Object.fromEntries([...document.querySelectorAll(".file-block button.md-file")].map((b) => [b.dataset.path, b.textContent.trim()]))`);
  assert.equal(labels["test-page.md"], "Test Page");
  assert.equal(labels["no-title.md"], "no-title.md");
});

// ---- QA's, on the page -----------------------------------------------------------------------

test("96wy2aby: on the page, New file with Test Page opens test-page.md, the drawer lists it, and a pasted picture is served from test-page/", async (t) => {
  const ctx = await setup(t);
  await ctx.hub.create("start.md", "Start.\n");
  const page = await openPage(ctx, "start.md");
  await newFile(page, "Test Page");
  await page.until(() => page.eval(`location.hash.endsWith("/doc/test-page.md")`), "test-page.md open");
  await page.quiet();
  await page.until(async () => (await drawerPaths(page)).includes("test-page.md"), "test-page.md in the drawer");
  const paths = await drawerPaths(page);
  assert.ok(!paths.includes("Test Page.md"), `the drawer lists ${JSON.stringify(paths)}`);
  assert.deepEqual(await listed(ctx.hub), ["start.md", "test-page.md"]);
  // A click puts the caret in the empty document first (ticket 5febwdbd).
  const box = await page.eval(`(() => { const r = document.getElementById("editor").getBoundingClientRect(); return { x: r.left + 200, y: r.top + 40 }; })()`);
  await page.click(box.x, box.y);
  await page.quiet();
  const b64 = PNG.toString("base64");
  await page.eval(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) raw[i] = bin.charCodeAt(i);
    const data = new DataTransfer();
    data.items.add(new File([raw], "shot", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.getElementById("editor").dispatchEvent(event);
    return true;
  })()`);
  let address = null;
  await page.until(async () => {
    address = /!\[[^\]]*\]\((test-page\/[^)]+)\)/.exec((await ctx.hub.show("test-page.md")).text)?.[1] || null;
    return address;
  }, "the image line in test-page.md");
  assert.equal(await getRaw(ctx.hub.port, address), 200);
});

test("96wy2aby: on the page, New file with a name that normalizes to a stored document writes nothing", async (t) => {
  const ctx = await setup(t);
  await ctx.hub.create("test-page.md", "Keep.\n");
  const page = await openPage(ctx, "test-page.md");
  const before = await ctx.hub.show("test-page.md");
  await newFile(page, "Test Page");
  await sleep(1500);
  const after = await ctx.hub.show("test-page.md");
  assert.equal(after.text, "Keep.\n");
  assert.equal(after.rev, before.rev);
  assert.deepEqual(await listed(ctx.hub), ["test-page.md"]);
  const notice = await page.eval(`(document.querySelector(".md-notice") || {}).textContent || null`);
  t.diagnostic(`notice after the refused create: ${JSON.stringify(notice)}`);
});
