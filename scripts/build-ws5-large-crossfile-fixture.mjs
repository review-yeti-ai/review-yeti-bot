#!/usr/bin/env node

/** Deterministically builds one bounded, neutral, large cross-file WS5 canary input. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..',
  'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1');
const AUTHOR_NAME = 'Review Yeti Synthetic Fixture';
const AUTHOR_EMAIL = 'review-yeti-fixtures@example.invalid';
const REPOSITORY = { repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile' };
const PR_NUMBER = 42;
const MODULE_COUNT = 22;
const ROWS_PER_MODULE = 12;
const VALUE_BYTES = 144;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runGit(cwd, args, { raw = false, env = process.env } = {}) {
  const value = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw ? value : value.trimEnd();
}

function baseFiles() {
  const files = {
    'src/audience-policy.ts': [
      'export type Audience = "public" | "private";',
      'export type Request = { audience: Audience };',
      'export type Route = { audience: Audience };',
      '',
      'export function permits(requested: Audience, routeAudience: Audience): boolean {',
      '  return requested === routeAudience;',
      '}',
      '',
    ].join('\n'),
    'src/request-router.ts': [
      'import { permits, Request, Route } from "./audience-policy";',
      '',
      'export function dispatch(request: Request, route: Route): "allow" | "deny" {',
      '  return permits(request.audience, route.audience) ? "allow" : "deny";',
      '}',
      '',
    ].join('\n'),
  };
  for (let module = 1; module <= MODULE_COUNT; module += 1) {
    files['src/modules/module-' + String(module).padStart(2, '0') + '.ts'] = fillerFile(module, 'base');
  }
  return files;
}

function introductionFiles() {
  const files = {
    'src/audience-policy.ts': [
      'export type Audience = "public" | "private";',
      'export type Request = { audience?: Audience };',
      'export type Route = { audience: Audience };',
      '',
      'export function permits(requested: Audience | undefined, routeAudience: Audience): boolean {',
      '  if (requested === undefined) return true;',
      '  return requested === routeAudience;',
      '}',
      '',
    ].join('\n'),
    'src/request-router.ts': [
      'import { permits, Request, Route } from "./audience-policy";',
      '',
      'export function dispatch(request: Request, route: Route): "allow" | "deny" {',
      '  const requested = request.audience ?? route.audience;',
      '  return permits(requested, route.audience) ? "allow" : "deny";',
      '}',
      '',
    ].join('\n'),
  };
  for (let module = 1; module <= MODULE_COUNT; module += 1) {
    files['src/modules/module-' + String(module).padStart(2, '0') + '.ts'] = fillerFile(module, 'head');
  }
  return files;
}

function fillerFile(module, revision) {
  const lines = [
    '// Deterministic synthetic catalogue metadata; no credentials or customer content.',
    'export const catalogueModule' + String(module).padStart(2, '0') + ' = [',
  ];
  for (let row = 1; row <= ROWS_PER_MODULE; row += 1) {
    const value = revision === 'base' ? 'a' : 'b';
    const suffix = value.repeat(VALUE_BYTES);
    lines.push('  "' + revision + '-' + String(module).padStart(2, '0') + '-'
      + String(row).padStart(2, '0') + '-' + suffix + '",');
  }
  lines.push('] as const;', '');
  return lines.join('\n');
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
  return { commitSha: runGit(directory, args, { env }), treeSha,
    parentSha: parentSha || null, commitTimestamp: date, commitMessage: message };
}

function revisionFiles(directory, commitSha, files) {
  return Object.keys(files).sort().map((relativePath) => {
    const content = runGit(directory, ['show', commitSha + ':' + relativePath], { raw: true });
    return {
      path: relativePath,
      mode: '100644',
      gitBlobSha: runGit(directory, ['rev-parse', commitSha + ':' + relativePath]),
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

export function buildWs5LargeCrossfileFixture(outputRoot) {
  const root = path.resolve(outputRoot);
  if (fs.existsSync(root)) throw new Error('large_fixture_output_exists');
  fs.mkdirSync(root, { recursive: true });
  const temporaryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-large-crossfile-'));
  try {
    runGit(temporaryRepo, ['init', '--quiet']);
    runGit(temporaryRepo, ['config', 'user.name', AUTHOR_NAME]);
    runGit(temporaryRepo, ['config', 'user.email', AUTHOR_EMAIL]);
    const base = commitTree(temporaryRepo, baseFiles(), null, 'Synthetic fixture revision', 10);
    const introduction = commitTree(temporaryRepo, introductionFiles(), base.commitSha,
      'Synthetic fixture revision', 11);
    const changed = changedSource(temporaryRepo, base.commitSha, introduction.commitSha);
    const revisionFilesByCommit = [
      { revision: base, files: baseFiles() },
      { revision: introduction, files: introductionFiles() },
    ];
    const input = {
      schemaVersion: 'WS5LargeCrossfileInput.v1',
      caseId: 'ws5-large-crossfile-v1',
      source: {
        repository: REPOSITORY,
        prNumber: PR_NUMBER,
        baseSha: base.commitSha,
        headSha: introduction.commitSha,
        changedPaths: changed.changedPaths,
        revisions: revisionFilesByCommit.map(({ revision, files }) => ({
          ...revision,
          files: revisionFiles(temporaryRepo, revision.commitSha, files),
        })),
        patches: changed.patches,
      },
      candidates: [],
    };
    const inputPath = 'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1/inputs/ws5-large-crossfile-v1.json';
    const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
    fs.mkdirSync(path.join(root, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inputs/ws5-large-crossfile-v1.json'), inputBytes, { mode: 0o644 });
    const patchBytes = changed.patches.reduce((sum, entry) => sum + Buffer.byteLength(entry.patch, 'utf8'), 0);
    const descriptor = {
      schemaVersion: 'WS5LargeCrossfileBundle.v1',
      caseId: input.caseId,
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      baseSha: base.commitSha,
      headSha: introduction.commitSha,
      changedFileCount: changed.changedPaths.length,
      patchBytes,
      inputPath,
      inputSha256: sha256(inputBytes),
      commitChain: [base, introduction],
    };
    fs.writeFileSync(path.join(root, 'descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o644 });
    return descriptor;
  } finally {
    fs.rmSync(temporaryRepo, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const descriptor = buildWs5LargeCrossfileFixture(process.argv[2] || DEFAULT_OUT);
    process.stdout.write(JSON.stringify(descriptor, null, 2) + '\n');
  } catch (error) {
    const code = String(error?.message || error);
    process.stderr.write('large fixture failed closed: '
      + (/^[A-Za-z0-9_-]{1,100}$/u.test(code) ? code : 'fixture_generation_error') + '\n');
    process.exitCode = 2;
  }
}
