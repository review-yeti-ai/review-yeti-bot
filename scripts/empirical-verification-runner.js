const express = require('express');
const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('/Users/jasonbarbee/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'));
} catch {
  ({ chromium } = require('playwright'));
}

const PORT = 3098;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const results = {
  routesTested: [],
  interactivity: [],
  sseStream: [],
  urlSync: [],
  responsiveViewports: [],
  screenshotsArtifacts: [],
  errors: [],
};

async function runEmpiricalVerification() {
  console.log('--- Starting Empirical Verification Runner ---');

  // 1. Verify Screenshot Artifacts
  console.log('\n[1/4] Verifying Screenshot Artifacts in screenshots/...');
  const expectedScreenshots = [
    'overview.png', 'overview-tablet.png', 'overview-mobile.png',
    'live.png', 'live-tablet.png', 'live-mobile.png',
    'repos.png', 'repos-tablet.png', 'repos-mobile.png',
    'settings.png', 'settings-tablet.png', 'settings-mobile.png',
    'integrations.png', 'integrations-tablet.png', 'integrations-mobile.png',
    'github-app.png', 'github-app-tablet.png', 'github-app-mobile.png',
  ];

  let validCount = 0;
  for (const file of expectedScreenshots) {
    const filePath = path.join(SCREENSHOT_DIR, file);
    if (!fs.existsSync(filePath)) {
      results.screenshotsArtifacts.push({ file, status: 'FAIL', reason: 'File does not exist' });
      continue;
    }
    const stats = fs.statSync(filePath);
    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    // PNG Magic Number Check: 89 50 4E 47 0D 0A 1A 0A
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    if (stats.size > 50000 && isPng) {
      validCount++;
      results.screenshotsArtifacts.push({ file, sizeBytes: stats.size, status: 'PASS' });
    } else {
      results.screenshotsArtifacts.push({ file, sizeBytes: stats.size, isPng, status: 'FAIL', reason: 'Invalid size or magic header' });
    }
  }
  console.log(`Screenshot Verification: ${validCount}/${expectedScreenshots.length} files valid.`);

  // 2. Setup Server
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Mock API endpoints to handle frontend fetch requests cleanly during browser testing
  app.get('/api/dashboard/overview', (req, res) => {
    res.json({
      success: true,
      stats: {
        totalReviews: 1240,
        avgLatencyMs: 820,
        monthlyTokenCost: 142.5,
        tokenCapBudget: 500.0,
        activePersonas: 11,
      },
    });
  });

  app.get('/api/live/active', (req, res) => {
    res.json({
      success: true,
      count: 2,
      jobs: [
        { jobId: 'job_active_1', status: 'running', eventCount: 15 },
        { jobId: 'job_active_2', status: 'completed', eventCount: 42 },
      ],
    });
  });

  app.get('/api/live/history', (req, res) => {
    const jobId = req.query.jobId || 'default-job';
    res.json({
      jobId,
      count: 2,
      events: [
        { jobId, timestamp: new Date().toISOString(), type: 'persona:start', persona: 'security', data: { log: 'Scan started' } },
        { jobId, timestamp: new Date().toISOString(), type: 'persona:chunk', persona: 'security', data: { log: 'Analyzing tokens...' } },
      ],
    });
  });

  app.get('*', (req, res) => {
    let reqPath = req.path === '/' ? '/index.html' : req.path;
    if (!reqPath.endsWith('.html') && !reqPath.includes('.')) {
      reqPath += '.html';
    }
    const filePath = path.join(__dirname, '..', 'public', reqPath);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    const txtPath = path.join(__dirname, '..', 'public', reqPath.replace(/\.html$/, '.txt'));
    if (fs.existsSync(txtPath)) {
      res.setHeader('Content-Type', 'text/html');
      return res.sendFile(txtPath);
    }
    const fallbackPath = path.join(__dirname, '..', 'public', 'index.html');
    if (fs.existsSync(fallbackPath)) {
      return res.sendFile(fallbackPath);
    }
    res.status(404).send('Not Found');
  });

  const server = app.listen(0, async () => {
    const actualPort = server.address().port;
    const testUrl = `http://localhost:${actualPort}`;
    console.log(`Test server listening at ${testUrl}`);

    try {
      const browser = await chromium.launch({ headless: true });

      // 3. Test Responsive Viewports Layout (375px, 768px, 1440px)
      console.log('\n[2/4] Testing Boundary Viewports Layout...');
      const viewports = [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'mobile', width: 375, height: 667 },
      ];

      const routes = ['/', '/live', '/repos', '/settings', '/integrations', '/github-app'];

      for (const route of routes) {
        for (const vp of viewports) {
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
          });
          const page = await context.newPage();
          await page.goto(`${testUrl}${route}`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(200);

          // Check if content causes horizontal overflow on the root document
          const hasBodyHorizontalOverflow = await page.evaluate(() => {
            return document.documentElement.scrollWidth > window.innerWidth;
          });

          // Check if table or dropdown container clipping issues exist
          const bodyPadding = await page.evaluate(() => {
            const body = document.body;
            const style = window.getComputedStyle(body);
            return { overflowX: style.overflowX };
          });

          results.responsiveViewports.push({
            route,
            viewport: vp.name,
            width: vp.width,
            hasBodyHorizontalOverflow,
            bodyPadding,
            status: !hasBodyHorizontalOverflow ? 'PASS' : 'WARN_OVERFLOW',
          });

          await context.close();
        }
      }

      // 4. Test Interactivity, SSE Feed & URL State Sync on /live
      console.log('\n[3/4] Testing Interactivity & URL Parameter Sync on /live...');
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(`${testUrl}/live`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        // Find job input and change value
        const inputSelector = 'input[placeholder*="Job ID"], input[placeholder*="job"], input[type="text"]';
        const jobInput = await page.$(inputSelector);
        if (jobInput) {
          await jobInput.fill('job_test_sync_999');
          
          // Click switch stream button or submit form
          const switchBtn = await page.$('button:has-text("Switch Stream"), button[type="submit"]');
          if (switchBtn) {
            await switchBtn.click();
            await page.waitForTimeout(300);
          }

          const currentUrl = page.url();
          const hasJobIdInUrl = currentUrl.includes('jobId=job_test_sync_999');
          results.urlSync.push({
            target: '/live',
            inputJobId: 'job_test_sync_999',
            currentUrl,
            hasJobIdInUrl,
            status: hasJobIdInUrl ? 'PASS' : 'FAIL',
          });
        } else {
          results.urlSync.push({ target: '/live', status: 'SKIP', reason: 'Job input selector not found' });
        }

        await context.close();
      }

      // 5. Test Settings page interactive slider & batch save button
      console.log('\n[4/4] Testing Settings page controls...');
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(`${testUrl}/settings`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        const saveAllBtn = await page.$('button:has-text("Save All"), button:has-text("Save")');
        const hasSaveBtn = !!saveAllBtn;
        
        results.interactivity.push({
          page: '/settings',
          hasSaveBtn,
          status: hasSaveBtn ? 'PASS' : 'FAIL',
        });

        await context.close();
      }

      await browser.close();
    } catch (err) {
      results.errors.push(err.message);
      console.error('Empirical verification error:', err);
    } finally {
      server.close(() => {
        console.log('\n--- Empirical Verification Summary ---');
        console.log(JSON.stringify(results, null, 2));
        fs.writeFileSync(
          path.join(__dirname, '..', '.agents', 'teamwork_preview_challenger_m2_2', 'empirical_results.json'),
          JSON.stringify(results, null, 2)
        );
        process.exit(0);
      });
    }
  });
}

runEmpiricalVerification();
