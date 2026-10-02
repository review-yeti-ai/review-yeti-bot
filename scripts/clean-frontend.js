const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { ensureStaticAssets } = require('./ensure-static-assets');

const root = path.join(__dirname, '..');
const lockFile = path.join(root, '.frontend-build.lock');

function waitForBuildLock() {
  const maxWaitMs = 90000;
  const start = Date.now();
  while (fs.existsSync(lockFile)) {
    try {
      const content = fs.readFileSync(lockFile, 'utf8').trim();
      const pid = parseInt(content, 10);
      if (!pid || isNaN(pid)) {
        try { fs.unlinkSync(lockFile); } catch (_) {}
        break;
      }
      process.kill(pid, 0);
      if (Date.now() - start > maxWaitMs) {
        console.warn(`[CleanFrontend] Timed out waiting for previous build lock (PID ${pid}), releasing lock.`);
        try { fs.unlinkSync(lockFile); } catch (_) {}
        break;
      }
      const sleepUntil = Date.now() + 500;
      while (Date.now() < sleepUntil) {}
    } catch (_) {
      try { fs.unlinkSync(lockFile); } catch (_) {}
      break;
    }
  }
}

function isNextBuildRunning() {
  try {
    const stdout = execSync("pgrep -f 'node.*next.*build' || true", { encoding: 'utf8' }).trim();
    if (!stdout) return false;
    const pids = stdout.split('\n').map(p => parseInt(p.trim(), 10)).filter(Boolean);
    const selfPids = [process.pid, process.ppid];
    const otherPids = pids.filter(p => !selfPids.includes(p));
    return otherPids.length > 0;
  } catch (_) {
    return false;
  }
}

function waitForAnyNextBuild() {
  const maxWaitMs = 90000;
  const start = Date.now();
  while (isNextBuildRunning()) {
    if (Date.now() - start > maxWaitMs) {
      console.warn('[CleanFrontend] Timed out waiting for active next build to finish.');
      break;
    }
    const sleepUntil = Date.now() + 500;
    while (Date.now() < sleepUntil) {}
  }
}

waitForBuildLock();
waitForAnyNextBuild();
try {
  fs.writeFileSync(lockFile, String(process.ppid || process.pid));
} catch (_) {}

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


