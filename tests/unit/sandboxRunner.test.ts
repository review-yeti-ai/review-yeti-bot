import { describe, expect, it, vi } from 'vitest';
import { ProcessSandboxRunner } from '../../src/fix/sandboxRunner';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  childProcessMock.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: childProcessMock.spawn };
});

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit after its parent timed out`);
}

describe('ProcessSandboxRunner', () => {
  it('does not pass host secrets or non-allowlisted environment variables to commands', async () => {
    const sentinelName = 'CT_REVIEW_SANDBOX_TEST_SECRET';
    const sentinelValue = 'sentinel-host-secret';
    const originalSentinel = process.env[sentinelName];
    process.env[sentinelName] = sentinelValue;
    childProcessMock.spawn.mockClear();

    try {
      const runner = new ProcessSandboxRunner();
      const result = await runner.run(process.execPath, ['-e', 'process.exit(0)']);

      expect(result.exitStatus).toBe(0);
      const spawnOptions = childProcessMock.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toMatchObject({ PATH: process.env.PATH || '', CI: '1', CT_REVIEW_SANDBOX: '1' });
      expect(spawnOptions.env).not.toHaveProperty(sentinelName);
      expect(Object.keys(spawnOptions.env ?? {}).every((key) => [
        'PATH',
        'CI',
        'CT_REVIEW_SANDBOX',
        'TMPDIR',
        'TMP',
        'TEMP',
        'HOME',
        'USERPROFILE',
        'XDG_RUNTIME_DIR',
      ].includes(key))).toBe(true);
    } finally {
      if (originalSentinel === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = originalSentinel;
    }
  });

  it('terminates descendants when a command times out', async () => {
    const runner = new ProcessSandboxRunner();
    const result = await runner.run(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'process.stdout.write(String(descendant.pid));',
        'setInterval(() => {}, 1000);',
      ].join(' '),
    ], { timeoutMs: 500 });

    expect(result.exitStatus).toBe('timeout');
    const descendantPid = Number(result.stdout);
    expect(descendantPid).toBeGreaterThan(0);
    await waitForProcessExit(descendantPid);
  }, 5_000);
});
