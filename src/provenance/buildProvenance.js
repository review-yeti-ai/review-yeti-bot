'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256 } = require('../review/reviewCore');

const BUILD_PROVENANCE_SCHEMA_VERSION = 'review-yeti-build-provenance.v1';
const DIRECT_PI_RUNTIME_PACKAGES = Object.freeze([
  '@quintinshaw/pi-dynamic-workflows',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
]);
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PACKAGES = 2_000;
const MAX_PACKAGE_FILES = 50_000;

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJson(filePath, label = filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function resolveInstalledPackageDir(packageRoot, fromPackageDir, packageName) {
  let cursor = path.resolve(fromPackageDir);
  const boundary = path.resolve(packageRoot);
  while (cursor === boundary || isInside(boundary, cursor)) {
    const candidate = path.join(cursor, 'node_modules', ...packageName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (cursor === boundary) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

function installedDependencyNames(manifest) {
  const names = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
  ]);
  return [...names].sort();
}

function digestPackageFiles(packageDir) {
  const records = [];
  function visit(directory, prefix = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        records.push([relative, 'link', fs.readlinkSync(absolute)]);
      } else if (entry.isFile()) {
        records.push([relative, 'file', crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
      }
      if (records.length > MAX_PACKAGE_FILES) throw new Error(`runtime package contains more than ${MAX_PACKAGE_FILES} files: ${packageDir}`);
    }
  }
  visit(packageDir);
  return sha256(canonicalJson(records));
}

function lockIntegrityMap(packageRoot) {
  const lockPath = path.join(packageRoot, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return new Map();
  const lock = readJson(lockPath, 'package-lock.json');
  if (!lock.packages || typeof lock.packages !== 'object') throw new Error('package-lock.json must contain a packages graph');
  return new Map(Object.entries(lock.packages).map(([packagePath, entry]) => [
    packagePath.split(path.sep).join('/'),
    entry && typeof entry === 'object' ? entry.integrity || null : null,
  ]));
}

function graphDigest(graph) {
  // Package managers may legally place the same bundled closure at different nested paths
  // (for example, an ordinary consumer install can nest a peer while the release workspace
  // hoists it one level). Bind the attestation to package identity, content, integrity, and
  // resolved dependency identities—not to the consumer-specific filesystem layout.
  const packages = graph.packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    integrity: entry.integrity,
    contentDigest: entry.contentDigest,
    dependencies: (entry.dependencies || []).map((dependency) => ({
      name: dependency.name,
      version: dependency.version,
    })).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en')),
  })).sort((left, right) => `${left.name}@${left.version}:${left.contentDigest}`.localeCompare(`${right.name}@${right.version}:${right.contentDigest}`, 'en'));
  return sha256(canonicalJson({ roots: graph.roots, packages }));
}

function runtimeGraphFromInstall(options = {}) {
  const packageRoot = fs.realpathSync(path.resolve(options.packageRoot || path.resolve(__dirname, '../..')));
  const nodeModulesRoot = path.join(packageRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesRoot)) throw new Error(`runtime node_modules is missing under ${packageRoot}`);
  const hasLockfile = fs.existsSync(path.join(packageRoot, 'package-lock.json'));
  const lockIntegrities = lockIntegrityMap(packageRoot);
  const suppliedIntegrities = new Map((options.integrities || []).map((entry) => [entry.path, entry.integrity]));
  const suppliedIdentityIntegrities = new Map();
  for (const entry of options.integrities || []) {
    const key = `${entry.name}@${entry.version}`;
    if (typeof entry.integrity === 'string' && !suppliedIdentityIntegrities.has(key)) {
      suppliedIdentityIntegrities.set(key, entry.integrity);
    }
  }
  const requireNested = options.requireNested === true;
  const pending = [];
  for (const name of DIRECT_PI_RUNTIME_PACKAGES) {
    const packageDir = resolveInstalledPackageDir(packageRoot, packageRoot, name);
    if (!packageDir) throw new Error(`required Pi runtime package is missing: ${name}`);
    if (requireNested && !isInside(nodeModulesRoot, packageDir)) throw new Error(`Pi runtime package is hoisted outside the nested bundle: ${name}`);
    pending.push(packageDir);
  }

  const visited = new Map();
  while (pending.length) {
    const packageDir = pending.shift();
    const relativePath = posixRelative(packageRoot, packageDir);
    if (!relativePath.startsWith('node_modules/')) throw new Error(`runtime dependency resolved outside package bundle: ${relativePath}`);
    if (visited.has(relativePath)) continue;
    if (visited.size >= MAX_PACKAGES) throw new Error(`Pi runtime dependency closure exceeds ${MAX_PACKAGES} packages`);
    const manifest = readJson(path.join(packageDir, 'package.json'), `${relativePath}/package.json`);
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error(`runtime package lacks name/version: ${relativePath}`);
    const dependencies = [];
    for (const dependencyName of installedDependencyNames(manifest)) {
      const dependencyDir = resolveInstalledPackageDir(packageRoot, packageDir, dependencyName);
      const optional = Boolean(manifest.optionalDependencies?.[dependencyName] || manifest.peerDependenciesMeta?.[dependencyName]?.optional);
      if (!dependencyDir) {
        if (optional) continue;
        throw new Error(`runtime dependency ${dependencyName} required by ${manifest.name}@${manifest.version} is missing`);
      }
      // Optional peer packages resolved from the release workspace's top-level app install are
      // not part of the Pi bundle and are not guaranteed to exist for an ordinary npm consumer.
      // Ignore that ambient resolution; retain optional peers that are actually nested in the
      // runtime closure.
      const topLevelOptional = optional && dependencyDir === path.join(packageRoot, 'node_modules', ...dependencyName.split('/'));
      if (topLevelOptional) continue;
      const dependencyPath = posixRelative(packageRoot, dependencyDir);
      if (!dependencyPath.startsWith('node_modules/')) throw new Error(`runtime dependency is hoisted outside the nested bundle: ${dependencyName}`);
      const dependencyManifest = readJson(path.join(dependencyDir, 'package.json'), `${dependencyPath}/package.json`);
      dependencies.push(Object.freeze({ name: dependencyName, version: dependencyManifest.version, path: dependencyPath }));
      pending.push(dependencyDir);
    }
    const integrity = suppliedIntegrities.get(relativePath)
      || lockIntegrities.get(relativePath)
      || (!hasLockfile ? suppliedIdentityIntegrities.get(`${manifest.name}@${manifest.version}`) : null)
      || null;
    if (options.requireIntegrities === true && !integrity) throw new Error(`lock integrity is missing for runtime package ${relativePath}`);
    visited.set(relativePath, Object.freeze({
      path: relativePath,
      name: manifest.name,
      version: manifest.version,
      integrity,
      contentDigest: digestPackageFiles(packageDir),
      dependencies: Object.freeze(dependencies.sort((left, right) => left.name.localeCompare(right.name, 'en'))),
    }));
  }

  const packages = Object.freeze([...visited.values()].sort((left, right) => left.path.localeCompare(right.path, 'en')));
  const roots = Object.freeze([...DIRECT_PI_RUNTIME_PACKAGES]);
  return Object.freeze({ roots, packages, digest: graphDigest({ roots, packages }) });
}

