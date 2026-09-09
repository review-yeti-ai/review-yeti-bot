import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const { materializeReviewWorkdir } = require('../../src/mcp/zoektWorkdirMaterializer.js');

// Builds a real gzip tar archive (via the system `tar` binary, same tool the
// module itself shells out to for extraction) shaped like a real GitHub
// tarball: everything nested one level under a single top-level directory,
// exactly what --strip-components=1 is written to undo.
function buildFixtureTarball() {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-fixture-'));
  const topLevel = 'review-yeti-ai-review-yeti-bot-abc1234';
  const repoDir = path.join(stageDir, topLevel);
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'example.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  const archivePath = path.join(stageDir, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', stageDir, topLevel]);
  return { archivePath, stageDir };
}

function fakeFetchReturning(archivePath, { ok = true, status = 200, headers = {} } = {}) {
  return vi.fn(async () => {
    const buffer = fs.readFileSync(archivePath);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
    return {
      ok,
      status,
      body,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    };
  });
}

describe('materializeReviewWorkdir', () => {
  it('rejects a malformed repository or non-SHA headSha before ever calling fetch', async () => {
    const fetchImplementation = vi.fn();
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: '../not-a-repo',
      headSha: 'not-a-sha',
      token: 'gh-token',
      destDir,
      fetchImplementation,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('invalid_identity');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('fails soft when no token is supplied, without calling fetch', async () => {
    const fetchImplementation = vi.fn();
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: '',
      destDir,
      fetchImplementation,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('missing_token');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a non-github.com API base URL', async () => {
    const fetchImplementation = vi.fn();
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      apiBaseUrl: 'https://attacker.example.com',
      fetchImplementation,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('api_base_url_not_allowlisted');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('fails soft when the tarball fetch throws', async () => {
    const fetchImplementation = vi.fn(async () => { throw new Error('network down'); });
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      fetchImplementation,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('tarball_fetch_failed');
  });

  it('fails soft on a non-2xx response', async () => {
    const fetchImplementation = vi.fn(async () => ({ ok: false, status: 404, body: null, headers: { get: () => null } }));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      fetchImplementation,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('tarball_fetch_failed');
  });

  it('fails soft and stops streaming once the archive exceeds maxBytes', async () => {
    const { archivePath } = buildFixtureTarball();
    const fetchImplementation = fakeFetchReturning(archivePath);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      fetchImplementation,
      config: { maxBytes: 10 },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('archive_too_large');
  });

  it('fails soft when the tar binary is missing (ENOENT), exercised against the real spawn path', async () => {
    const { archivePath } = buildFixtureTarball();
    const fetchImplementation = fakeFetchReturning(archivePath);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      fetchImplementation,
      tarBinaryPath: '/definitely/not/a/real/tar-binary',
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('tar_binary_missing');
  });

  it('extracts a real tarball into destDir, stripping the top-level GitHub archive directory', async () => {
    const { archivePath } = buildFixtureTarball();
    const fetchImplementation = fakeFetchReturning(archivePath);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'gh-token',
      destDir,
      fetchImplementation,
    });
    expect(result.status).toBe('ok');
    expect(result.workdir).toBe(destDir);
    expect(fs.readFileSync(path.join(destDir, 'src', 'example.js'), 'utf8')).toContain('module.exports');
    expect(fs.existsSync(path.join(destDir, 'README.md'))).toBe(true);
    // The GitHub-archive top-level directory must not survive extraction.
    expect(fs.existsSync(path.join(destDir, 'review-yeti-ai-review-yeti-bot-abc1234'))).toBe(false);
  });

  it('never forwards the token or a credential-shaped value into the tar child process argv', async () => {
    const { archivePath } = buildFixtureTarball();
    const fetchImplementation = fakeFetchReturning(archivePath);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-materializer-dest-'));
    const capturedArgsPath = path.join(destDir, '..', `captured-args-${path.basename(destDir)}.txt`);
    const wrapperPath = path.join(destDir, '..', `capture-tar-${path.basename(destDir)}.sh`);
    fs.writeFileSync(wrapperPath, `#!/bin/sh\necho "$@" > "${capturedArgsPath}"\n/usr/bin/tar "$@"\n`);
    fs.chmodSync(wrapperPath, 0o755);
    const result = await materializeReviewWorkdir({
      repository: 'review-yeti-ai/review-yeti-bot',
      headSha: 'a'.repeat(40),
      token: 'super-secret-token-value',
      destDir,
      fetchImplementation,
      tarBinaryPath: wrapperPath,
    });
    expect(result.status).toBe('ok');
    const captured = fs.readFileSync(capturedArgsPath, 'utf8');
    expect(captured).not.toContain('super-secret-token-value');
  });
});
