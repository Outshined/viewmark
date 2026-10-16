import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 7qkzmvut: when the ticket drawer narrows after the pointer leaves it, the document was
// drawn over it while it was still wide. Each test is one acceptance criterion in that ticket's
// body. The page is sampled on every animation frame, at a 6 by 6 grid over the drawer's box.

async function setup(t) {
  const hub = await startHub();
  const ctx = { hub, browser: null };
  t.after(async () => {
    if (ctx.browser) await ctx.browser.close();
    await hub.close();
  });
  for (let i = 0; i < 8; i += 1) {
    const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", `Ticket number ${i} with a long title that runs on`], "Body.\n");
    assert.equal(out.code, 0, out.stderr);
  }
  const lines = Array.from({ length: 30 }, (_, i) => `Document text line ${i} that runs across the page and under the drawer.`);
  await hub.create("a.md", `${lines.join("\n\n")}\n`);
  ctx.browser = await launchBrowser();
  const page = new Page(ctx.browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("a.md");
  await page.until(() => page.eval(`document.querySelectorAll(".ticket-block .md-ticket-drawer button, .ticket-block .md-ticket-drawer a").length >= 8`), "the ticket rows");
  return { ...ctx, page };
}

const move = (page, x, y) => page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

// The drawer's box and state, as a person sees it at rest.
const REST = `(() => {
  const d = document.querySelector(".md-ticket-drawer");
  const r = d.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, position: getComputedStyle(d).position, wide: d.classList.contains("md-ticket-wide"), style: d.getAttribute("style") || "" };
})()`;

// A point on the Tickets block, and one well right of it over the document.
async function points(page) {
  return page.eval(`(() => {
    const r = document.querySelector(".ticket-block").getBoundingClientRect();
    return { on: { x: r.left + r.width / 2, y: r.top + Math.min(40, r.height / 2) }, off: { x: innerWidth - 220, y: innerHeight / 2 } };
  })()`);
}

// Rest with the pointer over the document, then widen with the pointer on the block.
async function widen(page) {
  const at = await points(page);
  await move(page, at.off.x, at.off.y);
  await page.until(() => page.eval(`!document.querySelector(".md-ticket-drawer").classList.contains("md-ticket-wide")`), "the drawer at rest");
  await sleep(700);
  const rest = await page.eval(REST);
  await move(page, at.on.x, at.on.y);
  await page.until(async () => {
    const now = await page.eval(REST);
    return now.wide && now.width > rest.width * 3;
  }, "the drawer wide");
  // Let the widening ease finish.
  let last = 0;
  await page.until(async () => {
    const w = (await page.eval(REST)).width;
    const steady = Math.abs(w - last) < 0.5;
    last = w;
    return steady;
  }, "the wide drawer steady");
  return { at, rest, wide: await page.eval(REST) };
}

// Samples every frame until the drawer has been at rest for 10 frames, or 3 s have gone.
function startSampler(page, restWidth) {
  return page.eval(`(() => {
    const d = document.querySelector(".md-ticket-drawer");
    const run = window.__drawerRun = { frames: [], done: false };
    const t0 = performance.now();
    let still = 0;
    const alpha = (color) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(color);
      if (!m) return color === "transparent" ? 0 : 1;
      const parts = m[1].split(/[ ,\\/]+/).filter(Boolean);
      return parts.length > 3 ? Number(parts[3]) : 1;
    };
    const step = () => {
      const r = d.getBoundingClientRect();
      const cs = getComputedStyle(d);
      const covered = [];
      for (let i = 1; i <= 6; i += 1) {
        for (let j = 1; j <= 6; j += 1) {
          const x = r.left + (r.width * i) / 7;
          const y = r.top + (r.height * j) / 7;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const top = document.elementFromPoint(x, y);
          if (!top || !d.contains(top)) covered.push({ x: Math.round(x), y: Math.round(y), by: top ? top.tagName + "." + top.className : null });
        }
      }
      let opacity = 1;
      for (let el = d; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
      const wide = d.classList.contains("md-ticket-wide");
      run.frames.push({ t: Math.round(performance.now() - t0), width: Math.round(r.width), wide, position: cs.position, background: cs.backgroundColor, alpha: alpha(cs.backgroundColor), opacity, covered });
      const resting = !wide && cs.position !== "fixed" && Math.abs(r.width - ${restWidth}) < 1;
      still = resting ? still + 1 : 0;
      if (still >= 10 || performance.now() - t0 > 3000) {
        run.done = true;
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
}

async function sampled(page) {
  await page.until(() => page.eval(`window.__drawerRun && window.__drawerRun.done`), "the sampler", 5000);
  return page.eval(`window.__drawerRun.frames`);
}

async function close(page) {
  const { at, rest, wide } = await widen(page);
  await startSampler(page, rest.width);
  await move(page, at.off.x, at.off.y);
  const frames = await sampled(page);
  return { rest, wide, frames };
}

test("7qkzmvut: while the ticket drawer narrows, every point inside its box is the drawer or one of its rows", async (t) => {
  const { page } = await setup(t);
  const { frames } = await close(page);
  const narrowing = frames.filter((f) => f.width > 0);
  assert.ok(narrowing.some((f) => f.wide) && narrowing.some((f) => !f.wide), `the sample did not span the close: ${JSON.stringify(frames.map((f) => [f.t, f.width, f.wide]))}`);
  const bad = narrowing.filter((f) => f.covered.length > 0);
  assert.deepEqual(bad.map((f) => ({ t: f.t, width: f.width, wide: f.wide, position: f.position, covered: f.covered.slice(0, 3) })), [], "something other than the drawer is on top inside its box");
});

test("7qkzmvut: the ticket drawer's background stays opaque while it narrows", async (t) => {
  const { page } = await setup(t);
  const { frames } = await close(page);
  const bad = frames.filter((f) => f.alpha !== 1 || f.opacity !== 1);
  assert.deepEqual(bad.map((f) => ({ t: f.t, width: f.width, background: f.background, opacity: f.opacity })), [], "the drawer is not opaque");
});

test("7qkzmvut: once narrowed, the ticket drawer sits in its column as it did before it widened", async (t) => {
  const { page } = await setup(t);
  const { rest } = await close(page);
  const now = await page.eval(REST);
  for (const key of ["left", "top", "width", "height"]) {
    assert.ok(Math.abs(now[key] - rest[key]) < 1, `${key}: ${now[key]} after the close, ${rest[key]} before the drawer widened`);
  }
  assert.equal(now.position, rest.position);
  assert.equal(now.wide, false);
  assert.equal(now.style, rest.style);
});

test("7qkzmvut: a pointer that comes back within 200 ms keeps the ticket drawer wide", async (t) => {
  const { page } = await setup(t);
  const { at, rest, wide } = await widen(page);
  await startSampler(page, rest.width);
  await move(page, at.off.x, at.off.y);
  await sleep(100);
  await move(page, at.on.x, at.on.y);
  const frames = await sampled(page);
  const narrowed = frames.filter((f) => !f.wide || f.width < wide.width - 1);
  assert.deepEqual(narrowed.map((f) => [f.t, f.width, f.wide]), [], "the drawer narrowed");
});

test("7qkzmvut: a pointer that comes back while the ticket drawer narrows widens it again, and the drawer stays on top", async (t) => {
  const { page } = await setup(t);
  const { at, rest, wide } = await widen(page);
  await startSampler(page, rest.width);
  await move(page, at.off.x, at.off.y);
  // Into the ease: the grace is 200 ms and the ease 500 ms after it.
  await page.until(() => page.eval(`(() => { const f = window.__drawerRun.frames; return f.length > 0 && f[f.length - 1].width < ${wide.width} - 100; })()`), "the drawer narrowing", 2000);
  await move(page, at.on.x, at.on.y);
  await page.until(async () => {
    const now = await page.eval(REST);
    return now.wide && Math.abs(now.width - wide.width) < 1;
  }, "the drawer wide again", 3000);
  const frames = await page.eval(`window.__drawerRun.frames`);
  const bad = frames.filter((f) => f.covered.length > 0);
  assert.deepEqual(bad.map((f) => ({ t: f.t, width: f.width, wide: f.wide, covered: f.covered.slice(0, 3) })), [], "something other than the drawer is on top inside its box");
});
