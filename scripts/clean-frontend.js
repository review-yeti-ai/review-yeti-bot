const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { ensureStaticAssets } = require('./ensure-static-assets');

const root = path.join(__dirname, '..');

function purgeNextDirs() {
  const dirs = [
    path.join(root, 'public', '_next'),
    path.join(root, 'out'),
    path.join(root, '.next'),
  ];
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
}

// Force-purge generated build output folders
try {
  execSync('rm -rf .next out pages public/_next public/dashboard dist/tsconfig.tsbuildinfo tsconfig.tsbuildinfo', { cwd: root });
} catch (e) {}

purgeNextDirs();

ensureStaticAssets();

purgeNextDirs();

console.log('[CleanFrontend] Pre-build cleanup completed successfully.');


