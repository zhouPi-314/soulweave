import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const baseUrl = process.env.SITE_URL || 'http://127.0.0.1:4173';
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outputDir = path.resolve(process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'soulweave-browser-check'));
const profileDir = await mkdir(path.join(outputDir, '.edge-profile'), { recursive: true }).then(() => path.join(outputDir, '.edge-profile'));
const port = 9333;
const pages = (process.env.CHECK_PAGES || [
  'index.html',
  'features.html',
  'download.html',
  'releases.html',
  'announcements.html',
  'about.html',
  'privacy.html',
  '404.html',
  'docs/index.html',
  'docs/install.html',
  'docs/first-run.html',
  'docs/qq.html',
  'docs/api.html',
  'docs/permissions.html',
  'docs/troubleshooting.html',
  'docs/faq.html',
].join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const keyPages = new Set(['index.html', 'features.html', 'download.html', 'releases.html', 'docs/index.html']);
const viewports = [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [768, 1024],
  [390, 844],
  [360, 800],
];

await mkdir(outputDir, { recursive: true });
const edge = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      // Edge is still starting.
    }
    await sleep(100);
  }
  throw new Error('Edge DevTools endpoint did not become ready');
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(details?.exception?.description || details?.text || 'Runtime exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(message.params.entry.text);
  }
  if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
    consoleErrors.push(`Network failed: ${message.params.errorText}`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await Promise.all([
  send('Page.enable'),
  send('Runtime.enable'),
  send('Log.enable'),
  send('Network.enable'),
]);

const failures = [];
const results = [];
for (const [width, height] of viewports) {
  for (const urlPath of pages) {
    if (!keyPages.has(urlPath) && ![1440, 390].includes(width)) continue;
    consoleErrors.length = 0;
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 680,
    });
    await send('Page.navigate', { url: `${baseUrl}/${urlPath}` });
    await sleep(650);
    await send('Runtime.evaluate', {
      expression: `(() => {
        document.querySelectorAll('img[loading="lazy"]').forEach((image) => { image.loading = 'eager'; });
        scrollTo(0, document.documentElement.scrollHeight);
      })()`,
    });
    await send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)))`,
    });
    await send('Runtime.evaluate', { expression: 'scrollTo(0, 0)' });
    await sleep(100);
    const { result } = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const toggle = document.querySelector('.nav-toggle');
        const docToggle = document.querySelector('.doc-nav-toggle');
        if (toggle && innerWidth <= 900) toggle.click();
        const navOpen = !!document.querySelector('.nav.open');
        if (toggle && innerWidth <= 900) toggle.click();
        if (docToggle && innerWidth <= 900) docToggle.click();
        const docOpen = !!document.querySelector('.side.open');
        const dialogTrigger = document.querySelector('[data-gallery] button');
        if (dialogTrigger) dialogTrigger.click();
        const dialogOpen = !!document.querySelector('.gallery-dialog[open]');
        document.querySelector('.gallery-dialog[open]')?.close();
        return {
          title: document.title,
          innerWidth,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
          navToggle: !!toggle,
          navOpen,
          docToggle: !!docToggle,
          docOpen,
          dialogOpen,
          brokenImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src)
        };
      })()`,
    });
    const value = result.value;
    const label = `${urlPath}@${width}x${height}`;
    if (value.overflow) failures.push(`${label}: horizontal overflow ${value.scrollWidth}px`);
    if (value.brokenImages.length) failures.push(`${label}: broken images ${value.brokenImages.join(', ')}`);
    if (width <= 900 && !value.navToggle) failures.push(`${label}: mobile nav toggle missing`);
    if (width <= 900 && !value.docToggle && urlPath.startsWith('docs/')) failures.push(`${label}: docs toggle missing`);
    if (consoleErrors.length) failures.push(`${label}: console ${consoleErrors.join(' | ')}`);
    results.push({ label, ...value });

    const capture = (urlPath === 'index.html' && [1920, 1440, 390, 360].includes(width))
      || (['features.html', 'download.html', 'releases.html', 'docs/index.html'].includes(urlPath) && [1440, 390].includes(width));
    if (capture) {
      await send('Page.navigate', { url: `${baseUrl}/${urlPath}` });
      await sleep(700);
      await send('Runtime.evaluate', { expression: 'scrollTo(0, 0)' });
      await sleep(200);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      await writeFile(path.join(outputDir, `${urlPath.replaceAll('/', '-')}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
}

await writeFile(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
socket.close();
edge.kill();
await sleep(250);
await rm(profileDir, { recursive: true, force: true }).catch(() => {});

if (failures.length) {
  console.error(`Browser check failed with ${failures.length} issue(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Browser check passed: ${pages.length} pages; ${keyPages.size} key pages across all ${viewports.length} viewports, remaining pages at 1440×900 and 390×844.`);
  console.log(`Screenshots: ${outputDir}`);
}
