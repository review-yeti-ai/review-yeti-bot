#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NEXT_STATIC_PREFIX = '/_next/static/';
const HTML_URL_ATTRIBUTE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;

function listHtmlFiles(directory, relativeDirectory = '') {
  const htmlFiles = [];
  for (const entry of fs.readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      htmlFiles.push(...listHtmlFiles(directory, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      htmlFiles.push(relativePath);
    }
  }
  return htmlFiles.sort();
}

function nextStaticReferences(html) {
  const references = [];
  HTML_URL_ATTRIBUTE.lastIndex = 0;
  for (const match of html.matchAll(HTML_URL_ATTRIBUTE)) {
    const url = match[1] ?? match[2] ?? '';
    if (!url.startsWith(NEXT_STATIC_PREFIX)) continue;
    references.push(url.split(/[?#]/u, 1)[0]);
  }
  return references;
}

function inspectFrontendArtifacts({ publicDir = path.join(__dirname, '..', 'public') } = {}) {
  const absolutePublicDir = path.resolve(publicDir);
  const htmlFiles = listHtmlFiles(absolutePublicDir);
  const missing = [];
  const checked = new Set();

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(path.join(absolutePublicDir, htmlFile), 'utf8');
    for (const asset of nextStaticReferences(html)) {
      const key = `${htmlFile}\0${asset}`;
      if (checked.has(key)) continue;
      checked.add(key);

      let decodedAsset;
      try {
        decodedAsset = decodeURIComponent(asset);
      } catch {
        missing.push({ htmlFile, asset });
        continue;
      }

      const assetPath = path.resolve(absolutePublicDir, `.${decodedAsset}`);
      const relativeAssetPath = path.relative(absolutePublicDir, assetPath);
      if (relativeAssetPath.startsWith('..') || path.isAbsolute(relativeAssetPath)) {
        missing.push({ htmlFile, asset });
        continue;
      }

      try {
        const stat = fs.statSync(assetPath);
        if (!stat.isFile() || stat.size === 0) missing.push({ htmlFile, asset });
      } catch {
        missing.push({ htmlFile, asset });
      }
    }
  }

  return { coherent: missing.length === 0, htmlFiles: htmlFiles.length, references: checked.size, missing };
}

function reportMissing(result) {
  console.error(`[FrontendArtifacts] ${result.missing.length} HTML-referenced Next.js asset(s) are missing or empty:`);
  for (const entry of result.missing.slice(0, 20)) {
    console.error(`  ${entry.htmlFile} -> ${entry.asset}`);
  }
  if (result.missing.length > 20) {
    console.error(`  ... and ${result.missing.length - 20} more missing reference(s)`);
  }
}

function ensureFrontendArtifacts({
  publicDir = path.join(__dirname, '..', 'public'),
  rootDir = path.join(__dirname, '..'),
  buildFrontend = () => execFileSync('npm', ['run', 'build:frontend'], { cwd: rootDir, stdio: 'inherit' }),
} = {}) {
  const chunksDir = path.join(publicDir, '_next', 'static', 'chunks');
  let result = inspectFrontendArtifacts({ publicDir });
  if (fs.existsSync(chunksDir) && result.coherent) {
    console.log(`[FrontendArtifacts] Reusing ${result.references} verified reference(s) across ${result.htmlFiles} HTML file(s).`);
    return { ...result, rebuilt: false };
  }

  if (!result.coherent) reportMissing(result);
  else console.log('[FrontendArtifacts] Frontend chunk directory is absent; rebuilding frontend assets.');

  buildFrontend();
  result = inspectFrontendArtifacts({ publicDir });
  if (!result.coherent) {
    reportMissing(result);
    throw new Error('[FrontendArtifacts] Frontend build did not produce a coherent HTML and asset bundle.');
  }

  console.log(`[FrontendArtifacts] Rebuilt and verified ${result.references} reference(s) across ${result.htmlFiles} HTML file(s).`);
  return { ...result, rebuilt: true };
}

function verifyFrontendArtifacts() {
  const result = inspectFrontendArtifacts();
  if (!result.coherent) {
    reportMissing(result);
    process.exitCode = 1;
    return;
  }

  console.log(`[FrontendArtifacts] Verified ${result.references} Next.js asset reference(s) across ${result.htmlFiles} HTML file(s).`);
}

if (require.main === module) {
  if (process.argv.includes('--ensure')) ensureFrontendArtifacts();
  else verifyFrontendArtifacts();
}

module.exports = { ensureFrontendArtifacts, inspectFrontendArtifacts, nextStaticReferences };
