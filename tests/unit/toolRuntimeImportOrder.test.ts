import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolRuntimeResult } from '../../src/panel/toolRuntime';

describe('CommonJS source-read batch initialization', () => {
  it.each(['engine-first', 'runtime-first'])('enforces the payload cap with %s imports', (order) => {
    // Use Node's actual CommonJS loader, not Vitest's module graph. An eager value read
    // across the engine/runtime cycle can otherwise pass tests but become undefined in a worker.
    const script = `
      (async () => {
        if (process.argv[1] === 'engine-first') require('./src/panel/panelEngine.ts');
        const { runReadOnlyTool } = require('./src/panel/toolRuntime.ts');
        let reads = 0;
        const result = await runReadOnlyTool('read_files', {
          files: Array.from({ length: 8 }, (_, index) => ({ path: 'src/native-' + index + '.ts' })),
        }, {
          changedFiles: [],
          repoFileProvider: {
            readFile: async () => { reads++; return '🧪'.repeat(200000); },
            findFiles: async () => [],
          },
        });
        process.stdout.write(JSON.stringify({
          bytes: Buffer.byteLength(result.toolOutput, 'utf8'), reads,
          isExhaustive: result.isExhaustive,
          truncated: result.toolOutput.includes('BATCH TRUNCATED'),
        }) + '\\n', () => process.exit(0));
      })().catch(() => process.exit(1));
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, order], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'test', TS_NODE_PROJECT: 'tsconfig.server.json' },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024,
    });
    const observed = JSON.parse(output.trim().split('\n').at(-1)!) as {
      bytes: number; reads: number; isExhaustive: ToolRuntimeResult['isExhaustive']; truncated: boolean;
    };
    expect(observed.bytes).toBeLessThanOrEqual(512 * 1024);
    expect(observed.reads).toBe(1);
    expect(observed.isExhaustive).toBe(false);
    expect(observed.truncated).toBe(true);
  }, 30_000);
});
