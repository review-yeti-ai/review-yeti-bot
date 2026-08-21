import { test } from '@playwright/test';
import express from 'express';
import path from 'path';
import fs from 'fs';

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
  test(`Capture screenshots for ${route.name}`, async ({ page }) => {
    await page.route('**/*', (r) => {
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
