'use strict';

function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))(?:[-+].*)?$/u.exec(String(version));
  if (!match || String(version).includes('-')) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function assertSupportedNodeVersion(version = process.version) {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`Node >=22.19.0 is required for review-engine=pi-workflow (found ${version}); provision Node 24 before invoking Review Yeti`);
  }
}

module.exports = { assertSupportedNodeVersion, isSupportedNodeVersion };
