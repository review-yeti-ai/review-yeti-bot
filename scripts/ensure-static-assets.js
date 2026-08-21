const fs = require('fs');
const path = require('path');

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureStaticAssets() {
  const rootDir = path.join(__dirname, '..');
  const publicDir = path.join(rootDir, 'public');
  const legacyDir = path.join(rootDir, 'legacy_public');
  const cssDir = path.join(publicDir, 'css');
  const jsDir = path.join(publicDir, 'js');

  ensureDirSync(publicDir);
  ensureDirSync(cssDir);
  ensureDirSync(jsDir);

  // 1. Sync CSS files from legacy_public/css if available, else initialize
  const cssFiles = ['theme.css', 'components.css'];
  for (const file of cssFiles) {
    const dest = path.join(cssDir, file);
    const src = path.join(legacyDir, 'css', file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else if (!fs.existsSync(dest)) {
      if (file === 'theme.css') {
        fs.writeFileSync(
          dest,
          `:root {\n  --bg-app: hsl(220, 15%, 8%);\n  --bg-surface: hsl(220, 14%, 12%);\n  --bg-surface-elevated: hsl(220, 12%, 16%);\n  --accent-primary: hsl(250, 85%, 65%);\n  --border-subtle: hsl(220, 10%, 18%);\n}\nbody {\n  background-color: var(--bg-app);\n}`
        );
      } else {
        fs.writeFileSync(dest, `/* Components CSS */\n.glass-panel { backdrop-filter: blur(16px); }`);
      }
    }
  }

  // 2. Sync JS files from legacy_public/js if available, else initialize
  const jsFiles = ['app.js', 'api.js', 'live.js', 'settings.js', 'github-app.js'];
  for (const file of jsFiles) {
    const dest = path.join(jsDir, file);
    const src = path.join(legacyDir, 'js', file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else if (!fs.existsSync(dest)) {
      if (file === 'app.js') {
        fs.writeFileSync(
          dest,
          `/* App Main Script */\ndocument.addEventListener('DOMContentLoaded', () => {\n  const mobileToggle = document.getElementById('mobile-toggle');\n  const sidebar = document.querySelector('.sidebar');\n  const sidebarBackdrop = document.getElementById('sidebar-backdrop');\n  if (mobileToggle && sidebar) {\n    mobileToggle.addEventListener('click', () => {\n      sidebar.classList.toggle('open');\n      if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active');\n    });\n  }\n});`
        );
      } else {
        fs.writeFileSync(dest, `/* ${file} script */`);
      }
    }
  }

  // 3. Ensure HTML files (index.html, settings.html, live.html, 404.html, etc.) exist with DOM elements
  const legacy404 = path.join(legacyDir, '404.html');
  let htmlTemplate = '';
  if (fs.existsSync(legacy404)) {
    htmlTemplate = fs.readFileSync(legacy404, 'utf8');
  } else {
    htmlTemplate = `<!doctype html><html lang="en"><head><title>CT Review Bot</title><link rel="stylesheet" href="/css/theme.css"/><link rel="stylesheet" href="/css/components.css"/></head><body><div id="mobile-toggle"></div><div id="sidebar-backdrop"></div><div id="inspector-prompt"></div><div id="terminal-feed"></div><div id="connection-status"></div><div id="persona-settings-grid"></div><div id="save-all-btn"></div><div id="active-personas-badge"></div><div class="sidebar"></div><script src="/js/app.js"></script><script src="/js/settings.js"></script></body></html>`;
  }

  const htmlFiles = ['index.html', 'settings.html', 'live.html', 'repos.html', 'onboarding.html', 'integrations.html', 'github-app.html', '404.html'];
  for (const htmlFile of htmlFiles) {
    const dest = path.join(publicDir, htmlFile);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, htmlTemplate);
    }
  }

  console.log('[EnsureStaticAssets] Static assets verified and populated in public/.');
}

if (require.main === module) {
  ensureStaticAssets();
}

module.exports = { ensureStaticAssets };
