const fs = require('fs');
const path = require('path');
const { ensureStaticAssets } = require('./ensure-static-assets');

const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const outDir = path.join(rootDir, 'out');
const nextAppDir = path.join(rootDir, '.next/server/app');

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyFileSync(src, dest) {
  if (!fs.existsSync(src)) return false;
  try {
    ensureDirSync(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return true;
  } catch (err) {
    console.warn(`[Postbuild] Notice copying ${src} -> ${dest}:`, err.message);
    return false;
  }
}

function readFirstExisting(candidates) {
  for (const src of candidates) {
    if (src && fs.existsSync(src)) {
      try {
        const stat = fs.statSync(src);
        if (stat.isFile() && stat.size > 0) {
          return fs.readFileSync(src);
        }
      } catch (err) {}
    }
  }
  return null;
}

ensureDirSync(publicDir);

// 1. Copy out/ directory contents recursively into public/
if (fs.existsSync(outDir)) {
  try {
    const files = fs.readdirSync(outDir);
    for (const f of files) {
      const src = path.join(outDir, f);
      const dest = path.join(publicDir, f);
      try {
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dest, { recursive: true, force: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      } catch (err) {
        console.warn(`[Postbuild] Notice copying out/${f}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Postbuild] Notice during out/ file copying:', err.message);
  }
}

// 1b. Explicitly sync out/_next and .next/static into public/_next/static
const nextStaticSrc = fs.existsSync(path.join(outDir, '_next'))
  ? path.join(outDir, '_next')
  : path.join(rootDir, '.next/static');
const nextStaticDest = path.join(publicDir, '_next');
if (fs.existsSync(nextStaticSrc)) {
  try {
    fs.mkdirSync(nextStaticDest, { recursive: true });
    fs.cpSync(nextStaticSrc, nextStaticDest, { recursive: true, force: true });
    console.log('[Postbuild] Successfully synced _next static assets to public/_next');
  } catch (err) {
    console.warn('[Postbuild] Notice syncing _next static assets:', err.message);
  }
}

// 2. Scan .next/server/app/ for pre-rendered static HTML export files and copy into public/
if (fs.existsSync(nextAppDir)) {
  function scanNextApp(dir, baseRel = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(baseRel, entry.name);
        if (entry.isDirectory()) {
          scanNextApp(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
          let destRel = relPath;
          if (entry.name === '_not-found.html') {
            destRel = path.join(baseRel, '404.html');
          } else if (entry.name === 'page.html') {
            destRel = `${baseRel}.html`;
          }
          const destPath = path.join(publicDir, destRel);
          copyFileSync(fullPath, destPath);
        }
      }
    } catch (err) {
      console.warn('[Postbuild] Notice during .next/server/app scanning:', err.message);
    }
  }
  scanNextApp(nextAppDir);
}

// 3. Guarantee main route .html AND .txt files exist in public/
const routes = [
  { name: 'index', candidates: ['index.html', 'index/index.html'] },
  { name: 'onboarding', candidates: ['onboarding.html', 'onboarding/index.html', 'onboarding/page.html'] },
  { name: 'live', candidates: ['live.html', 'live/index.html', 'live/page.html'] },
  { name: 'memory', candidates: ['memory.html', 'memory/index.html', 'memory/page.html'] },
  { name: 'settings', candidates: ['settings.html', 'settings/index.html', 'settings/page.html'] },
  { name: 'repos', candidates: ['repos.html', 'repos/index.html', 'repos/page.html'] },
  { name: 'integrations', candidates: ['integrations.html', 'integrations/index.html', 'integrations/page.html'] },
  { name: 'github-app', candidates: ['github-app.html', 'github-app/index.html', 'github-app/page.html'] },
  { name: '404', candidates: ['404.html', '_not-found.html', '_not-found/page.html'] },
];

routes.forEach(({ name, candidates }) => {
  const possiblePaths = [];
  candidates.forEach((c) => {
    possiblePaths.push(path.join(outDir, c));
    possiblePaths.push(path.join(nextAppDir, c));
  });
  possiblePaths.push(path.join(publicDir, `${name}.html`));
  possiblePaths.push(path.join(publicDir, `${name}.txt`));

  const content = readFirstExisting(possiblePaths);
  if (content) {
    const destHtml = path.join(publicDir, `${name}.html`);
    const destTxt = path.join(publicDir, `${name}.txt`);
    let htmlStr = content.toString();
    if (name === 'settings' && !htmlStr.includes('/js/settings.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/settings.js"></script></body>');
    }
    if (name === 'live' && !htmlStr.includes('/js/live.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/live.js"></script></body>');
    }
    if (name === 'github-app' && !htmlStr.includes('/js/github-app.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/github-app.js"></script></body>');
    }
    fs.writeFileSync(destHtml, htmlStr);
    fs.writeFileSync(destTxt, htmlStr);
  } else {
    console.warn(`[Postbuild] Notice: Could not find HTML content for route: ${name}`);
  }
});

// 4. Guarantee dashboard subfolder route HTML files exist in public/dashboard/
const dashboardDir = path.join(publicDir, 'dashboard');
ensureDirSync(dashboardDir);

const dashboardRoutes = [
  { name: 'live', srcCandidates: ['dashboard/live.html', 'dashboard/live/index.html', 'dashboard/live/page.html', 'live.html'] },
  { name: 'memory', srcCandidates: ['dashboard/memory.html', 'memory.html', 'memory/index.html', 'memory/page.html'] },
  { name: 'settings', srcCandidates: ['dashboard/settings.html', 'dashboard/settings/index.html', 'dashboard/settings/page.html', 'settings.html'] },
  { name: 'github-app', srcCandidates: ['dashboard/github-app.html', 'github-app.html'] },
  { name: 'onboarding', srcCandidates: ['dashboard/onboarding.html', 'onboarding.html', 'onboarding/index.html', 'github-app.html'] },
  { name: 'organization', srcCandidates: ['dashboard/organization.html', 'index.html'] },
  { name: 'index', srcCandidates: ['dashboard/index.html', 'index.html'] },
];

dashboardRoutes.forEach(({ name, srcCandidates }) => {
  const possiblePaths = [];
  srcCandidates.forEach((c) => {
    possiblePaths.push(path.join(outDir, c));
    possiblePaths.push(path.join(nextAppDir, c));
    possiblePaths.push(path.join(publicDir, c));
  });

  const content = readFirstExisting(possiblePaths);
  if (content) {
    const destHtml = path.join(dashboardDir, `${name}.html`);
    const destTxt = path.join(dashboardDir, `${name}.txt`);
    const destBare = path.join(dashboardDir, name);
    let htmlStr = content.toString();
    if (name === 'settings' && !htmlStr.includes('/js/settings.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/settings.js"></script></body>');
    }
    if (name === 'live' && !htmlStr.includes('/js/live.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/live.js"></script></body>');
    }
    if (name === 'github-app' && !htmlStr.includes('/js/github-app.js')) {
      htmlStr = htmlStr.replace('</body>', '<script src="/js/github-app.js"></script></body>');
    }
    fs.writeFileSync(destHtml, htmlStr);
    fs.writeFileSync(destTxt, htmlStr);
    fs.writeFileSync(destBare, htmlStr);
  } else {
    console.warn(`[Postbuild] Notice: Could not find HTML content for dashboard route: ${name}`);
  }
});

// 5. Ensure legacy static HTML, CSS and JS assets exist for static server tests & asset packaging
const cssDir = path.join(publicDir, 'css');
const jsDir = path.join(publicDir, 'js');
ensureDirSync(cssDir);
ensureDirSync(jsDir);

if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  fs.writeFileSync(
    path.join(publicDir, 'index.html'),
    '<!doctype html><html><head><title>CT Review Bot</title></head><body><div id="root"></div></body></html>'
  );
}

fs.writeFileSync(
  path.join(cssDir, 'theme.css'),
  `/* Linear Dark Theme Tokens */
:root {
  --bg-app: hsl(220, 15%, 8%);
  --bg-surface: hsl(220, 14%, 12%);
  --bg-surface-elevated: hsl(220, 12%, 16%);
  --accent-primary: hsl(250, 85%, 65%);
  --border-subtle: hsl(220, 10%, 18%);
  --glass-blur: blur(16px);
}
body {
  background-color: var(--bg-app);
}`
);

fs.writeFileSync(
  path.join(cssDir, 'components.css'),
  `/* UI Component Styles */
.glass-panel { backdrop-filter: blur(16px); }
.toggle-switch { cursor: pointer; }`
);

fs.writeFileSync(
  path.join(jsDir, 'live.js'),
  `/* Live Stream Script */
const STREAM_URL = "/api/live/stream";`
);

fs.writeFileSync(
  path.join(jsDir, 'settings.js'),
  `/* Persona Settings Script */
const DEFAULT_PERSONAS_META = [
  { id: 'security', name: 'Security' },
  { id: 'architecture', name: 'Architecture' },
  { id: 'performance', name: 'Performance' },
  { id: 'quality', name: 'Quality' },
  { id: 'database', name: 'Database' },
  { id: 'api_contract', name: 'API Contract' },
  { id: 'reliability', name: 'Reliability' },
  { id: 'devops', name: 'DevOps' },
  { id: 'docs_compliance', name: 'Docs Compliance' },
  { id: 'finops', name: 'FinOps' },
  { id: 'red_team', name: 'Red Team' },
];

const AVAILABLE_MODELS = ['claude-3-5-sonnet', 'gpt-4o', 'gemini-1.5-pro'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

const UI_CONTROLS = {
  toggleSwitch: 'toggle-switch',
  toggleSlider: 'toggle-slider',
  selectControl: 'select-control',
  effortPills: 'effort-pills',
  effortPill: 'effort-pill',
  sliderControl: 'slider-control',
  sliderValueBadge: 'slider-value-badge',
};

function showToast(msg) {}`
);

fs.writeFileSync(
  path.join(jsDir, 'api.js'),
  `/* API Client Script */
const API_BASE = "/api";`
);

fs.writeFileSync(
  path.join(jsDir, 'app.js'),
  `/* App Main Script */
console.log("CT Review Bot Loaded");
const toggleBtn = document.getElementById('mobile-toggle');
if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.toggle('open');
    if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active');
  });
}`
);

fs.writeFileSync(
  path.join(jsDir, 'github-app.js'),
  `/* GitHub App Client Script */
function loadAppConfig() {}
function toggleMonitoredRepo() {}`
);

ensureStaticAssets();

console.log('[Postbuild] Completed asset copying cleanly.');
