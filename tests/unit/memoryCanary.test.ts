import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('memory canary credential boundary', () => {
  it('reports missing provider access without attempting a network call', () => {
    const script = path.resolve(__dirname, '../../scripts/memory-canary.mjs');
    const output = execFileSync(process.execPath, [script, '--provider', 'mem0', '--allow-missing'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_PATH: '', MEM0_URL: '', MEM0_API_KEY: '' },
    });
    expect(JSON.parse(output)).toMatchObject({ provider: 'mem0', status: 'not_configured', configured: false });
  });
});
