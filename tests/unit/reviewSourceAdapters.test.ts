import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { selectSource, resolveReviewSource } = require('../../src/cli/reviewSourceAdapters.js');

describe('immutable review source adapters', () => {
  it('requires exactly one source mode', () => {
    expect(() => selectSource({ base: 'a'.repeat(40), head: 'b'.repeat(40), diffFile: 'change.diff' })).toThrow(/exactly one source mode/);
  });

  it('rejects symbolic refs', async () => {
    await expect(resolveReviewSource({ kind: 'refs', base: 'main', head: 'HEAD' }, {
      commandRunner: () => ({ status: 0, stdout: 'owner/repo', stderr: '' }),
    })).rejects.toThrow(/full commit SHA/);
  });

  it('reads and hashes a bounded diff file with synthetic immutable identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-source-'));
    const filePath = path.join(directory, 'change.diff');
    fs.writeFileSync(filePath, 'diff --git a/src/a.js b/src/a.js\n+safe\n');
    const source = await resolveReviewSource({ kind: 'diff-file', path: filePath }, { cwd: directory, repository: 'owner/repo' });
    expect(source).toMatchObject({ kind: 'diff-file', repository: 'owner/repo', prNumber: 1 });
    expect(source.baseSha).toMatch(/^[a-f0-9]{64}$/);
    expect(source.headSha).toMatch(/^[a-f0-9]{64}$/);
    expect(source.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds pull request metadata and rereads the exact head', async () => {
    const calls: string[] = [];
    const fetchImplementation = async (url: string, options: any = {}) => {
      calls.push(url);
      if (url.includes('/files?')) return { ok: true, status: 200, json: async () => [{ filename: 'src/a.js', status: 'modified' }] };
      if (url.endsWith('/pulls/31') && !String(options.headers?.accept || '').includes('diff')) return { ok: true, status: 200, json: async () => ({ title: 'test', base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } }) };
      return { ok: true, status: 200, text: async () => 'diff --git a/src/a.js b/src/a.js\n' };
    };
    const source = await resolveReviewSource({ kind: 'pull-request', value: 'owner/repo#31' }, { token: 'test-token', fetchImplementation });
    expect(source).toMatchObject({ kind: 'pull-request', repository: 'owner/repo', prNumber: 31, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
    expect(source.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.some((url) => url.includes('/files?'))).toBe(true);
  });
});
