import { describe, expect, it } from 'vitest';

const { runDoctor } = require('../../src/cli/doctor.js');

describe('reviewyeti doctor', () => {
  it('reports credential presence without exposing credential values', async () => {
    const receipt = await runDoctor({ env: { OPENROUTER_API_KEY: 'sk-secret', GITHUB_TOKEN: 'gh-secret' }, cwd: process.cwd() });
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openrouter-credential', status: 'ok', source: 'OPENROUTER_API_KEY' }),
      expect.objectContaining({ id: 'github-credential', status: 'ok', source: 'GITHUB_TOKEN' }),
    ]));
    expect(JSON.stringify(receipt)).not.toContain('sk-secret');
    expect(JSON.stringify(receipt)).not.toContain('gh-secret');
  });
});
