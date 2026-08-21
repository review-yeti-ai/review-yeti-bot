import { createEvidenceReceipt, EvidenceReceipt } from './evidence';

export interface CommandResult {
  exitStatus: number | 'timeout' | 'error';
  stdout: string;
  stderr?: string;
}

export type EvidenceCommandRunner = (command: string, args: string[], options: { timeoutMs: number; maxBytes: number }) => Promise<CommandResult>;

export interface EvidenceRunOptions {
  tool: string;
  version: string;
  operation: string;
  snapshotSha: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  interpret?: (result: CommandResult) => string;
  runCommand?: EvidenceCommandRunner;
}

async function defaultRunner(command: string, args: string[], options: { timeoutMs: number; maxBytes: number }): Promise<CommandResult> {
  const { spawn } = await import('node:child_process');
  const { StringDecoder } = await import('node:string_decoder');
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') child.kill('SIGTERM');
      else {
        try { process.kill(-child.pid!, 'SIGTERM'); } catch (_) { child.kill('SIGTERM'); }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        }, 250);
      }
    }, options.timeoutMs);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const decoded = decoders[target].write(chunk);
      const current = target === 'stdout' ? stdout : stderr;
      const next = `${current}${decoded}`;
      const bounded = Buffer.byteLength(next, 'utf8') <= options.maxBytes
        ? next
        : Buffer.from(next, 'utf8').subarray(0, options.maxBytes).toString('utf8');
      if (target === 'stdout') stdout = bounded;
      else stderr = bounded;
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        stdout += decoders.stdout.end();
        stderr += decoders.stderr.end();
      }
      resolve({ exitStatus: timedOut ? 'timeout' : (code ?? 1), stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitStatus: 'error', stdout, stderr });
    });
  });
}

export async function runEvidence(options: EvidenceRunOptions): Promise<EvidenceReceipt> {
  const started = Date.now();
  const result = await (options.runCommand || defaultRunner)(options.command, options.args || [], {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxBytes: options.maxBytes ?? 100_000,
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`;
  return createEvidenceReceipt({
    tool: options.tool,
    version: options.version,
    operation: options.operation,
    snapshotSha: options.snapshotSha,
    exitStatus: result.exitStatus,
    durationMs: Date.now() - started,
    interpretation: options.interpret ? options.interpret(result) : result.exitStatus === 0 ? 'command passed' : 'command failed',
    output,
  });
}
