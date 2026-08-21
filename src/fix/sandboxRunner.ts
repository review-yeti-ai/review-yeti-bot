export interface SandboxCommandResult {
  command: string;
  exitStatus: number | 'timeout' | 'error';
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; maxBytes?: number }): Promise<SandboxCommandResult>;
}

// Keep sandboxed commands independent from credentials and provider configuration
// inherited by the review worker. These path-only variables support executable
// lookup, temporary files, and the cache/runtime conventions used by CI tools.
const SANDBOX_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOME',
  'USERPROFILE',
  'XDG_RUNTIME_DIR',
] as const;

function createSandboxEnvironment(): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {
    CI: '1',
    CT_REVIEW_SANDBOX: '1',
  };
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  // Next's ambient ProcessEnv type requires NODE_ENV even though it is not
  // required by child_process and must not be added to this allowlist.
  return environment as NodeJS.ProcessEnv;
}

function terminateProcessGroup(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

function appendOutput(current: string, chunk: Buffer, maxBytes: number): string {
  if (current.length >= maxBytes) return current;
  return `${current}${chunk.toString('utf8').slice(0, Math.max(0, maxBytes - current.length))}`;
}

export class ProcessSandboxRunner implements SandboxRunner {
  async run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<SandboxCommandResult> {
    const { spawn } = await import('node:child_process');
    const maxBytes = options.maxBytes ?? 100_000;
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise((resolve) => {
      const child: any = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        env: createSandboxEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const finish = (exitStatus: number | 'timeout' | 'error'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ command, exitStatus, stdout, stderr });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 250);
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { stdout = appendOutput(stdout, chunk, maxBytes); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = appendOutput(stderr, chunk, maxBytes); });
      child.on('close', (code: number | null) => finish(timedOut ? 'timeout' : (code ?? 1)));
      child.on('error', () => finish('error'));
    });
  }
}
