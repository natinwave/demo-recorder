#!/usr/bin/env node
// Replay a JSON browse plan in a real Chrome window, record the screen while it
// runs, log a timestamped "moment" per step, then cut the recording for brevity.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { sleep, parseArgs, probe, round3, even } from './lib/util.mjs';
import { startCapture, findFlash } from './lib/capture.mjs';
import { overlayScript } from './lib/overlay.mjs';
import { cutFromMoments } from './cut.mjs';

const USAGE = `Usage:
  node record.mjs <plan.json> [options]
  node record.mjs --selftest            Record a built-in 10 second plan to check the setup

Options:
  --out <dir>        Output folder (default: ./demo-videos/<plan name>)
  --frame <mode>     window = crop to the Chrome window (default), screen = whole display
  --check            Validate the plan and exit without recording
  --no-cut           Record only; skip the automatic cut
  --keep-open        Leave Chrome open after the plan finishes

Environment:
  DEMO_BROWSER_PATH  Path to a Chrome/Chromium binary (default: installed Google Chrome)
  DEMO_SCREEN        Which display to record on macOS (default 0, the main display)
  DEMO_ENCODER       x264 | videotoolbox (default: videotoolbox on macOS, else x264)

Exit codes: 0 ok, 1 setup or plan problem, 2 a plan step failed, 3 Chrome was not visible in the recording`;

const ACTIONS = {
  goto: ['url'],
  click: ['target'],
  hover: ['target'],
  fill: ['target', 'text'],
  type: ['text'],
  press: ['key'],
  select: ['target', 'value'],
  check: ['target'],
  uncheck: ['target'],
  upload: ['target', 'files'],
  scroll: [],
  waitFor: ['target'],
  waitForUrl: ['url'],
  expect: ['target'],
  wait: ['seconds'],
  highlight: ['target'],
  eval: ['js'],
  switchTab: [],
};
const EDITS = ['auto', 'keep', 'fast', 'cut'];

export function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return ['The plan must be a JSON object.'];
  if (!Array.isArray(plan.steps) || !plan.steps.length) problems.push('"steps" must be a non-empty array.');
  if (plan.frame && !['window', 'screen'].includes(plan.frame)) problems.push('"frame" must be "window" or "screen".');
  (plan.steps ?? []).forEach((step, i) => {
    const where = `steps[${i}]`;
    if (!step || typeof step !== 'object') { problems.push(`${where} must be an object.`); return; }
    if (!ACTIONS[step.do]) { problems.push(`${where}.do "${step.do}" is not one of: ${Object.keys(ACTIONS).join(', ')}.`); return; }
    for (const key of ACTIONS[step.do]) {
      if (step[key] == null) problems.push(`${where} (${step.do}) needs "${key}".`);
    }
    if (step.edit && !EDITS.includes(step.edit)) problems.push(`${where}.edit must be one of: ${EDITS.join(', ')}.`);
    if (step.moment != null && typeof step.moment !== 'string') problems.push(`${where}.moment must be a string.`);
    if (step.do === 'goto' && step.url && !/^[a-z]+:/i.test(step.url) && !plan.baseUrl) {
      problems.push(`${where}.url "${step.url}" is relative but the plan has no "baseUrl".`);
    }
  });
  return problems;
}

