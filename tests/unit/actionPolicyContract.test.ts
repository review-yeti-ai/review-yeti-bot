import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

describe('Action v4 policy boundary', () => {
  it('reads bounded limits and submodule policy from trusted base configuration', () => {
    const policy = pipeline.resolveActionReviewPolicy({
      parsed: {
        version: 4,
        limits: { max_diff_bytes: 50000 },
        submodules: { mode: 'recursive', max_depth: 99, require_pinned_commit: true },
      },
    }, {});

    expect(policy.maxDiffChars).toBe(50000);
    expect(policy.submodules.mode).toBe('recursive');
    expect(policy.submodules.max_depth).toBe(5);
  });

  it('marks recursive and unpinned gitlink changes incomplete rather than successful', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', patch: '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ], { mode: 'recursive', require_pinned_commit: true });
    expect(result.coverageComplete).toBe(false);
    expect(result.files[0].isSubmodule).not.toBe(true);
  });

  it('does not treat a normal text file containing a subproject marker as a gitlink', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'docs/submodules.md', patch: 'diff --git a/docs/submodules.md b/docs/submodules.md\n+Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
    ], { mode: 'metadata_only', require_pinned_commit: true });
    expect(result.coverageComplete).toBe(false);
    expect(result.files[0].isSubmodule).not.toBe(true);
  });

  it('parses standard hunked gitlink patches when native mode metadata is present', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      {
        path: 'vendor/lib',
        mode: '160000',
        patch: 'diff --git a/vendor/lib b/vendor/lib\nold mode 160000\nnew mode 160000\n@@ -1,3 +1,3 @@\n context\n-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n context',
      },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files[0]).toMatchObject({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), isSubmodule: true });
  });

  it('fails closed when configured submodule origin allowlists cannot be checked', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] });
    expect(result.coverageComplete).toBe(false);
  });

  it('accepts a native gitlink when trusted checkout metadata supplies its origin', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] }, {
      baseSubmoduleUrls: { 'vendor/lib': 'https://github.com/calltelemetry/ct-pr-operator.git' },
      submoduleUrls: { 'vendor/lib': 'https://github.com/calltelemetry/ct-pr-operator.git' },
    });
    expect(result.coverageComplete).toBe(true);
  });

  it('fetches exact-ref gitmodule origins for target repositories not checked out by the action', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const gitmodules = '[submodule "proto"]\n\tpath = proto\n\turl = git@github.com:calltelemetry/proto.git\n';
    const urls = await pipeline.fetchActionSubmoduleUrlsAtRef(
      'calltelemetry/cisco-cdr',
      'a'.repeat(40),
      {
        token: 'test-token',
        fetchImplementation: async (url: string, init: any) => {
          calls.push({ url, init });
          return {
            ok: true,
            json: async () => ({
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(gitmodules).toString('base64'),
            }),
          };
        },
      },
    );

    expect(urls).toEqual({ proto: 'git@github.com:calltelemetry/proto.git' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/repos/calltelemetry/cisco-cdr/contents/.gitmodules?ref=');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');

    const result = pipeline.applyActionSubmodulePolicy([
      {
        path: 'proto',
        mode: '160000',
        oldSha: 'b'.repeat(40),
        newSha: 'c'.repeat(40),
      },
    ], {
      mode: 'metadata_only',
      require_pinned_commit: true,
      allowed_hosts: ['github.com'],
      allowed_repositories: [],
    }, {
      baseSubmoduleUrls: urls,
      submoduleUrls: urls,
    });
    expect(result.coverageComplete).toBe(true);
  });

  it('keeps a standard same-mode gitlink diff complete after exact-ref metadata resolution', async () => {
    const diff = [
      'diff --git a/proto b/proto',
      'index 5d6846bd0e..20fd8fbf7a 160000',
      '--- a/proto',
      '+++ b/proto',
      '@@ -1 +1 @@',
      '-Subproject commit 5d6846bd0ea53b003b2247b9fe21d52109af3745',
      '+Subproject commit 20fd8fbf7a2d53f97d5edfcc07387debdea62794',
    ].join('\n');
    const files = pipeline.parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'proto', mode: '160000', isSubmodule: true });
    expect(pipeline.hasActionSubmoduleCandidate(files[0])).toBe(true);

    const urls = { proto: 'git@github.com:calltelemetry/proto.git' };
    const result = pipeline.applyActionSubmodulePolicy(files, {
      mode: 'metadata_only',
      require_pinned_commit: true,
      missing_access: 'block',
      allowed_hosts: ['github.com'],
      allowed_repositories: [],
      url_change: 'block',
    }, {
      baseSubmoduleUrls: urls,
      submoduleUrls: urls,
      parentRepository: 'calltelemetry/cisco-cdr',
    });
    expect(result.coverageComplete).toBe(true);
    expect(result.files[0]).toMatchObject({
      oldSha: '5d6846bd0ea53b003b2247b9fe21d52109af3745',
      newSha: '20fd8fbf7a2d53f97d5edfcc07387debdea62794',
    });
  });

  it('detects mode-only gitlinks and ignores ordinary files as metadata fetch candidates', () => {
    expect(pipeline.hasActionSubmoduleCandidate({ path: 'vendor/new', newMode: '160000' })).toBe(true);
    expect(pipeline.hasActionSubmoduleCandidate({
      path: 'docs/submodules.md',
      patch: 'diff --git a/docs/submodules.md b/docs/submodules.md\n+ordinary documentation',
    })).toBe(false);
  });

  it('makes exact-ref target metadata authoritative over stale local checkout metadata', () => {
    expect(pipeline.mergeActionSubmoduleUrls(
      {
        proto: 'git@github.com:calltelemetry/stale-proto.git',
        retained: 'git@github.com:calltelemetry/retained.git',
      },
      { proto: 'git@github.com:calltelemetry/proto.git' },
    )).toEqual({
      proto: 'git@github.com:calltelemetry/proto.git',
      retained: 'git@github.com:calltelemetry/retained.git',
    });
  });

  it('keeps exact-ref metadata fetch failures fail-closed', async () => {
    const urls = await pipeline.fetchActionSubmoduleUrlsAtRef(
      'calltelemetry/cisco-cdr',
      'a'.repeat(40),
      { fetchImplementation: async () => ({ ok: false, status: 404 }) },
    );
    expect(urls).toEqual({});

    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'proto', mode: '160000', oldSha: 'b'.repeat(40), newSha: 'c'.repeat(40) },
    ], {
      mode: 'metadata_only',
      require_pinned_commit: true,
      allowed_hosts: ['github.com'],
      allowed_repositories: [],
    }, {
      baseSubmoduleUrls: urls,
      submoduleUrls: urls,
    });
    expect(result.coverageComplete).toBe(false);
  });

  it('parses HTTPS submodule origins with credentials and ports as URLs', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), newSubmoduleUrl: 'https://token@github.com:443/calltelemetry/ct-pr-operator.git' },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: ['calltelemetry/ct-pr-operator'] });
    expect(result.coverageComplete).toBe(true);
  });

  it('compares base and head submodule URLs and allows metadata-only origin review', () => {
    const stable = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] }, {
      baseSubmoduleUrls: { 'vendor/lib': 'https://github.com/calltelemetry/ct-pr-operator.git' },
      submoduleUrls: { 'vendor/lib': 'https://github.com/calltelemetry/ct-pr-operator.git' },
    });
    expect(stable.coverageComplete).toBe(true);

    const reviewOnly = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, missing_access: 'metadata_only', allowed_hosts: ['github.com'], allowed_repositories: [] });
    expect(reviewOnly.coverageComplete).toBe(true);
  });

  it('keeps URL changes reviewable when policy requests metadata review', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), oldSubmoduleUrl: 'https://github.com/calltelemetry/old.git', newSubmoduleUrl: 'https://github.com/calltelemetry/new.git' },
    ], { mode: 'metadata_only', require_pinned_commit: true, url_change: 'review' });
    expect(result.coverageComplete).toBe(true);
  });

  it('detects native gitlink mode metadata when the patch is absent', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      {
        path: 'vendor/lib',
        status: 'modified',
        mode: '160000',
        oldSha: 'a'.repeat(40),
        newSha: 'b'.repeat(40),
      },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files[0]).toMatchObject({ isSubmodule: true, mode: '160000' });
  });

  it('accepts native gitlink additions and deletions with only their existing-side SHA', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/added', status: 'added', mode: '160000', newSha: 'a'.repeat(40) },
      { path: 'vendor/deleted', status: 'deleted', mode: '160000', oldSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file: any) => file.isSubmodule)).toBe(true);
  });

  it('exports the canonical arbitration helper used by the Action entrypoint', () => {
    expect(pipeline.computeArbitrationQuorum).toBeTypeOf('function');
    expect(pipeline.computeArbitrationQuorum([{ findings: [] }], 1).verdict).toBe('SHIP');
  });
});
