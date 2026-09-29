// Visual smoke check. PLAN.md's biggest unresolved risk is that the canvas has never been
// visually confirmed. "It compiles" is not "it works". This boots the app in a real browser,
// drives the pointer, and reads pixels back off the canvas to prove something actually painted.
//
// Run: node test/smoke.mjs   (dev server must be up on :3000)

import { chromium } from "@playwright/test";

const URL = process.env.SMOKE_URL ?? "http://localhost:3000";

/**
 * Snapshot the canvas into a downsampled RGB signature stashed on `window`.
 *
 * Deliberately NOT a painted-pixel count: the sheet background already covers the whole canvas,
 * so drawing a shape *replaces* pixels rather than adding them. The only honest question is
 * "did the content change", which is a diff against a previous signature.
 */
async function snapshot(page, slot) {
  return page.evaluate((name) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { error: "no canvas element" };
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "no 2d context" };
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map();
    // Every 16th pixel: plenty for detecting a 180x180 sticky, cheap to move across the boundary.
    const sig = new Uint8Array((data.length / 4 / 16) * 3);
    let p = 0;
    for (let i = 0; i < data.length; i += 64) {
      if (data[i + 3] === 0) continue;
      const key = `${data[i] >> 5}_${data[i + 1] >> 5}_${data[i + 2] >> 5}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sig[p++] = data[i];
      sig[p++] = data[i + 1];
      sig[p++] = data[i + 2];
    }
    window[name] = sig;
    return { w: canvas.width, h: canvas.height, distinct: counts.size, samples: p / 3 };
  }, slot);
}

/** How many sampled pixels differ between the stashed `before` and the current canvas. */
async function diff(page, slot) {
  return page.evaluate((name) => {
    const before = window[name];
    if (!before) return { error: `no snapshot named ${name}` };
    const canvas = document.querySelector("canvas");
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let changed = 0;
    let p = 0;
    for (let i = 0; i < data.length; i += 64) {
      if (
        data[i] !== before[p] ||
        data[i + 1] !== before[p + 1] ||
        data[i + 2] !== before[p + 2]
      ) changed++;
      p += 3;
    }
    return { changed, total: p / 3 };
  }, slot);
}

const drag = async (page, from, to, steps = 24) => {
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 15000 });
await page.waitForTimeout(1200); // let the seed scene + zoomToFit settle

await snapshot(page, "__sig0");

// The seed sample should already have painted a "Act I" scene. Draw a rectangle on top of it.
// Deliberately a shape, not a sticky: a sticky opens the text editor overlay on creation, which
// commits its own state, so undo would then be measuring two edits at once.
await page.keyboard.press("r");
await drag(page, { x: 700, y: 300 }, { x: 860, y: 400 });
await page.waitForTimeout(500);
const delta = await diff(page, "__sig0");
const after = await snapshot(page, "__sig1");

// Undo it and confirm we get back to the original picture. This exercises the snapshot undo
// path end to end, which PLAN.md notes has never been run in a real browser.
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
const undone = await diff(page, "__sig0");

// A pan must change the view. Drag on empty canvas with the select tool.
await page.keyboard.press("v");
await page.keyboard.press("Escape");
await drag(page, { x: 640, y: 640 }, { x: 540, y: 580 });
await page.waitForTimeout(400);
const panned = await diff(page, "__sig0");

const checks = [
  ["canvas has size", after.w > 0 && after.h > 0, `${after.w}x${after.h}`],
  ["canvas is not blank", after.distinct > 3, `${after.distinct} distinct colours`],
  ["shape repaints the canvas", delta.changed > 50, `${delta.changed}/${delta.total} px changed`],
  ["undo restores the scene", undone.changed === 0, `${undone.changed}/${undone.total} px still differ`],
  ["pan changes the view", panned.changed > 50, `${panned.changed} px changed`],
  ["no console errors", errors.length === 0, errors.length ? errors.join(" | ") : "none"],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(30)} ${detail}`);
}
console.log(`\nVERDICT: ${failed === 0 ? "PASS" : `FAIL (${failed} check${failed > 1 ? "s" : ""})`}`);

await page.screenshot({ path: "/tmp/opencode/storyboard-smoke.png" });
await browser.close();
process.exit(failed === 0 ? 0 : 1);
