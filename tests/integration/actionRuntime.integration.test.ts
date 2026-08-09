import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('plain Node Action runtime', () => {
  it('loads all built-in providers without TypeScript runtime dependencies', () => {
    const script = path.resolve(__dirname, '../../scripts/check-action-runtime.mjs');
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({
      providers: ['honcho', 'mem0', 'hindsight', 'supermemory', 'retaindb'],
      pipelineExports: true,
      loadedTypescript: false,
    });
  });
});
