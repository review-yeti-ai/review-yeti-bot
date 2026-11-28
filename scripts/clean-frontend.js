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

// Opt-in: keep Next's incremental compiler cache (.next/cache) while still
// purging every other generated output. Unset (or any value other than '1')
// keeps the original full-purge behavior.
const preserveNextCache = process.env.PRESERVE_NEXT_CACHE === '1';

waitForBuildLock();
waitForAnyNextBuild();
try {
  fs.writeFileSync(lockFile, String(process.ppid || process.pid));
} catch (_) {}

function purgeNextBuildDir() {
  const nextDir = path.join(root, '.next');
  if (!preserveNextCache) {
    try {
      fs.rmSync(nextDir, { recursive: true, force: true });
    } catch (_) {}
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(nextDir);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry === 'cache') continue;
    try {
      fs.rmSync(path.join(nextDir, entry), { recursive: true, force: true });
    } catch (_) {}
  }
}

function purgeNextDirs() {
  const dirs = [
    path.join(root, 'public', '_next'),
    path.join(root, 'out'),
  ];
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
  purgeNextBuildDir();
}

function releaseLockOnFailure() {
  // The lock intentionally outlives this script on success (postbuild.js
  // releases it after `next build`); only drop it when cleanup itself fails.
  try {
    fs.unlinkSync(lockFile);
  } catch (_) {}
}

try {
  // Force-purge generated build output folders
  const staticTargets = 'out pages public/_next public/dashboard dist/tsconfig.tsbuildinfo tsconfig.tsbuildinfo';
  try {
    execSync(`rm -rf ${preserveNextCache ? '' : '.next '}${staticTargets}`, { cwd: root });
  } catch (e) {}

  purgeNextDirs();

  ensureStaticAssets();

  purgeNextDirs();
} catch (err) {
  releaseLockOnFailure();
  throw err;
}

console.log(`[CleanFrontend] Pre-build cleanup completed successfully${preserveNextCache ? ' (preserved .next/cache)' : ''}.`);
