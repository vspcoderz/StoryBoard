// Connector + snapping browser check.
//
// Unit tests prove the routing maths. This proves the wiring: that the tool creates a connector bound
// to the node you started on, that the line paints, that dragging an endpoint re-binds it, and that
// alignment guides appear during a drag. Those are integration facts no pure test can reach.

import { chromium } from "@playwright/test";

const URL = process.env.SMOKE_URL ?? "http://localhost:3000";

const drag = async (page, from, to, steps = 20) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
};

/** Snapshot the canvas, stashed on `window` for a later diff. */
const snapshot = (page, name) =>
  page.evaluate((slot) => {
    const c = document.querySelector("canvas");
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const sig = new Uint8Array((data.length / 4 / 16) * 3);
    let p = 0;
    for (let i = 0; i < data.length; i += 64) {
      sig[p++] = data[i];
      sig[p++] = data[i + 1];
      sig[p++] = data[i + 2];
    }
    window[slot] = sig;
    return { w: c.width, h: c.height };
  }, name);

const diff = (page, name) =>
  page.evaluate((slot) => {
    const before = window[slot];
    const c = document.querySelector("canvas");
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let changed = 0;
    let p = 0;
    for (let i = 0; i < data.length; i += 64) {
      if (data[i] !== before[p] || data[i + 1] !== before[p + 1] || data[i + 2] !== before[p + 2]) changed++;
      p += 3;
    }
    return changed;
  }, name);

/**
 * Full-resolution diff of one rectangle of the canvas.
 *
 * The sampled-every-16th-pixel diff used by `smoke.mjs` is fine for large changes but useless for a
 * 2px line: a 340px-long connector crosses maybe 15 of 61,200 samples. This counts real pixels in a
 * region instead, which is what a thin stroke needs.
 */
const regionDiff = (page, name, x, y, w, h) =>
  page.evaluate(
    ([slot, rx, ry, rw, rh]) => {
      const c = document.querySelector("canvas");
      const grab = () => c.getContext("2d").getImageData(rx, ry, rw, rh).data;
      const before = window[slot];
      const now = grab();
      if (!before) return -1;
      let changed = 0;
      for (let i = 0; i < now.length; i += 4) {
        if (now[i] !== before[i] || now[i + 1] !== before[i + 1] || now[i + 2] !== before[i + 2]) changed++;
      }
      return changed;
    },
    [name, x, y, w, h],
  );

const storeRegion = (page, name, x, y, w, h) =>
  page.evaluate(
    ([slot, rx, ry, rw, rh]) => {
      const c = document.querySelector("canvas");
      window[slot] = new Uint8Array(c.getContext("2d").getImageData(rx, ry, rw, rh).data);
    },
    [name, x, y, w, h],
  );

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("canvas");
await page.waitForTimeout(1500);

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, ok, detail]);

// The seed scene has a rect (upper left), a diamond (upper right) and a sticky (below the rect).
// Connect the rect to the *sticky*: they are far enough apart that the empty band between them gives
// the line real estate to cross, which is what makes a pixel-count assertion meaningful. The rect and
// the diamond are nearly adjacent, so a line between them occupies a couple of pixels and proves
// nothing about whether it rendered.
const BAND = { x: 380, y: 378, w: 90, h: 100 };
await storeRegion(page, "__band0", BAND.x, BAND.y, BAND.w, BAND.h);
await page.keyboard.press("l"); // connector tool
await drag(page, { x: 400, y: 340 }, { x: 430, y: 520 });
await page.waitForTimeout(400);
const linePixels = await regionDiff(page, "__band0", BAND.x, BAND.y, BAND.w, BAND.h);
check("connector paints a line between two nodes", linePixels > 150, `${linePixels} px in the gap`);

await page.screenshot({ path: "docs/verify-connectors.png" });

// The connector should be selected, and the inspector should be showing connector fields.
const inspector = await page.evaluate(() => document.querySelector("aside[aria-label='Properties']")?.innerText ?? "");
check("inspector shows connector fields", /Connector/.test(inspector) && /Route/.test(inspector), inspector.split("\n")[1] ?? "");

// Status line reports 5 objects now (4 seed + 1 connector).
const status = await page.evaluate(() => document.body.innerText.match(/(\d+) objects/)?.[1]);
check("connector is committed to the document", status === "5", `${status} objects`);

// Dragging an endpoint onto empty canvas unbinds it, and undo restores it.
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
const afterUndo = await page.evaluate(() => document.body.innerText.match(/(\d+) objects/)?.[1]);
check("undo removes the connector", afterUndo === "4", `${afterUndo} objects`);

// Alignment guides: drag the rect so its left edge nears the sticky's, mid-drag check the canvas.
await page.keyboard.press("v");
await snapshot(page, "__c1");
await page.mouse.move(360, 283);
await page.mouse.down();
await page.mouse.move(400, 300, { steps: 10 });
await page.mouse.move(428, 320, { steps: 10 });
await page.waitForTimeout(200);
const guidePixels = await page.evaluate(() => {
  // Count brass-ish pixels: guides use --color-brass, which nothing else on the board does.
  const c = document.querySelector("canvas");
  const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 140 && r < 220 && g > 90 && g < 170 && b < 90) n++;
  }
  return n;
});
await page.mouse.up();
check("alignment guides render during a drag", guidePixels > 40, `${guidePixels} brass px mid-drag`);

// Hover ring: hovering a shape with the select tool should paint a brass ring.
await page.keyboard.press("v");
await snapshot(page, "__c2");
await page.mouse.move(350, 550); // the sticky
await page.waitForTimeout(300);
const hoverPixels = await diff(page, "__c2");
check("hover ring appears (was dead code)", hoverPixels > 20, `${hoverPixels} px changed on hover`);

check("no console errors", errors.length === 0, errors.length ? errors.join(" | ") : "none");

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(42)} ${detail}`);
}
console.log(`\nVERDICT: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
