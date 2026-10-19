import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, launchBrowser, Page, startHub } from "./harness.js";

// Ticket f6bgnkwh: the hub's 400 on New file is the no-repo refusal only while the
// selector is blank. A file the hub opens, and a 400 or 409 once a repo is chosen,
// are not that refusal.

const NOTICE = "a repo has to be chosen first";

async function setup(t) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login(USER);
  await page.until(() => page.eval(`(() => {
    const select = document.querySelector("select.md-repo");
    if (!select || select.value !== "") return false;
    return [...select.options].some((option) => option.value === ${JSON.stringify(REPO)});
  })()`), "a blank repo selector");
  return { hub, page };
}

async function chooseRepo(page) {
  const since = page.frames.length;
  const value = await page.eval(`(() => {
    const select = document.querySelector("select.md-repo");
    select.value = ${JSON.stringify(REPO)};
    select.dispatchEvent(new Event("change"));
    return select.value;
  })()`);
  assert.equal(value, REPO);
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "out" && frame.data && frame.data.type === "repo" && frame.data.name === REPO), "the repo frame");
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "docs"), "the file list");
  await page.quiet();
}

async function newFile(page, name) {
  await page.until(() => page.eval(`(() => {
    const button = document.querySelector("button.md-new-file");
    if (!button) return false;
    const r = button.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`), "the New file button");
  const at = await page.eval(`(() => { const r = document.querySelector("button.md-new-file").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`!!document.activeElement && document.activeElement.classList.contains("md-new-name")`), "the name field");
  await page.type(name);
  await page.key("Enter");
}

function notice(page) {
  return page.eval(`(document.querySelector(".md-notice") || {}).textContent || ""`);
}

function incoming(page, since, status) {
  return page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "error" && frame.data.status === status);
}

function sentCreate(page, since) {
  const frames = page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "create");
  return frames.length ? frames[frames.length - 1].data.path : "";
}

const drawerPaths = (page) => page.eval(`[...document.querySelectorAll(".file-block button.md-file")].map((b) => b.dataset.path)`);

// The hub answers, and the page stays quiet about it.
async function refused(page, name, path, status) {
  const since = page.frames.length;
  await newFile(page, name);
  await page.until(() => incoming(page, since, status), `create ${status}`);
  const atAnswer = await notice(page);
  await page.quiet();
  assert.equal(sentCreate(page, since), path);
  assert.equal(atAnswer, "");
  assert.equal(await notice(page), "");
}

test("f6bgnkwh: New file with no repo chosen shows that a repo has to be chosen first", async (t) => {
  const { hub, page } = await setup(t);
  const since = page.frames.length;
  await newFile(page, "Release notes");
  await page.until(async () => {
    const shown = await page.eval(`(() => {
      const el = document.querySelector(".md-notice");
      return !!el && el.getAttribute("role") === "status" && el.textContent === ${JSON.stringify(NOTICE)};
    })()`);
    return shown && incoming(page, since, 400);
  }, NOTICE, 1000);
  assert.equal(sentCreate(page, since), "Release notes.md");
  assert.equal(await page.eval(`(() => {
    const field = document.querySelector(".md-new-name");
    return !!field && field.hidden && field.value === "";
  })()`), true);
  assert.equal(await page.eval("location.hash"), "");
  assert.equal(await page.eval(`document.querySelector("select.md-repo").value`), "");
  assert.deepEqual(await drawerPaths(page), []);
  await assert.rejects(() => hub.show("Release notes.md"));
  await assert.rejects(() => hub.show("release-notes.md"));
});

test("f6bgnkwh: a created file still opens and does not show the repo notice", async (t) => {
  const { hub, page } = await setup(t);
  await chooseRepo(page);
  const since = page.frames.length;
  await newFile(page, "Release notes");
  await page.until(() => page.eval(`location.hash.endsWith("/doc/release-notes.md")`), "release-notes.md open");
  await page.quiet();
  assert.equal(await notice(page), "");
  assert.equal(page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "error"), false);
  assert.equal((await hub.show("release-notes.md")).text, "");
  assert.deepEqual(await drawerPaths(page), ["release-notes.md"]);
});

test("f6bgnkwh: a create refusal after a repo is chosen is not the repo notice", async (t) => {
  const { hub, page } = await setup(t);
  // Two directories that normalize to one segment are a create 409. A name that
  // normalizes to nothing is a create 400. Neither is the blank-selector notice.
  hub.plant("Notes/keep.md", "Keep.\n");
  hub.plant("notes-/other.md", "Other.\n");
  await chooseRepo(page);
  const hash = await page.eval("location.hash");
  await refused(page, "!!!", "!!!.md", 400);
  await refused(page, "notes/page", "notes/page.md", 409);
  assert.equal(await page.eval("location.hash"), hash);
  assert.equal(await notice(page), "");
  await assert.rejects(() => hub.show("!!!.md"));
  await assert.rejects(() => hub.show("notes/page.md"));
  assert.equal((await hub.show("Notes/keep.md")).text, "Keep.\n");
  assert.equal((await hub.show("notes-/other.md")).text, "Other.\n");
});
