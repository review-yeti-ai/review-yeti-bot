#!/usr/bin/env node

/**
 * Rebuilds the public, neutral WS5 introduction→repair source fixture.
 * It writes only below the requested output root and refuses to overwrite an existing bundle.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..',
  'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1');
const AUTHOR_NAME = 'Review Yeti Synthetic Fixture';
const AUTHOR_EMAIL = 'review-yeti-fixtures@example.invalid';
const REPOSITORY = { repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' };
const PR_NUMBER = 41;

const BASE_FILES = {
  'audience-policy.ts': [
    'export type Audience = "public" | "private";',
    'export type Request = { audience: Audience };',
    'export type Route = { audience: Audience };',
    '',
    'export function permits(request: Request, route: Route): boolean {',
    '  return request.audience === route.audience;',
    '}',
    '',
  ].join('\n'),
  'router.ts': [
    'import { permits, Request, Route } from "./audience-policy";',
    '',
    'export function dispatch(request: Request, route: Route): "allow" | "deny" {',
    '  return permits(request, route) ? "allow" : "deny";',
    '}',
    '',
  ].join('\n'),
};

const INTRODUCTION_FILES = {
  'audience-policy.ts': [
    'export type Audience = "public" | "private";',
    'export type Request = { audience?: Audience };',
    'export type Route = { audience: Audience };',
    '',
    'export function permits(request: Request, route: Route): boolean {',
    '  const requestedAudience = request.audience ?? route.audience;',
    '  return requestedAudience === route.audience;',
    '}',
    '',
  ].join('\n'),
  'router.ts': [
    'import { permits, Request, Route } from "./audience-policy";',
    '',
    'export function dispatch(request: Request, route: Route): "allow" | "deny" {',
    '  return permits(request, route) ? "allow" : "deny";',
    '}',
    '',
  ].join('\n'),
};

const REPAIR_FILES = {
  'audience-policy.ts': [
    'export type Audience = "public" | "private";',
    'export type Request = { audience?: Audience };',
    'export type Route = { audience: Audience };',
    '',
    'export function permits(request: Request, route: Route): boolean {',
    '  if (request.audience === undefined) return false;',
    '  return request.audience === route.audience;',
    '}',
    '',
  ].join('\n'),
  'router.ts': [
    'import { permits, Request, Route } from "./audience-policy";',
    '',
    'export function dispatch(request: Request, route: Route): "allow" | "deny" {',
    '  // Keep missing identity explicit at the policy boundary.',
    '  return permits(request, route) ? "allow" : "deny";',
    '}',
    '',
  ].join('\n'),
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(cwd, args, env = process.env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

function gitRaw(cwd, args, env = process.env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commitTree(directory, files, parentSha, message, minute) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  git(directory, ['add', '--all']);
  const treeSha = git(directory, ['write-tree']);
  const date = '2026-10-06T12:' + String(minute).padStart(2, '0') + ':00+00:00';
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
  const commitSha = git(directory, args, env);
  return { commitSha, treeSha, parentSha: parentSha || null, commitTimestamp: date, commitMessage: message };
}

function revisionFiles(directory, commitSha, files) {
  return Object.keys(files).sort().map((relativePath) => {
    const content = gitRaw(directory, ['show', commitSha + ':' + relativePath]);
    const gitBlobSha = git(directory, ['rev-parse', commitSha + ':' + relativePath]);
    return {
      path: relativePath,
      mode: '100644',
      gitBlobSha,
      sha256: sha256(content),
      content,
    };
  });
}

function changedSource(directory, baseSha, headSha) {
  const changedPaths = git(directory, ['diff', '--name-only', '-z', baseSha, headSha])
    .split('\0').filter(Boolean).sort();
  const patches = changedPaths.map((relativePath) => {
    const patch = gitRaw(directory, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff',
      '--unified=5', baseSha, headSha, '--', relativePath]);
    return { path: relativePath, patch, sha256: sha256(patch) };
  });
  return { changedPaths, patches };
}

function buildPhase(directory, commits, phase, caseId, baseSha, headSha) {
  const allRevisionFiles = [
    [commits.base.commitSha, BASE_FILES],
    [commits.introduction.commitSha, INTRODUCTION_FILES],
    [commits.repair.commitSha, REPAIR_FILES],
  ];
  const visibleRevisionFiles = phase === 'introduction' ? allRevisionFiles.slice(0, 2) : allRevisionFiles;
  const changed = changedSource(directory, baseSha, headSha);
  const input = {
    schemaVersion: 'WS5RepairReviewInput.v1',
    caseId,
    source: {
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      baseSha,
      headSha,
      changedPaths: changed.changedPaths,
      revisions: visibleRevisionFiles.map(([commitSha, files]) => {
        const record = [commits.base, commits.introduction, commits.repair]
          .find((entry) => entry.commitSha === commitSha);
        return { ...record, files: revisionFiles(directory, commitSha, files) };
      }),
      patches: changed.patches,
    },
    candidates: [],
  };
  return input;
}

export function buildWs5RepairSequence(outputRoot, { replaceExisting = false } = {}) {
  const root = path.resolve(outputRoot);
  if (fs.existsSync(root)) {
    if (!replaceExisting) throw new Error('repair_fixture_output_exists');
    const existingDescriptorPath = path.join(root, 'descriptor.json');
    if (!fs.existsSync(existingDescriptorPath)) throw new Error('repair_fixture_output_not_owned');
    let existingDescriptor;
    try { existingDescriptor = JSON.parse(fs.readFileSync(existingDescriptorPath, 'utf8')); }
    catch { throw new Error('repair_fixture_output_not_owned'); }
    if (existingDescriptor.schemaVersion !== 'WS5RepairSequenceBundle.v1'
      || !Array.isArray(existingDescriptor.phases)
      || !existingDescriptor.phases.some((entry) => entry.caseId === 'ws5-sequence-a-v1')) {
      throw new Error('repair_fixture_output_not_owned');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
  const temporaryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-repair-source-'));
  try {
    git(temporaryRepo, ['init', '--quiet']);
    git(temporaryRepo, ['config', 'user.name', AUTHOR_NAME]);
    git(temporaryRepo, ['config', 'user.email', AUTHOR_EMAIL]);
    const base = commitTree(temporaryRepo, BASE_FILES, null, 'Synthetic fixture revision', 0);
    const introduction = commitTree(temporaryRepo, INTRODUCTION_FILES, base.commitSha,
      'Synthetic fixture revision', 1);
    const repair = commitTree(temporaryRepo, REPAIR_FILES, introduction.commitSha,
      'Synthetic fixture revision', 2);
    const commits = { base, introduction, repair };

    const inputsDirectory = path.join(root, 'inputs');
    fs.mkdirSync(inputsDirectory, { recursive: true });
    const phases = [
      { phase: 'introduction', caseId: 'ws5-sequence-a-v1', baseSha: base.commitSha, headSha: introduction.commitSha },
      { phase: 'repair', caseId: 'ws5-sequence-b-v1', baseSha: introduction.commitSha, headSha: repair.commitSha },
    ].map((entry) => {
      const input = buildPhase(temporaryRepo, commits, entry.phase, entry.caseId, entry.baseSha, entry.headSha);
      const inputPath = 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/inputs/'
        + entry.caseId + '.json';
      const absolutePath = path.join(root, 'inputs', entry.caseId + '.json');
      const bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
      fs.writeFileSync(absolutePath, bytes, { mode: 0o644 });
      return {
        caseId: entry.caseId,
        phase: entry.phase,
        inputPath,
        inputSha256: sha256(bytes),
        baseSha: entry.baseSha,
        headSha: entry.headSha,
      };
    });

    const descriptor = {
      schemaVersion: 'WS5RepairSequenceBundle.v1',
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      baseSha: base.commitSha,
      introductionHeadSha: introduction.commitSha,
      repairHeadSha: repair.commitSha,
      commitChain: [base, introduction, repair],
      phases,
    };
    const descriptorPath = path.join(root, 'descriptor.json');
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o644 });
    return descriptor;
  } finally {
    fs.rmSync(temporaryRepo, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputRoot = process.argv[2] || DEFAULT_OUT;
    const descriptor = buildWs5RepairSequence(outputRoot, { replaceExisting: process.argv.includes('--force') });
    process.stdout.write(JSON.stringify({
      status: 'written',
      baseSha: descriptor.baseSha,
      introductionHeadSha: descriptor.introductionHeadSha,
      repairHeadSha: descriptor.repairHeadSha,
      cases: descriptor.phases.map(({ caseId, inputSha256, baseSha, headSha }) => ({ caseId, inputSha256, baseSha, headSha })),
      descriptorSha256: sha256(fs.readFileSync(path.join(outputRoot, 'descriptor.json'))),
    }, null, 2) + '\n');
  } catch (error) {
    const candidate = String(error?.message || error);
    process.stderr.write('repair fixture failed closed: '
      + (/^[A-Za-z0-9_-]{1,100}$/u.test(candidate) ? candidate : 'fixture_generation_error') + '\n');
    process.exitCode = 2;
  }
}
