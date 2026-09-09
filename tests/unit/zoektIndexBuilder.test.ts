import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { buildZoektIndex } = require('../../src/mcp/zoektIndexBuilder.js');

describe('buildZoektIndex', () => {
  it('fails soft when the working tree does not exist', async () => {
    const result = await buildZoektIndex({ workdir: '/definitely/not/a/real/path', indexDir: '/tmp/whatever' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('workdir_missing');
  });

  it('fails soft when zoekt-index is missing (ENOENT), exercised against the real spawn path', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-workdir-'));
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-index-'));
    const result = await buildZoektIndex({
      workdir,
      indexDir,
      config: { zoektIndexBinaryPath: '/definitely/not/a/real/zoekt-index-binary' },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('zoekt_index_binary_missing');
  });

  it('bounds parallelism, file_limit, and shard_limit to the configured maxima', async () => {
    const { resolveBuildConfig } = require('../../src/mcp/zoektIndexBuilder.js');
    const resolved = resolveBuildConfig({ parallelism: 999, fileLimitBytes: 999_999_999, shardLimitBytes: 999_999_999_999, timeoutMs: 999_999_999 });
    expect(resolved.parallelism).toBeLessThanOrEqual(4);
    expect(resolved.fileLimitBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(resolved.shardLimitBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(resolved.timeoutMs).toBeLessThanOrEqual(180_000);
  });

  it('never passes a network-related flag or credential to the child process', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-workdir-'));
    fs.writeFileSync(path.join(workdir, 'sample.txt'), 'hello world\n');
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-index-'));
    // Real ENOENT run (no fake binary available) just to prove the module
    // builds only a fixed, bounded argv -- inspected via a wrapper script.
    const wrapperPath = path.join(indexDir, 'capture-args.sh');
    const capturedArgsPath = path.join(indexDir, 'captured-args.txt');
    fs.writeFileSync(wrapperPath, `#!/bin/sh\necho "$@" > "${capturedArgsPath}"\nexit 0\n`);
    fs.chmodSync(wrapperPath, 0o755);
    const result = await buildZoektIndex({ workdir, indexDir, config: { zoektIndexBinaryPath: wrapperPath } });
    expect(result.status).toBe('ok');
    const captured = fs.readFileSync(capturedArgsPath, 'utf8');
    expect(captured).not.toMatch(/https?:\/\//);
    expect(captured).not.toMatch(/--?token/i);
    expect(captured).not.toMatch(/--?password/i);
    expect(captured).toContain('-index');
    expect(captured).toContain(indexDir);
    expect(captured).toContain(workdir);
  });
});
