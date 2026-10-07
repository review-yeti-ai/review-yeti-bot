#!/usr/bin/env node

/** Build a neutral, source-only P2 display-sort regression with complete base/head snapshots. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..',
  'eval-baselines/competitive-review-benchmark/ws5-p2-display-sort-v1');
const AUTHOR_NAME = 'Review Yeti Synthetic Fixture';
const AUTHOR_EMAIL = 'review-yeti-fixtures@example.invalid';
const REPOSITORY = { repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' };
const PR_NUMBER = 43;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runGit(cwd, args, { raw = false, env = process.env } = {}) {
  const value = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return raw ? value : value.trimEnd();
}

function baseFiles() {
  return {
    'src/catalog-sort.ts': [
      'export type CatalogItem = { id: string; label: string; visible: boolean };',
      '',
      'export function visibleCatalog(items: CatalogItem[]): CatalogItem[] {',
      '  return items',
      '    .filter((item) => item.visible)',
      '    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));',
      '}',
      '',
    ].join('\n'),
    'src/catalog-screen.ts': [
      'import { CatalogItem, visibleCatalog } from "./catalog-sort";',
      '',
      'export function catalogRows(items: CatalogItem[]): string[] {',
      '  return visibleCatalog(items).map((item) => item.id + ": " + item.label);',
      '}',
      '',
    ].join('\n'),
    'test/catalog-sort.test.ts': [
      'import { describe, expect, it } from "vitest";',
      'import { visibleCatalog } from "../src/catalog-sort";',
      '',
      'describe("visibleCatalog", () => {',
      '  it("keeps stable identifier order for equal display labels", () => {',
      '    const items = [',
      '      { id: "item-b", label: "Standard", visible: true },',
      '      { id: "item-a", label: "Standard", visible: true },',
      '    ];',
      '    expect(visibleCatalog(items).map((item) => item.id)).toEqual(["item-a", "item-b"]);',
      '  });',
      '});',
      '',
    ].join('\n'),
  };
}

function headFiles() {
  const files = baseFiles();
  files['src/catalog-sort.ts'] = files['src/catalog-sort.ts'].replace(
    '    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));',
    '    .sort((left, right) => left.label.localeCompare(right.label));',
  );
  return files;
}

function commitTree(directory, files, parentSha, message, minute) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  runGit(directory, ['add', '--all']);
  const treeSha = runGit(directory, ['write-tree']);
  const date = '2026-10-06T13:' + String(minute).padStart(2, '0') + ':00+00:00';
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  const args = ['commit-tree', treeSha];
  if (parentSha) args.push('-p', parentSha);
  args.push('-m', message);
  return {
    commitSha: runGit(directory, args, { env }), treeSha, parentSha: parentSha || null,
    commitTimestamp: date, commitMessage: message,
  };
}

function revisionFiles(directory, revision, files) {
  return Object.keys(files).sort().map((relativePath) => {
    const content = runGit(directory, ['show', revision.commitSha + ':' + relativePath], { raw: true });
    return {
      path: relativePath,
      mode: '100644',
      gitBlobSha: runGit(directory, ['rev-parse', revision.commitSha + ':' + relativePath]),
      sha256: sha256(content),
      content,
    };
  });
}

function changedSource(directory, baseSha, headSha) {
  const changedPaths = runGit(directory, ['diff', '--name-only', '-z', baseSha, headSha])
    .split('\0').filter(Boolean).sort();
  const patches = changedPaths.map((relativePath) => {
    const patch = runGit(directory, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff',
      '--unified=5', baseSha, headSha, '--', relativePath], { raw: true });
    return { path: relativePath, patch, sha256: sha256(patch) };
  });
  return { changedPaths, patches };
}

export function buildWs5P2DisplaySortFixture(outputRoot) {
  const root = path.resolve(outputRoot);
  if (fs.existsSync(root)) throw new Error('p2_fixture_output_exists');
  fs.mkdirSync(root, { recursive: true });
  const temporaryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-p2-display-sort-'));
  try {
    runGit(temporaryRepo, ['init', '--quiet']);
    runGit(temporaryRepo, ['config', 'user.name', AUTHOR_NAME]);
    runGit(temporaryRepo, ['config', 'user.email', AUTHOR_EMAIL]);
    const base = commitTree(temporaryRepo, baseFiles(), null, 'Synthetic display ordering contract', 20);
    const head = commitTree(temporaryRepo, headFiles(), base.commitSha,
      'Remove stable tie-breaker from display ordering', 21);
    const changed = changedSource(temporaryRepo, base.commitSha, head.commitSha);
    const input = {
      schemaVersion: 'WS5P2DisplaySortInput.v1',
      caseId: 'ws5-p2-display-sort-v1',
      source: {
        repository: REPOSITORY,
        prNumber: PR_NUMBER,
        baseSha: base.commitSha,
        headSha: head.commitSha,
        changedPaths: changed.changedPaths,
        revisions: [
          { ...base, files: revisionFiles(temporaryRepo, base, baseFiles()) },
          { ...head, files: revisionFiles(temporaryRepo, head, headFiles()) },
        ],
        patches: changed.patches,
      },
    };
    const inputPath = 'eval-baselines/competitive-review-benchmark/ws5-p2-display-sort-v1/inputs/ws5-p2-display-sort-v1.json';
    const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
    fs.mkdirSync(path.join(root, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inputs/ws5-p2-display-sort-v1.json'), inputBytes, { mode: 0o644 });
    const patchBytes = changed.patches.reduce((sum, entry) => sum + Buffer.byteLength(entry.patch, 'utf8'), 0);
    const descriptor = {
      schemaVersion: 'WS5P2DisplaySortBundle.v1',
      caseId: input.caseId,
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      baseSha: base.commitSha,
      headSha: head.commitSha,
      baseTreeSha: base.treeSha,
      headTreeSha: head.treeSha,
      changedFileCount: changed.changedPaths.length,
      patchBytes,
      inputPath,
      inputSha256: sha256(inputBytes),
      commitChain: [base, head],
    };
    fs.writeFileSync(path.join(root, 'descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o644 });
    return descriptor;
  } finally {
    fs.rmSync(temporaryRepo, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const descriptor = buildWs5P2DisplaySortFixture(process.argv[2] || DEFAULT_OUT);
    process.stdout.write(JSON.stringify(descriptor, null, 2) + '\n');
  } catch (error) {
    const code = String(error?.message || error);
    process.stderr.write('P2 fixture failed closed: '
      + (/^[A-Za-z0-9_-]{1,100}$/u.test(code) ? code : 'fixture_generation_error') + '\n');
    process.exitCode = 2;
  }
}
