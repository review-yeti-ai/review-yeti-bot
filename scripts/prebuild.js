const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const publicNext = path.join(rootDir, 'public/_next');
const outDir = path.join(rootDir, 'out');

try {
  if (fs.existsSync(publicNext)) {
    fs.rmSync(publicNext, { recursive: true, force: true });
  }
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
} catch (e) {}

console.log('[Prebuild] Cleaned public/_next and out directories.');
