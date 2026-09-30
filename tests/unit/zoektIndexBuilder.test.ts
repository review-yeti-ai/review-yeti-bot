import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { buildZoektIndex } = require('../../src/mcp/zoektIndexBuilder.js');

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filePath)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

  it('kills and joins an in-flight index process when the lifecycle signal aborts', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-cancel-workdir-'));
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekt-builder-cancel-index-'));
    const startedPath = path.join(indexDir, '.index-started');
    const wrapperPath = path.join(indexDir, 'stalling-zoekt-index.js');
    fs.writeFileSync(wrapperPath, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `fs.writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));`,
      'setInterval(() => fs.writeFileSync(path.join(process.cwd(), ".index-heartbeat"), String(Date.now())), 10);',
      'setTimeout(() => process.exit(0), 500);',
      '',
    ].join('\n'));
    fs.chmodSync(wrapperPath, 0o755);
    const controller = new AbortController();
    const pending = buildZoektIndex({
      workdir,
      indexDir,
      signal: controller.signal,
      config: { zoektIndexBinaryPath: wrapperPath, timeoutMs: 1_000 },
    });
    let pid: number | undefined;
    try {
      await waitForFile(startedPath);
      pid = Number(fs.readFileSync(startedPath, 'utf8'));
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
      expect(processIsAlive(pid)).toBe(false);
      // Pre-abort writes are allowed; joined cancellation must prevent later writes.
      const heartbeatPath = path.join(indexDir, '.index-heartbeat');
      const heartbeat = () => fs.existsSync(heartbeatPath) ? fs.readFileSync(heartbeatPath, 'utf8') : null;
      const afterJoin = heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(heartbeat()).toBe(afterJoin);
    } finally {
      controller.abort();
      if (pid && processIsAlive(pid)) process.kill(pid, 'SIGKILL');
      await pending.catch(() => undefined);
      fs.rmSync(workdir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  });
});