function createBuildProvenance(options = {}) {
  const runtimeSourceRevision = String(options.runtimeSourceRevision || '').toLowerCase();
  if (!SHA1.test(runtimeSourceRevision)) throw new TypeError('runtimeSourceRevision must be an exact 40-hex commit SHA');
  const graph = runtimeGraphFromInstall({
    packageRoot: options.packageRoot,
    requireNested: options.requireNested === true,
  });
  const directPackages = {};
  for (const name of DIRECT_PI_RUNTIME_PACKAGES) {
    const entry = graph.packages.find((candidate) => candidate.path === `node_modules/${name}`);
    if (!entry) throw new Error(`direct Pi package is not rooted in the package bundle: ${name}`);
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      throw new Error(`reviewed lock integrity is missing for direct Pi package: ${name}`);
    }
    directPackages[name] = Object.freeze({ version: entry.version, integrity: entry.integrity });
  }
  return Object.freeze({
    schema: BUILD_PROVENANCE_SCHEMA_VERSION,
    runtimeSourceRevision,
    directPackages: Object.freeze(directPackages),
    roots: graph.roots,
    packages: graph.packages,
    runtimeGraphDigest: graph.digest,
  });
}

function validateProvenanceShape(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new TypeError('build provenance must be an object');
  if (provenance.schema !== BUILD_PROVENANCE_SCHEMA_VERSION) throw new Error('unknown build provenance schema');
  if (!SHA1.test(String(provenance.runtimeSourceRevision || ''))) throw new Error('build provenance runtime source revision is invalid');
  if (!Array.isArray(provenance.roots) || canonicalJson(provenance.roots) !== canonicalJson(DIRECT_PI_RUNTIME_PACKAGES)) {
    throw new Error('build provenance runtime roots mismatch');
  }
  if (!Array.isArray(provenance.packages) || provenance.packages.length === 0 || provenance.packages.length > MAX_PACKAGES) {
    throw new Error('build provenance package closure is invalid');
  }
  if (!SHA256.test(String(provenance.runtimeGraphDigest || ''))) throw new Error('build provenance runtime graph digest is invalid');
  const declaredDigest = graphDigest({ roots: provenance.roots, packages: provenance.packages });
  if (declaredDigest !== provenance.runtimeGraphDigest) throw new Error('build provenance runtime graph digest does not match its closure');
  for (const name of DIRECT_PI_RUNTIME_PACKAGES) {
    const direct = provenance.directPackages?.[name];
    const closure = provenance.packages.find((entry) => entry.path === `node_modules/${name}`);
    if (!direct || !closure || direct.version !== closure.version || direct.integrity !== closure.integrity) {
      throw new Error(`build provenance direct package mismatch: ${name}`);
    }
  }
}

function verifyBuildProvenance(options = {}) {
  const provenance = options.provenance;
  validateProvenanceShape(provenance);
  const actual = runtimeGraphFromInstall({
    packageRoot: options.packageRoot,
    requireNested: options.requireNested === true,
    integrities: provenance.packages,
  });
  if (actual.digest !== provenance.runtimeGraphDigest) {
    throw new Error(`installed Pi runtime graph does not match build provenance: expected ${provenance.runtimeGraphDigest}, got ${actual.digest}`);
  }
  return provenance;
}

function writeBuildProvenance(filePath, provenance) {
  validateProvenanceShape(provenance);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(provenance)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadBuildProvenance(filePath) {
  const provenance = readJson(filePath, 'build provenance');
  validateProvenanceShape(provenance);
  return provenance;
}

module.exports = {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  DIRECT_PI_RUNTIME_PACKAGES,
  createBuildProvenance,
  loadBuildProvenance,
  runtimeGraphFromInstall,
  verifyBuildProvenance,
  writeBuildProvenance,
};
