#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nodeFileTrace } from '@vercel/nft';

const require = createRequire(import.meta.url);
const packageRoot = process.cwd();
const outputRoot = path.resolve(packageRoot, process.argv[2] || '.worker-runtime');
const entrypoint = path.resolve(packageRoot, 'dist/cli/runLiveReview.js');

const requiredDynamicPackages = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@quintinshaw/pi-dynamic-workflows',
  'typebox',
];

const selfTestEntries = [
  'dist/gateway/openRouterClient.js',
  'dist/panel/panelEngine.js',
  'dist/github/publicationReceipt.js',
  'dist/k8s/reviewJobProjection.js',
  'dist/k8s/reviewJobDispatchEngine.js',
].map((relative) => path.resolve(packageRoot, relative));

const forbiddenPathParts = new Set(['.git', 'tests', 'coverage']);

function relativeSafe(absolutePath) {
  const relative = path.relative(packageRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`worker runtime path escapes repository: ${absolutePath}`);
  }
  const parts = relative.split(path.sep);
  if (parts.some((part) => forbiddenPathParts.has(part))) {
    throw new Error(`worker runtime path is excluded: ${relative}`);
  }
  return relative;
}

async function packageDirectory(packageName) {
  const packagePath = path.join(packageRoot, 'node_modules', ...packageName.split('/'));
  try {
    await fs.access(path.join(packagePath, 'package.json'));
    return packagePath;
  } catch {
    // Fall through for a package nested below a traced dependency.
  }
  let directory;
  try {
    directory = path.dirname(require.resolve(packageName));
  } catch {
    throw new Error(`could not locate package root for ${packageName}`);
  }
  while (directory !== path.dirname(directory)) {
    try {
      await fs.access(path.join(directory, 'package.json'));
      return directory;
    } catch {
      directory = path.dirname(directory);
    }
  }
  throw new Error(`could not locate package root for ${packageName}`);
}

async function copyFile(relative) {
  const source = path.join(packageRoot, relative);
  const destination = path.join(outputRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function digestFile(relative) {
  const bytes = await fs.readFile(path.join(outputRoot, relative));
  return createHash('sha256').update(bytes).digest('hex');
}

async function packageEntry(directory) {
  const packageJsonPath = path.join(directory, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const entry = packageJson.module || packageJson.main;
  if (typeof entry !== 'string' || entry.startsWith('../') || entry.includes('\\')) {
    throw new Error(`dynamic package has no safe entrypoint: ${packageJson.name || directory}`);
  }
  const entrypointPath = path.resolve(directory, entry);
  await fs.access(entrypointPath);
  return entrypointPath;
}

async function main() {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.access(entrypoint);

  const dynamicPackageRoots = [];
  const dynamicPackageEntries = [];
  for (const packageName of requiredDynamicPackages) {
    const directory = await packageDirectory(packageName);
    dynamicPackageRoots.push(directory);
    dynamicPackageEntries.push(await packageEntry(directory));
  }

  const trace = await nodeFileTrace(
    [entrypoint, ...selfTestEntries, ...dynamicPackageEntries],
    { base: packageRoot, processCwd: packageRoot },
  );
  const files = new Set();
  for (const traced of trace.fileList) {
    const absolute = path.resolve(packageRoot, traced);
    files.add(relativeSafe(absolute));
  }

  for (const directory of dynamicPackageRoots) {
    files.add(relativeSafe(path.join(directory, 'package.json')));
  }

  for (const relative of files) await copyFile(relative);

  const manifestFiles = [];
  for (const relative of [...files].sort()) {
    manifestFiles.push({ path: relative, sha256: await digestFile(relative) });
  }
  const manifest = {
    version: 'ReviewYetiWorkerRuntime.v1',
    entrypoint: 'dist/cli/runLiveReview.js',
    files: manifestFiles,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(outputRoot, 'runtime-manifest.json'), manifestBytes, 'utf8');
  process.stdout.write(`Staged ${manifestFiles.length} worker runtime files at ${outputRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
