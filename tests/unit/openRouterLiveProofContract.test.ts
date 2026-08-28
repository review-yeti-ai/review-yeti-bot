import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/openrouter-live-proof.yml');
const scriptPath = path.join(root, 'scripts/openrouter-live-proof.cjs');

describe('manual OpenRouter live proof contract', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('is manual-only, evidence-only, and bounded to fifteen minutes', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('timeout-minutes: 15');
    expect(workflow).not.toMatch(/^\s*schedule:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*pull_request:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*repository_dispatch:\s*$/mu);
    expect(workflow).not.toMatch(/gh\s+pr\s+(comment|review)/u);
    expect(workflow).toContain('timeout --signal=TERM --kill-after=15s 10m');
  });

  it('uses one explicit OpenRouter transport and writes a sanitized receipt', () => {
    expect(script).toContain("publication: 'none'");
    expect(script).toContain("failover: 'disabled'");
    expect(script).toContain("schedule: 'manual-only'");
    expect(script).toContain("provider: 'openrouter'");
    expect(script).toContain("stream: true");
    expect(script).toContain('transports: [{');
    expect(script).toContain('maxOutputTokens: 24_576');
    expect(script).toContain('mode: 0o600');
    expect(script).not.toContain('process.env.GITHUB_TOKEN');
  });
});
