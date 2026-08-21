#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`Review Yeti Pi runtime install failed: ${message}\n`);
  process.exit(1);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    fail(`Node >=22.19.0 is required for review-engine=pi-workflow (found ${process.version}); provision Node 24 before invoking Review Yeti`);
  }
}

function assertBoundedDirectory(directory, label) {
  const resolved = path.resolve(directory || '');
  const root = path.parse(resolved).root;
  if (!directory || resolved === root || resolved === os.homedir() || resolved.length < root.length + 8) {
    fail(`${label} is not a bounded directory`);
  }
  return resolved;
}

assertNodeVersion();
const actionRoot = assertBoundedDirectory(process.env.GITHUB_ACTION_PATH, 'GITHUB_ACTION_PATH');
const prefixRoot = assertBoundedDirectory(process.env.NPM_PREFIX, 'NPM_PREFIX');
const actionSha = String(process.env.REVIEW_YETI_ACTION_SHA || '').toLowerCase();
if (!/^[a-f0-9]{40}$/u.test(actionSha)) fail('REVIEW_YETI_ACTION_SHA must be the exact 40-hex Action source SHA');
const runtimeManifestRoot = path.join(actionRoot, 'pi-runtime');
if (!fs.existsSync(path.join(runtimeManifestRoot, 'package.json')) || !fs.existsSync(path.join(runtimeManifestRoot, 'package-lock.json'))) {
  fail('Action pi-runtime/package.json and pi-runtime/package-lock.json are missing');
}

fs.rmSync(prefixRoot, { recursive: true, force: true });
fs.mkdirSync(prefixRoot, { recursive: true });
fs.copyFileSync(path.join(runtimeManifestRoot, 'package.json'), path.join(prefixRoot, 'package.json'));
fs.copyFileSync(path.join(runtimeManifestRoot, 'package-lock.json'), path.join(prefixRoot, 'package-lock.json'));
const npmEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull };
for (const key of Object.keys(npmEnvironment)) {
  if (/^npm_config_allow_scripts(?:_pin)?$/iu.test(key)) delete npmEnvironment[key];
}
execFileSync('npm', [
  'ci',
  // npm 11 treats an absolute external --prefix as a package dependency when bundle metadata is
  // present. Running inside the bounded prefix and naming that same prefix as `.` retains exact
  // `npm ci --prefix <prefix>` semantics without the npm 11 self-package resolution defect.
  '--prefix', '.',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
], {
  stdio: 'inherit',
  cwd: prefixRoot,
  // User-level allow-scripts policies are intentionally not copied into this bounded prefix.
  // The Action path is stricter: all lifecycle scripts are disabled by the command above.
  env: npmEnvironment,
});

const provenanceModule = await import(pathToFileURL(path.join(actionRoot, 'src/provenance/buildProvenance.js')).href);
const provenanceApi = provenanceModule.default || provenanceModule;
const provenance = provenanceApi.createBuildProvenance({
  packageRoot: prefixRoot,
  runtimeSourceRevision: actionSha,
  requireNested: true,
});
provenanceApi.verifyBuildProvenance({ packageRoot: prefixRoot, provenance, requireNested: true });

const actionModules = path.join(actionRoot, 'node_modules');
fs.rmSync(actionModules, { recursive: true, force: true });
fs.cpSync(path.join(prefixRoot, 'node_modules'), actionModules, { recursive: true, dereference: false });
const provenancePath = path.join(actionRoot, 'src/provenance/generated-build-provenance.json');
provenanceApi.writeBuildProvenance(provenancePath, provenance);
// The attested install was verified from the bounded lock-backed prefix above. The Action copy is
// only an import surface and may have a different package-root path; do not re-resolve it against
// a consumer/app lockfile after the evidence has been captured.

// Both imports occur from the Action tree after attestation, never from the consumer workspace.
const packageManifest = JSON.parse(fs.readFileSync(path.join(actionModules, '@quintinshaw/pi-dynamic-workflows/package.json'), 'utf8'));
if (packageManifest.version !== '3.7.0') fail(`unexpected Pi workflow version ${packageManifest.version}`);
await import(pathToFileURL(path.join(actionModules, '@quintinshaw/pi-dynamic-workflows/dist/index.js')).href);
const wrapperRequire = createRequire(path.join(actionRoot, 'package.json'));
const wrapper = wrapperRequire('./src/pi/dynamicReviewWorkflow.js');
// Verify/import against the exact bounded prefix that was installed and attested above. The
// Action tree is only a copied import surface; resolving provenance from it would re-walk the
// consumer's layout and can produce a different graph digest even when the lock-backed install
// is correct.
await wrapper.loadPiWorkflowRuntime({ packageRoot: prefixRoot, provenance, requireNested: true });

// Resolve through the empty prefix as a final guard against accidentally importing a consumer copy.
const resolved = fs.realpathSync(path.join(prefixRoot, 'node_modules', '@quintinshaw', 'pi-dynamic-workflows', 'dist', 'index.js'));
const resolvedPrefixModules = fs.realpathSync(path.join(prefixRoot, 'node_modules'));
if (!resolved.startsWith(resolvedPrefixModules + path.sep)) fail('Pi runtime did not resolve from the lock-backed prefix');
process.stdout.write(`Pi workflow runtime ok ${packageManifest.version} graph ${provenance.runtimeGraphDigest}\n`);
