const express = require('express');
const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('/Users/jasonbarbee/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'));
} catch {
  ({ chromium } = require('playwright'));
}

const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

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

const routes = [
  { name: 'overview', path: '/' },
  { name: 'live', path: '/live' },
  { name: 'repos', path: '/repos' },
  { name: 'settings', path: '/settings' },
  { name: 'integrations', path: '/integrations' },
  { name: 'github-app', path: '/github-app' },
];

const viewports = [
  { suffix: '', width: 1440, height: 900 },
  { suffix: '-tablet', width: 768, height: 1024 },
  { suffix: '-mobile', width: 375, height: 667 },
];

const server = app.listen(0, async () => {
  const actualPort = server.address().port;
  const BASE_URL = `http://localhost:${actualPort}`;
  console.log(`Screenshot server listening at ${BASE_URL}`);

  try {
    const browser = await chromium.launch({ headless: true });
    console.log('Chromium browser launched cleanly.');

    for (const r of routes) {
      for (const vp of viewports) {
        const filename = `${r.name}${vp.suffix}.png`;
        const outPath = path.join(SCREENSHOT_DIR, filename);
        console.log(`Capturing ${filename}...`);

        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 2,
        });

        // Intercept network requests to block external CDNs that stall in offline mode
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith(BASE_URL)) {
            route.continue();
          } else {
            route.abort();
          }
        });

        const page = await context.newPage();
        await page.goto(`${BASE_URL}${r.path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`Saved screenshots/${filename}`);
        await context.close();
      }
    }

    await browser.close();
    console.log('All screenshots captured successfully!');
  } catch (err) {
    console.error('Error during screenshot generation:', err);
  } finally {
    server.close(() => {
      console.log('Server shut down cleanly.');
      process.exit(0);
    });
  }
});