function selftestPlan() {
  const html = `<!doctype html><title>Demo recorder self-test</title>
<body style="font:20px system-ui;margin:60px">
<h1>Demo recorder self-test</h1>
<p>Clicks: <b id="n">0</b></p>
<button id="b" style="font:inherit;padding:10px 20px">Add one</button>
<script>b.onclick=()=>{n.textContent=+n.textContent+1}</script>`;
  return {
    name: 'selftest',
    steps: [
      { do: 'goto', url: `data:text/html,${encodeURIComponent(html)}`, moment: 'Open the test page' },
      { do: 'click', target: '#b', moment: 'Click the button' },
      { do: 'wait', seconds: 4 },
      { do: 'click', target: '#b' },
      { do: 'expect', target: '#n', text: '2', moment: 'Counter shows 2' },
    ],
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'demo';

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), ['selftest', 'check', 'no-cut', 'keep-open', 'help']);
  if (flags.help || (!flags.selftest && !positional.length)) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }

  let plan;
  let planDir = process.cwd();
  if (flags.selftest) {
    plan = selftestPlan();
  } else {
    const planPath = path.resolve(positional[0]);
    planDir = path.dirname(planPath);
    try {
      plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    } catch (err) {
      fail(1, `Cannot read plan ${planPath}: ${err.message}`);
    }
    plan.name ??= path.basename(planPath, path.extname(planPath)).replace(/\.plan$/, '');
  }
  const problems = validatePlan(plan);
  if (problems.length) fail(1, `The plan has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  if (flags.check) { console.log(JSON.stringify({ ok: true, steps: plan.steps.length })); return; }

  const name = slug(plan.name);
  const outDir = path.resolve(flags.out ?? path.join(process.cwd(), 'demo-videos', name));
  await fs.mkdir(outDir, { recursive: true });
  const frame = flags.frame ?? plan.frame ?? 'window';
  if (!['window', 'screen'].includes(frame)) fail(1, '--frame must be "window" or "screen".');
  const rawFile = path.join(outDir, 'raw.mp4');
  const fps = 30;
  const warnings = [];

  // ---- Launch Chrome -------------------------------------------------------
  const want = { width: 1440, height: 900, ...(plan.window ?? {}) };
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const launchOptions = {
    headless: false,
    chromiumSandbox: !isRoot,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--window-position=0,0',
      `--window-size=${want.width},${want.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-features=Translate,InfiniteSessionRestore',
      ...(isRoot ? ['--test-type'] : []),
    ],
  };
  if (process.env.DEMO_BROWSER_PATH) launchOptions.executablePath = process.env.DEMO_BROWSER_PATH;
  else launchOptions.channel = plan.browser ?? 'chrome';
  const contextOptions = { viewport: null, ...(plan.baseUrl ? { baseURL: plan.baseUrl } : {}) };
  if (plan.storageState) contextOptions.storageState = path.resolve(planDir, plan.storageState);

  let browser = null;
  let context;
  try {
    if (plan.profile) {
      const profileDir = path.join(os.homedir(), '.demo-recorder', 'profiles', slug(plan.profile));
      await fs.mkdir(profileDir, { recursive: true });
      context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, ...contextOptions });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
  } catch (err) {
    fail(1, `Could not launch Chrome: ${String(err.message).split('\n')[0]}\n` +
      'Install Google Chrome, or set DEMO_BROWSER_PATH to a Chrome/Chromium binary.');
  }
  await context.addInitScript(overlayScript);
  context.setDefaultTimeout((plan.timeout ?? 15) * 1000);

  let page = context.pages()[0] ?? (await context.newPage());
  let mouse = null;
  let caption = null;
  let capture = null;
  let stopping = false;

  const reapply = (p) => p.evaluate(({ m, c }) => {
    if (!window.__demo) return;
    if (m) window.__demo.move(m.x, m.y);
    window.__demo.caption(c);
  }, { m: mouse, c: caption }).catch(() => {});
  const watch = (p) => {
    p.on('domcontentloaded', () => reapply(p));
    p.on('dialog', async (d) => { await sleep(1200); await d.accept().catch(() => {}); });
  };
  watch(page);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (capture) await capture.stop().catch(() => {});
    if (!flags['keep-open']) {
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await shutdown(); process.exit(130); });
  }

  // ---- Place the window and read its geometry ------------------------------
  await page.goto('about:blank');
  const cdp = await context.newCDPSession(page);
  const metricsOf = () => page.evaluate(() => ({
    screenW: screen.width, screenH: screen.height,
    availW: screen.availWidth, availH: screen.availHeight,
    availLeft: screen.availLeft ?? 0, availTop: screen.availTop ?? 0,
    dpr: window.devicePixelRatio,
    outerW: window.outerWidth, outerH: window.outerHeight,
    innerW: window.innerWidth, innerH: window.innerHeight,
  }));
  let metrics = await metricsOf();
  let win = await cdp.send('Browser.getWindowForTarget');
  try {
    await cdp.send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: {
        left: metrics.availLeft,
        top: metrics.availTop,
        width: Math.min(want.width, metrics.availW),
        height: Math.min(want.height, metrics.availH),
        windowState: 'normal',
      },
    });
    await sleep(400);
  } catch { /* some window managers refuse; the measured bounds below are what count */ }
  await page.bringToFront();
  win = await cdp.send('Browser.getWindowForTarget');
  metrics = await metricsOf();
  // Window bounds are in screen points on macOS; some Linux setups report device pixels.
  // Compare against the page's own measurement and normalise to points.
  const unit = Math.abs(win.bounds.width - metrics.outerW) <= Math.abs(win.bounds.width - metrics.outerW * metrics.dpr) ? 1 : metrics.dpr;
  const bounds = {
    left: win.bounds.left / unit, top: win.bounds.top / unit,
    width: win.bounds.width / unit, height: win.bounds.height / unit,
  };

  // New windows fall outside a window-sized crop; notice them so the caller can switch to --frame screen.
  const opened = [];
  context.on('page', async (p) => {
    opened.push({ page: p, at: Date.now() });
    watch(p);
    try {
      const s = await context.newCDPSession(p);
      const w = await s.send('Browser.getWindowForTarget');
      if (w.windowId !== win.windowId && frame === 'window') {
        warnings.push(`A separate browser window opened during the plan (${p.url() || 'new window'}). It is outside the recorded window; use --frame screen to include it.`);
      }
    } catch { /* page closed already */ }
  });

  // ---- Start recording ------------------------------------------------------
  try {
    capture = await startCapture({
      outFile: rawFile,
      fps,
      screenSize: { width: Math.round(metrics.screenW * metrics.dpr), height: Math.round(metrics.screenH * metrics.dpr) },
      screenIndex: Number(process.env.DEMO_SCREEN ?? 0),
      maxSeconds: plan.maxSeconds ?? 900,
    });
  } catch (err) {
    await shutdown();
    fail(1, `${err.message}\n` + (process.platform === 'darwin'
      ? 'On macOS the app running this command (Terminal, iTerm, VS Code...) needs Screen Recording permission: System Settings > Privacy & Security > Screen & System Audio Recording. Restart that app after granting it.'
      : ''));
  }

  // Sync flash: green then magenta at a known wall-clock time. Finding it in the
  // video ties step timestamps to video time and proves the window was captured.
  await page.evaluate(() => { document.documentElement.style.background = '#00ff00'; });
  await sleep(700);
  const flashWall = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      document.documentElement.style.background = '#ff00ff';
      requestAnimationFrame(() => resolve(Date.now()));
    });
  }));
  await sleep(500);
  await page.evaluate(() => { document.documentElement.style.background = ''; });
  await sleep(200);
  const planStartWall = Date.now();

  // ---- Run the plan ---------------------------------------------------------
  const captions = plan.captions !== false;
  const pace = (plan.pace ?? 0.3) * 1000;
  const records = [];
  let failure = null;
  let previousStepStart = Date.now();

  const overlay = (method, arg) => page.evaluate(({ method, arg }) => window.__demo?.[method](arg), { method, arg }).catch(() => {});

  async function glide(loc) {
    await loc.waitFor({ state: 'visible' });
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box) return;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const from = mouse ?? { x: metrics.innerW * 0.5, y: metrics.innerH * 0.65 };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.max(6, Math.round(Math.min(650, 200 + dist * 0.5) / 16));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      await sleep(16);
    }
    mouse = to;
    await sleep(120);
  }

  async function runStep(step) {
    const loc = step.target ? page.locator(step.target).first() : null;
    const timeout = step.timeout != null ? step.timeout * 1000 : undefined;
    switch (step.do) {
      case 'goto':
        await page.goto(step.url, { waitUntil: step.waitUntil ?? 'load', timeout });
        break;
      case 'click':
        await glide(loc);
        await loc.click({ button: step.button ?? 'left', clickCount: step.double ? 2 : 1, timeout });
        break;
      case 'hover':
        await glide(loc);
        await loc.hover({ timeout });
        break;
      case 'fill':
        await glide(loc);
        await loc.fill(String(step.text), { timeout });
        break;
      case 'type':
        if (loc) { await glide(loc); await loc.click({ timeout }); }
        await page.keyboard.type(String(step.text), { delay: step.delay ?? 45 });
        break;
      case 'press':
        if (loc) await loc.press(step.key, { timeout });
        else await page.keyboard.press(step.key);
        break;
      case 'select':
        await glide(loc);
        await loc.selectOption(step.value, { timeout });
        break;
      case 'check':
        await glide(loc);
        await loc.check({ timeout });
        break;
      case 'uncheck':
        await glide(loc);
        await loc.uncheck({ timeout });
        break;
      case 'upload':
        await loc.setInputFiles([].concat(step.files).map((f) => path.resolve(planDir, f)), { timeout });
        break;
      case 'scroll':
        if (loc) {
          await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        } else if (step.to === 'top' || step.to === 'bottom') {
          await page.evaluate((to) => window.scrollTo({ top: to === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'smooth' }), step.to);
        } else {
          await page.evaluate((by) => window.scrollBy({ top: by, behavior: 'smooth' }), step.by ?? 500);
        }
        await sleep(800);
        break;
      case 'waitFor':
        await loc.waitFor({ state: step.state ?? 'visible', timeout });
        break;
      case 'waitForUrl':
        await page.waitForURL(step.url, { timeout });
        break;
      case 'expect': {
        await loc.waitFor({ state: 'visible', timeout });
        if (step.text != null) {
          const deadline = Date.now() + (timeout ?? (plan.timeout ?? 15) * 1000);
          let actual = '';
          for (;;) {
            actual = (await loc.innerText()).trim();
            if (actual.includes(String(step.text))) break;
            if (Date.now() > deadline) throw new Error(`Expected "${step.target}" to contain "${step.text}" but it shows "${actual.slice(0, 200)}".`);
            await sleep(100);
          }
        }
        break;
      }
      case 'wait':
        await sleep(step.seconds * 1000);
        break;
      case 'highlight': {
        await loc.waitFor({ state: 'visible', timeout });
        await loc.scrollIntoViewIfNeeded();
        await overlay('highlight', await loc.boundingBox());
        await sleep((step.seconds ?? 1.5) * 1000);
        await overlay('highlight', null);
        break;
      }
      case 'eval':
        await page.evaluate(step.js);
        break;
      case 'switchTab': {
        // The tab may still be opening when the step that triggered it returns, so wait for it.
        const deadline = Date.now() + (timeout ?? 5000);
        let next = null;
        for (;;) {
          const pages = context.pages();
          if (step.url) next = pages.find((p) => p.url().includes(step.url));
          else if (step.which != null && step.which !== 'latest') next = pages[Number(step.which)];
          else next = opened.filter((o) => o.at >= previousStepStart && !o.page.isClosed()).pop()?.page;
          if (next || Date.now() > deadline) break;
          await sleep(100);
        }
        if (!next && !step.url && (step.which ?? 'latest') === 'latest') next = context.pages().pop();
        if (!next) throw new Error(`No matching tab (open tabs: ${context.pages().map((p) => p.url()).join(', ')}).`);
        page = next;
        await page.bringToFront();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await reapply(page);
        break;
      }
      default:
        throw new Error(`Unknown action ${step.do}`);
    }
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const rec = { i, do: step.do, label: step.moment ?? null, edit: step.edit ?? 'auto', wallStart: Date.now(), ok: true };
    if (step.moment && captions) { caption = step.moment; await overlay('caption', caption); }
    try {
      await runStep(step);
      rec.wallSettled = step.do === 'wait' ? rec.wallStart : Date.now();
      const hold = step.hold ?? (step.moment ? plan.momentHold ?? 1.5 : 0);
      await sleep(hold * 1000 + pace);
    } catch (err) {
      rec.ok = false;
      rec.error = String(err.message).split('\n')[0];
      failure = { step: i, do: step.do, target: step.target ?? null, error: rec.error };
      await page.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => {});
      await sleep(1000);
    }
    rec.wallEnd = Date.now();
    previousStepStart = rec.wallStart;
    records.push(rec);
    if (failure) break;
  }

  const tail = plan.tail ?? 1;
  await sleep(tail * 1000 + 300);
  const t0Estimate = capture.t0Estimate();
  await shutdown();

  // ---- Map wall-clock times onto the video ----------------------------------
  const info = await probe(rawFile);
  const scale = info.width / metrics.screenW;
  if (Math.abs(info.height / metrics.screenH - scale) > 0.03) {
    warnings.push(`The recording is ${info.width}x${info.height} but the browser reports a ${metrics.screenW}x${metrics.screenH} screen; the window crop may be off. Is the window on the display being recorded (DEMO_SCREEN)?`);
  }
  const px = (n) => Math.round(n * scale);
  const cropX = Math.max(0, px(bounds.left));
  const cropY = Math.max(0, px(bounds.top));
  const crop = {
    x: cropX,
    y: cropY,
    w: even(Math.min(px(bounds.width), info.width - cropX)),
    h: even(Math.min(px(bounds.height), info.height - cropY)),
  };
  // A small box in the middle of the page area, where the flash was drawn.
  const pageLeft = bounds.left + (metrics.outerW - metrics.innerW) / 2;
  const pageTop = bounds.top + (metrics.outerH - metrics.innerH);
  const box = {
    x: Math.max(0, Math.min(info.width - 16, px(pageLeft + metrics.innerW / 2) - 8)),
    y: Math.max(0, Math.min(info.height - 16, px(pageTop + metrics.innerH / 2) - 8)),
    w: 16,
    h: 16,
  };
  const flashAt = await findFlash(rawFile, box, info.fps || fps);
  const sync = flashAt != null
    ? { method: 'flash', videoTime: round3(flashAt), estimateDiffMs: Math.round(flashWall - t0Estimate - flashAt * 1000) }
    : { method: 'estimate' };
  const toVideo = (wall) => round3(Math.max(0, flashAt != null ? (wall - flashWall) / 1000 + flashAt : (wall - t0Estimate) / 1000));
  if (flashAt == null) {
    warnings.push('The Chrome window was not found in the recording, so the video probably does not show the browser.' +
      (process.platform === 'darwin'
        ? ' Check Screen Recording permission for the app running this command, that Chrome is on the main display (or set DEMO_SCREEN), and that nothing covers it.'
        : ''));
  }

  const doc = {
    version: 1,
    name,
    video: 'raw.mp4',
    videoSize: { width: info.width, height: info.height },
    duration: round3(info.duration),
    fps: info.fps,
    frame,
    crop,
    scale: round3(scale),
    window: bounds,
    sync,
    planStart: toVideo(planStartWall),
    tail,
    moments: records.map((r) => ({
      i: r.i, do: r.do, label: r.label, edit: r.edit,
      start: toVideo(r.wallStart), ...(r.wallSettled ? { settled: toVideo(r.wallSettled) } : {}), end: toVideo(r.wallEnd),
      ok: r.ok, ...(r.error ? { error: r.error } : {}),
    })),
    failure,
    warnings,
  };
  const momentsFile = path.join(outDir, 'moments.json');
  await fs.writeFile(momentsFile, JSON.stringify(doc, null, 2) + '\n');

  const summary = { ok: !failure && flashAt != null, name, outDir, raw: rawFile, moments: momentsFile, rawSeconds: doc.duration, sync, failure, warnings };
  if (!flags['no-cut']) {
    try {
      const cut = await cutFromMoments(momentsFile, { frame });
      Object.assign(summary, { stillSecondsRemoved: cut.stillSecondsRemoved, video: cut.outFile, videoSeconds: round3(cut.duration), videoSize: `${cut.width}x${cut.height}`, edit: cut.edlFile, losslessCutCsv: cut.csvFile });
    } catch (err) {
      summary.ok = false;
      warnings.push(`Cutting failed: ${err.message}`);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failure ? 2 : flashAt == null ? 3 : summary.ok ? 0 : 1);
}

function fail(code, message) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(1, err.stack || err.message));
}
