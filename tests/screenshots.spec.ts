// @playwright/test is not an installed project dependency (no entry in package.json /
// node_modules), and this Playwright spec is deliberately outside vitest's `include` globs (see
// vitest.config.ts) — it runs under a separate Playwright invocation once that package is
// present. An in-file `declare module` augmentation can't shim a module that doesn't resolve at
// all (TS only allows augmenting a module it can already find), and adding a new ambient .d.ts
// is out of this file's scope, so the missing-module diagnostic is suppressed here with a
// one-line reason; every real call below is still checked against whatever shape `test` actually
// has once the dependency exists.
// @ts-expect-error - @playwright/test is intentionally not installed; see comment above.
import { test } from '@playwright/test';
import express from 'express';
import path from 'path';
import fs from 'fs';

// Minimal local shape for the Playwright Page API surface this spec actually calls, since
// @playwright/test's real types aren't available (see the import-site comment above).
interface PlaywrightRoute {
  request(): { url(): string };
  continue(): void;
  abort(): void;
}
interface PlaywrightPage {
  route(pattern: string, handler: (route: PlaywrightRoute) => void): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, options?: { waitUntil?: string }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<void>;
}

let server: any;
const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

test.beforeAll(async () => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('*', (req, res) => {
    let reqPath = req.path === '/' ? '/index.html' : req.path;
    if (!reqPath.endsWith('.html') && !reqPath.includes('.')) {
      reqPath += '.html';
    }
    const filePath = path.join(__dirname, '..', 'public', reqPath);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  await new Promise<void>((resolve) => {
    server = app.listen(PORT, () => resolve());
  });
});

test.afterAll(async () => {
  if (server) server.close();
});

const routes = [
  { name: 'overview', path: '/' },
  { name: 'live', path: '/live' },
  { name: 'repos', path: '/repos' },
  { name: 'settings', path: '/settings' },
  { name: 'integrations', path: '/integrations' },
  { name: 'github-app', path: '/github-app' },
];

for (const route of routes) {
  test(`Capture screenshots for ${route.name}`, async ({ page }: { page: PlaywrightPage }) => {
    await page.route('**/*', (r: PlaywrightRoute) => {
      if (r.request().url().startsWith('http://localhost:3099')) {
        r.continue();
      } else {
        r.abort();
      }
    });

    const viewports = [
      { suffix: '', width: 1440, height: 900 },
      { suffix: '-tablet', width: 768, height: 1024 },
      { suffix: '-mobile', width: 375, height: 667 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      const outPath = path.join(SCREENSHOT_DIR, `${route.name}${vp.suffix}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
    }
  });
}
